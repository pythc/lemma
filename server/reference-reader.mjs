import { NETWORK_RUNTIME, CONTEXT_RUNTIME } from "./runtime-limits.mjs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, request } from "undici";
import { sha256 } from "./evidence.mjs";
import { extractInWorker } from "./pipeline.mjs";
import { referencePool } from "./resource-pool.mjs";

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  // Public IPv6 global unicast only; exclude transition and mapped addresses.
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^(2001:0:|2001:db8:|2002:)/i.test(address)
  );
}
export function publicDocument(url, options = {}) {
  return referencePool.run(() => publicDocumentReserved(url, options), options);
}
// Undici emits UND_ERR_ABORTED asynchronously when an unread body is destroyed.
// Consume only that intentional disposal path; normal read failures still reject
// their async iterator and are recorded as a failed reference retrieval.
export function discardReferenceBody(body) {
  body.on("error", () => {});
  body.destroy();
}
async function publicDocumentReserved(
  urlValue,
  { signal, maxBytes = 20 * 1024 * 1024 } = {},
) {
  let current = urlValue;
  const visited = [];
  for (let hop = 0; hop < 5; hop++) {
    const url = new URL(current);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.port && !["80", "443"].includes(url.port))
    )
      throw Error("文献地址必须是无凭据的公开 HTTP(S) 地址。");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true });
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      throw Error("文献地址指向非公开网络，未访问。");
    // Pin validated DNS results for the actual connection, including redirects.
    const dispatcher = new Agent({
      connect: {
        lookup: (hostname, options, callback) => {
          if (hostname !== host) return callback(Error("文献连接主机变化。"));
          return options.all
            ? callback(null, addresses)
            : callback(null, addresses[0].address, addresses[0].family);
        },
      },
    });
    try {
      const response = await request(url, {
        dispatcher,
        signal: AbortSignal.any([
          signal || new AbortController().signal,
          AbortSignal.timeout(NETWORK_RUNTIME.referenceTimeoutMs),
        ]),
        method: "GET",
        headers: {
          "User-Agent": "Lemma-Research-Reader/0.10",
          Accept: "application/pdf,application/json,text/html,text/plain",
        },
        maxRedirections: 0,
        headersTimeout: NETWORK_RUNTIME.referenceTimeoutMs,
        bodyTimeout: NETWORK_RUNTIME.referenceTimeoutMs,
      });
      visited.push({ url: url.href, status: response.statusCode });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        discardReferenceBody(response.body);
        if (!location) throw Error("文献重定向缺少位置。");
        current = new URL(location, url).href;
        continue;
      }
      if (response.statusCode !== 200) {
        const referenceFailure = {
          url: url.href,
          status: response.statusCode,
          retryAfter: String(response.headers["retry-after"] || "").slice(
            0,
            200,
          ),
          location: String(response.headers.location || "").slice(0, 3000),
        };
        discardReferenceBody(response.body);
        const error = Error(
          `文献返回 HTTP ${response.statusCode}，未获得全文。`,
        );
        error.code = "reference_http_status";
        error.referenceFailure = referenceFailure;
        throw error;
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          discardReferenceBody(response.body);
          throw Error("文献超过本次获取预算。");
        }
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      return {
        url: url.href,
        visited,
        buffer,
        sha256: sha256(buffer),
        contentType: String(response.headers["content-type"] || ""),
        retrievedAt: new Date().toISOString(),
      };
    } finally {
      await dispatcher.close();
    }
  }
  throw Error("文献重定向次数超限。");
}
export function paperUrls(source) {
  return [
    ...new Set(
      source.pages
        .flatMap((p) => p.text.match(/https?:\/\/[^\s<>"\]]+/g) || [])
        .map((s) => s.replace(/[).,;]+$/, "")),
    ),
  ].slice(0, 80);
}
export async function retrieveReference(
  { url, query },
  source,
  previous = [],
  {
    signal,
    fetchDocument = publicDocument,
    extract = extractInWorker,
    allowDiscoveredUrl = false,
  } = {},
) {
  if (!url) {
    if (typeof query !== "string" || !query.trim() || query.length > 500)
      throw Error("引用检索需要明确的文献题名或书目信息。");
    const endpoint = new URL("https://api.crossref.org/works");
    endpoint.searchParams.set("query.bibliographic", query);
    endpoint.searchParams.set("rows", "3");
    const result = await fetchDocument(endpoint.href, {
      signal,
      maxBytes: 1000000,
    });
    const data = JSON.parse(result.buffer.toString("utf8"));
    const candidates = (data.message?.items || []).map((item) => ({
      title: (item.title || []).join(" "),
      doi: item.DOI || null,
      authors: (item.author || []).map((a) =>
        [a.given, a.family].filter(Boolean).join(" "),
      ),
      year: item.issued?.["date-parts"]?.[0]?.[0] || null,
      urls: [
        ...new Set(
          [item.URL, ...(item.link || []).map((l) => l.URL)].filter(
            (v) => typeof v === "string",
          ),
        ),
      ],
    }));
    return {
      summary: "已检索书目候选；尚未取得全文，需核对作者、题名和版本。",
      status: "metadata_only",
      query,
      candidates,
      sourceUrl: result.url,
      responseSha256: result.sha256,
      retrievedAt: result.retrievedAt,
      externalReferencesVerified: false,
    };
  }
  const allowed = [
    ...paperUrls(source),
    ...previous.flatMap((p) => p.candidates?.flatMap((c) => c.urls) || []),
  ];
  if (!allowed.includes(url) && !allowDiscoveredUrl)
    throw Error("文献地址未出现在论文或已取得的书目候选中。");
  const result = await fetchDocument(url, { signal });
  const id = sha256(Buffer.from(result.url + "\n" + result.sha256));
  if (result.buffer.subarray(0, 5).toString() === "%PDF-") {
    const paper = await extract(result.buffer.toString("base64"), null, signal);
    return {
      id,
      status: "text_obtained",
      summary: `已取得外部 PDF 的 ${paper.pageCount} 页提取文本，引用适用性尚待核查。`,
      url: result.url,
      redirects: result.visited,
      sha256: result.sha256,
      retrievedAt: result.retrievedAt,
      pdfBase64: result.buffer.toString("base64"),
      pages: paper.pages,
      pageCount: paper.pageCount,
      externalReferencesVerified: false,
    };
  }
  const raw = result.buffer.toString("utf8");
  const content = result.contentType.includes("html")
    ? raw
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
    : raw;
  return {
    id,
    status: "page_obtained",
    summary: "已取得文献网页；网页可能仅含摘要，不代表完整论文。",
    url: result.url,
    redirects: result.visited,
    sha256: result.sha256,
    retrievedAt: result.retrievedAt,
    rawBase64: result.buffer.toString("base64"),
    pages: [{ index: 0, text: content.slice(0, CONTEXT_RUNTIME.characters) }],
    truncated: content.length > CONTEXT_RUNTIME.characters,
    externalReferencesVerified: false,
  };
}
