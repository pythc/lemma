import { streamArtifact } from "./evidence-raw.mjs";
import path from "node:path";
import { createHash } from "node:crypto";
import { syncDirectory } from "./durable-files.mjs";
import { createReadStream } from "node:fs";
import { open, rename, rm, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:buffer";
import { isHash, inspectBundle } from "./evidence.mjs";
import { EVIDENCE_RUNTIME } from "./runtime-limits.mjs";

// Each immutable artifact already fits in a string. The entire ancestry may not.
export { walkEvidence as evidenceArtifacts } from "./evidence-stream.mjs";
import { walkEvidence as evidenceArtifacts } from "./evidence-stream.mjs";

export async function* evidenceChunks(store, root, format = "ndjson") {
  if (!isHash(root)) throw Error("无效证据根。");
  if (!["json", "ndjson"].includes(format)) throw Error("不支持的证据格式。");
  // Validate before a response header or output file is committed.
  await streamArtifact(
    path.join(store.root, "artifacts", root + ".json"),
    root,
  );
  yield JSON.stringify({
    schemaVersion:
      format === "ndjson" ? "lemma.evidence-stream.v1" : "lemma.evidence.v1",
    root,
  }).slice(0, -1) + (format === "ndjson" ? "}\n" : ',"artifacts":[');
  let first = true;
  for await (const a of evidenceArtifacts(store, root, {
    metadataOnly: true,
  })) {
    yield (format === "json" && !first ? "," : "") +
      '{"id":' +
      JSON.stringify(a.id) +
      ",";
    const hash = createHash("sha256");
    let skip = true;
    for await (const chunk of createReadStream(
      path.join(store.root, "artifacts", a.id + ".json"),
    )) {
      hash.update(chunk);
      yield skip ? chunk.subarray(1) : chunk;
      skip = false;
    }
    if (hash.digest("hex") !== a.id)
      throw Error("Artifact changed while streaming");
    if (format === "ndjson") yield "\n";
    first = false;
  }
  if (format === "json") yield "]}";
}

export async function writeEvidenceFile(file, store, root, format = "ndjson") {
  const temp = `${file}.${randomUUID()}.tmp`;
  const output = await open(temp, "wx", 0o600);
  try {
    for await (const chunk of evidenceChunks(store, root, format))
      await output.writeFile(chunk, "utf8");
    await output.sync();
    await output.close();
    await rename(temp, file);
    await syncDirectory(path.dirname(file));
  } catch (e) {
    await output.close().catch(() => {});
    await rm(temp, { force: true });
    throw e;
  }
}

async function* boundedLines(file) {
  const input = createReadStream(file, { encoding: "utf8" });
  let pending = "",
    bytes = 0,
    total = 0;
  try {
    for await (const chunk of input) {
      total += Buffer.byteLength(chunk);
      if (total > EVIDENCE_RUNTIME.streamReplayBytes)
        throw Error("证据包超过重放预算。");
      const parts = chunk.split("\n");
      for (let i = 0; i < parts.length; i++) {
        bytes += Buffer.byteLength(parts[i]);
        if (bytes > EVIDENCE_RUNTIME.replayBytes)
          throw Error("单条证据超过重放预算。");
        pending += parts[i];
        if (i < parts.length - 1) {
          yield pending;
          pending = "";
          bytes = 0;
        }
      }
    }
    if (pending) yield pending;
  } finally {
    input.destroy();
  }
}

export async function readEvidenceFile(file) {
  const size = (await stat(file)).size;
  if (size > EVIDENCE_RUNTIME.streamReplayBytes)
    throw Error("证据包超过重放预算。");
  const handle = await open(file, "r");
  let prefix;
  try {
    const b = Buffer.alloc(512);
    const { bytesRead } = await handle.read(b, 0, b.length, 0);
    prefix = b.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  let header = null;
  try {
    header = JSON.parse(prefix.split("\n")[0]);
  } catch {}
  if (header?.schemaVersion !== "lemma.evidence-stream.v1") {
    if (
      size > EVIDENCE_RUNTIME.replayBytes ||
      size > constants.MAX_STRING_LENGTH
    )
      throw Error("大型证据请重新导出为 NDJSON 流式格式。");
    return JSON.parse(await readFile(file, "utf8"));
  }
  if (!isHash(header.root)) throw Error("无效证据根。");
  const values = [];
  let first = true;
  for await (const line of boundedLines(file)) {
    if (first) {
      first = false;
      continue;
    }
    if (!line.trim()) continue;
    if (values.length >= EVIDENCE_RUNTIME.artifacts)
      throw Error("证据图超过重放预算。");
    values.push(JSON.parse(line));
  }
  const bundle = {
    schemaVersion: "lemma.evidence.v1",
    root: header.root,
    artifacts: values,
  };
  inspectBundle(bundle, header.root);
  return bundle;
}

function drain(response) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", ready);
      response.off("close", closed);
      response.off("error", failed);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(Error("证据下载已取消。"));
    };
    const failed = (e) => {
      cleanup();
      reject(e);
    };
    response.once("drain", ready);
    response.once("close", closed);
    response.once("error", failed);
  });
}

export async function sendEvidence(
  response,
  store,
  root,
  { format = "json", fileName = "lemma-evidence" } = {},
) {
  const chunks = evidenceChunks(store, root, format);
  const first = await chunks.next();
  response.writeHead(200, {
    "Content-Type":
      format === "ndjson"
        ? "application/x-ndjson; charset=utf-8"
        : "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${fileName}.${format === "ndjson" ? "ndjson" : "json"}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  try {
    if (!response.write(first.value)) await drain(response);
    for await (const chunk of chunks) {
      if (response.destroyed) throw Error("证据下载已取消。");
      if (!response.write(chunk)) await drain(response);
    }
    response.end();
  } catch (e) {
    response.destroy();
    throw e;
  } finally {
    await chunks.return();
  }
}
