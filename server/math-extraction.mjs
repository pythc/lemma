import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { contentTree } from "./toolchain-tree.mjs";
import { digest, sha256 } from "./evidence.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));

export async function documentParserEnabled(
  projectRoot = root,
  env = process.env,
) {
  let value = env.LEMMA_DOCUMENT_PARSER;
  if (value === undefined) {
    const file = await readFile(
      path.join(projectRoot, ".env.local"),
      "utf8",
    ).catch((e) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
    value = file
      .match(/^\s*LEMMA_DOCUMENT_PARSER\s*=\s*(.*?)\s*$/m)?.[1]
      ?.replace(/^["']|["']$/g, "");
  }
  if (value && value !== "docling")
    throw Error("LEMMA_DOCUMENT_PARSER 仅支持 docling 或留空。");
  return value === "docling";
}

export function pageGeometry(
  base64,
  pageIndex,
  { signal, visibility = false, geometryVersion } = {},
) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(new URL("./pdf-worker.mjs", import.meta.url), {
      workerData: {
        base64,
        pageIndex,
        geometry: true,
        visibility,
        geometryVersion,
      },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(Error("数学页图解析已取消。"));
    const timer = setTimeout(
      () => finish(Error("数学页图解析超过 30 秒预算。")),
      30_000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", (r) => {
      if (r.type === "lemma.pdf.result.v1")
        finish(r.ok ? null : Error(r.error), r.value);
    });
    worker.once("error", (e) => finish(e));
    worker.once("exit", () => {
      if (!done) finish(Error("数学页图解析提前结束。"));
    });
  });
}

export async function verifyDocumentModels(
  modelRoot = path.join(root, ".tools/document-models"),
) {
  const receipt = JSON.parse(
    await readFile(path.join(modelRoot, "receipt.json"), "utf8"),
  );
  const pins = JSON.parse(
    await readFile(path.join(root, "worker/document-models.json"), "utf8"),
  );
  if (
    digest(
      receipt.models.map(({ repository, revision, license }) => ({
        repository,
        revision,
        license,
      })),
    ) !== digest(pins.models)
  )
    throw Error("文档模型版本与固定清单不一致。");
  const files = receipt.models.flatMap((m) => m.files);
  const canonical = await realpath(modelRoot);
  for (const f of files)
    if (
      !f.path ||
      path.isAbsolute(f.path) ||
      path.normalize(f.path) !== f.path ||
      f.path.startsWith("..") ||
      (await realpath(path.join(modelRoot, f.path))) !==
        path.join(canonical, f.path)
    )
      throw Error("文档模型清单路径无效。");
  const actual = await contentTree(
    modelRoot,
    files.map((f) => f.path),
    { includeFiles: true },
  );
  if (
    digest(actual.files) !==
    digest(files.map(({ path, sha256 }) => ({ path, sha256 })))
  )
    throw Error("文档模型内容摘要不一致。");
  return { receipt, identity: digest(receipt) };
}

export async function parseDoclingPage(
  base64,
  pageIndex,
  { signal, output, timeoutMs = 360_000 } = {},
) {
  const directory = path.resolve(
    output || path.join(root, ".runtime/document-extraction", randomUUID()),
  );
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const record = {
    schemaVersion: "lemma.document-parser-receipt.v1",
    paperSha256: sha256(Buffer.from(base64, "base64")),
    pageIndex,
    startedAt: new Date().toISOString(),
    network: "OS_denied",
    status: "unavailable",
  };
  try {
    const modelRoot = path.join(root, ".tools/document-models");
    const models = await verifyDocumentModels(modelRoot);
    record.modelIdentity = models.identity;
    record.dependencies = sha256(
      await readFile(path.join(root, "worker/document-requirements.lock")),
    );
    record.workerSha256 = sha256(
      await readFile(path.join(root, "worker/document_parse.py")),
    );
    signal?.throwIfAborted();
    const input = path.join(directory, "input.pdf"),
      resultFile = path.join(directory, "docling.json");
    await writeFile(input, Buffer.from(base64, "base64"), { flag: "wx" });
    await mkdir(path.join(directory, "home"));
    record.status = "running";
    const profile = `(version 1)(allow default)(deny network*)(deny file-write* (require-not (require-any (subpath ${JSON.stringify(directory)}) (literal "/dev/null"))))`;
    await writeFile(path.join(directory, "sandbox.sb"), profile);
    const child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        profile,
        path.join(root, ".tools/document-venv/bin/python"),
        path.join(root, "worker/document_parse.py"),
        input,
        resultFile,
        modelRoot,
        String(pageIndex),
      ],
      {
        cwd: directory,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin:/opt/homebrew/bin",
          HOME: path.join(directory, "home"),
          TMPDIR: directory,
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          PYTHONDONTWRITEBYTECODE: "1",
          MPLCONFIGDIR: path.join(directory, "home"),
          OMP_NUM_THREADS: "2",
          TOKENIZERS_PARALLELISM: "false",
        },
      },
    );
    let stdout = "",
      stderr = "";
    const abort = () => {
      record.status = "cancelled";
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      record.status = "timeout";
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (b) => {
      stdout = (stdout + b).slice(-1_000_000);
    });
    child.stderr.on("data", (b) => {
      stderr = (stderr + b).slice(-1_000_000);
    });
    try {
      record.process = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await writeFile(path.join(directory, "stdout.log"), stdout);
      await writeFile(path.join(directory, "stderr.log"), stderr);
    }
    if (!["timeout", "cancelled"].includes(record.status)) {
      record.result = JSON.parse(await readFile(resultFile, "utf8"));
      record.status =
        record.process.exitCode === 0 && record.result.status === "success"
          ? "parsed"
          : "failed";
      if (
        record.status === "parsed" &&
        (record.result.paperSha256 !== record.paperSha256 ||
          record.result.pageIndex !== pageIndex)
      )
        throw Error("Docling 输出与原始 PDF 页身份不符。");
    }
  } catch (e) {
    record.error = { code: e.code || null, message: e.message };
    if (record.status !== "unavailable") record.status = "failed";
  }
  record.endedAt = new Date().toISOString();
  await writeFile(
    path.join(directory, "receipt.json"),
    JSON.stringify(record, null, 2) + "\n",
    { flag: "wx" },
  );
  return { ...record, directory };
}

export const MATH_DIFFERENCE_POLICY = "lemma.math-differences.v4";
const differencePolicies = [
  "lemma.math-differences.v1",
  "lemma.math-differences.v2",
  "lemma.math-differences.v3",
  MATH_DIFFERENCE_POLICY,
];
export function mathematicalDiscrepancies(
  geometry,
  parser,
  { policy = MATH_DIFFERENCE_POLICY } = {},
) {
  if (!differencePolicies.includes(policy))
    throw Error("未知数学抽取差异规则版本。");
  const issues = [];
  if (policy === MATH_DIFFERENCE_POLICY)
    for (const item of geometry.visibility?.items || [])
      for (const code of item.flags)
        issues.push({
          code,
          pageIndex: geometry.pageIndex,
          scope: "text_item",
          itemIndex: item.itemIndex,
          box: item.box,
          blocking: true,
          detail:
            "原文文字的页面可见性存在疑点，保留原文字节与页图；区域内有像素也不证明字形一致。",
        });
  if (parser && !["parsed", "not_requested"].includes(parser.status))
    issues.push({
      code: "document_parser_incomplete",
      pageIndex: geometry.pageIndex,
      scope: "page",
      parserStatus: parser.status,
      blocking: true,
      detail:
        "已请求的数学解析器没有完成，原页抽取尚未核实；保留失败并补充解析证据后再复核。",
    });
  if (geometry.quality.replacementCharacters)
    issues.push({
      code: "pdf_replacement_character",
      pageIndex: geometry.pageIndex,
      scope: "page",
      detail: "PDF 文本含替换字符，原数学符号尚未确定。",
      blocking: true,
    });
  if (parser?.status === "parsed")
    for (const [index, item] of parser.result.items.entries()) {
      if (item.label !== "formula") continue;
      const original = item.originalText || "",
        candidate = item.text || "";
      const hasBar = /\\(?:overline|bar|overbar)\b/.test(candidate);
      if (hasBar && !/[¯̅]|\\(?:bar|overline|overbar)\b/.test(original))
        issues.push({
          code: "formula_conjugation_or_overbar_conflict",
          pageIndex: geometry.pageIndex,
          scope: "formula",
          itemIndex: index,
          provenance: item.provenance,
          original,
          candidate,
          blocking: true,
          detail:
            "图像公式候选含上划线，原始文本未明确保留；须对照原页确认，不能自动采用任一路结果。",
        });
      if (policy !== "lemma.math-differences.v1") {
        const introduced = [
          { command: /\\sqrt\b/, source: /√|\\sqrt\b|\bsqrt\b/, name: "根号" },
          { command: /\\sum\b/, source: /∑|Σ|\\sum\b/, name: "求和符号" },
          { command: /\\prod\b/, source: /∏|Π|\\prod\b/, name: "连乘符号" },
          { command: /\\int\b/, source: /∫|\\int\b/, name: "积分符号" },
        ];
        for (const operator of introduced)
          if (
            operator.command.test(candidate) &&
            !operator.source.test(original)
          )
            issues.push({
              code: "formula_operator_not_grounded_in_text",
              pageIndex: geometry.pageIndex,
              scope: "formula",
              itemIndex: index,
              provenance: item.provenance,
              original,
              candidate,
              blocking: true,
              detail: `候选中的${operator.name}未在原始文本中保留，必须核对页图，不能将候选直接当作原文。`,
            });
        let depth = 0,
          invalid = false;
        for (let at = 0; at < candidate.length; at++) {
          if (candidate[at] === "\\") {
            at++;
            continue;
          }
          if (candidate[at] === "{") depth++;
          if (candidate[at] === "}" && --depth < 0) invalid = true;
        }
        if (depth !== 0 || invalid)
          issues.push({
            code: "formula_latex_grouping_invalid",
            pageIndex: geometry.pageIndex,
            scope: "formula",
            itemIndex: index,
            provenance: item.provenance,
            original,
            candidate,
            blocking: true,
            detail: "公式候选的大括号不配对，不能作为可靠数学表达使用。",
          });
        if (
          ["lemma.math-differences.v3", MATH_DIFFERENCE_POLICY].includes(policy)
        ) {
          let delimiters = 0,
            unmatched = false;
          for (const token of candidate.match(/\\(?:left|right)\b/g) || []) {
            delimiters += token === "\\left" ? 1 : -1;
            if (delimiters < 0) unmatched = true;
          }
          if (delimiters || unmatched)
            issues.push({
              code: "formula_latex_delimiter_unpaired",
              pageIndex: geometry.pageIndex,
              scope: "formula",
              itemIndex: index,
              provenance: item.provenance,
              original,
              candidate,
              blocking: true,
              detail:
                "公式候选的伸缩定界符不成对；须核对原页，不能静默补齐后当作原文。",
            });
        }
      }
    }
  return issues;
}
export async function enrichMathematicalSource(
  paper,
  pageIndex,
  { signal, docling = process.env.LEMMA_DOCUMENT_PARSER === "docling" } = {},
) {
  const geometry = await pageGeometry(paper.pdfBase64, pageIndex, {
    signal,
    visibility: true,
  });
  const parser = docling
    ? await parseDoclingPage(paper.pdfBase64, pageIndex, { signal })
    : null;
  const { directory: _localDirectory, ...portableParser } = parser || {};
  return {
    ...paper,
    mathEvidence: {
      schemaVersion: "lemma.math-source.v2",
      differencePolicy: MATH_DIFFERENCE_POLICY,
      paperSha256: paper.paperSha256,
      pages: [
        {
          geometry,
          parser: parser ? portableParser : { status: "not_requested" },
          issues: mathematicalDiscrepancies(geometry, parser),
        },
      ],
      authority:
        "preserved_source_and_extraction_candidates_not_semantic_truth",
    },
  };
}

// Before any paid reading: render and validate geometry locally, retaining only
// identities/counts here. Selected source pages still get full native evidence.
export async function preflightPaperGeometry(paper, { signal } = {}) {
  const pages = [];
  for (const page of paper.pages) {
    try {
      const geometry = await pageGeometry(paper.pdfBase64, page.index, {
        signal,
        visibility: true,
      });
      pages.push({
        pageIndex: page.index,
        geometryHash: digest(geometry),
        textSha256: geometry.textSha256,
        pageImageSha256: geometry.pageImage?.sha256 || null,
        unresolvedItems: geometry.visibility.items.filter(
          (i) => i.status === "unresolved",
        ).length,
      });
    } catch (cause) {
      throw Object.assign(
        Error(`原文几何预检失败（页 ${page.index + 1}）：${cause.message}`),
        {
          recoveryStop: "source_preflight_incomplete_no_model_diagnosis",
          code: "source_preflight_failed",
          sourcePreflight: {
            paperSha256: paper.paperSha256,
            pageIndex: page.index,
            completedPages: pages,
          },
        },
      );
    }
  }
  return {
    schemaVersion: "lemma.geometry-preflight.v1",
    paperSha256: paper.paperSha256,
    pages,
    authority:
      "local_serialization_readiness_not_source_or_mathematical_acceptance",
  };
}
export function mathContext(evidence) {
  return {
    schemaVersion: evidence.schemaVersion,
    paperSha256: evidence.paperSha256,
    ...(evidence.differencePolicy
      ? { differencePolicy: evidence.differencePolicy }
      : {}),
    pages: evidence.pages.map(({ geometry, parser, issues }) => ({
      pageIndex: geometry.pageIndex,
      textSha256: geometry.textSha256,
      textItemCount: geometry.items.length,
      pageImage: geometry.pageImage
        ? {
            sha256: geometry.pageImage.sha256,
            width: geometry.pageImage.width,
            height: geometry.pageImage.height,
            exposure: "identity_only_pixels_not_sent_to_text_model",
          }
        : null,
      parserStatus: parser.status,
      formulas: (parser.result?.items || [])
        .filter((i) => i.label === "formula")
        .map((i) => {
          if (!i.crop) return i;
          const { base64: _pixels, ...identity } = i.crop;
          return {
            ...i,
            crop: {
              ...identity,
              exposure: "identity_only_pixels_not_sent_to_text_model",
            },
          };
        }),
      issues,
    })),
    authority: evidence.authority,
  };
}

export async function validateMathematicalSource(source) {
  const evidence = source.mathEvidence;
  if (
    !["lemma.math-source.v1", "lemma.math-source.v2"].includes(
      evidence.schemaVersion,
    ) ||
    evidence.paperSha256 !== source.paperSha256 ||
    !Array.isArray(evidence.pages) ||
    evidence.pages.length > 8
  )
    throw Error("数学解析证据版本或来源无效。");
  const policy =
    evidence.schemaVersion === "lemma.math-source.v1"
      ? "lemma.math-differences.v1"
      : evidence.differencePolicy;
  if (
    evidence.schemaVersion === "lemma.math-source.v2" &&
    !differencePolicies.slice(1).includes(policy)
  )
    throw Error("数学解析差异规则未固定到受支持版本。");
  const currentPolicyIssues = [];
  for (const { geometry, parser, issues } of evidence.pages) {
    if (
      ![
        "lemma.pdf-geometry.v1",
        "lemma.pdf-geometry.v2",
        "lemma.pdf-geometry.v3",
      ].includes(geometry.schemaVersion)
    )
      throw Error("未知页面几何版本。");
    const actual = await pageGeometry(source.pdfBase64, geometry.pageIndex, {
      visibility: geometry.schemaVersion !== "lemma.pdf-geometry.v1",
      geometryVersion: geometry.schemaVersion,
    });
    if (
      digest(actual) !== digest(geometry) ||
      digest(mathematicalDiscrepancies(actual, parser, { policy })) !==
        digest(issues)
    )
      throw Error("页图、位置、公式冲突或原始文本与归档不一致。");
    const currentGeometry =
      geometry.schemaVersion === "lemma.pdf-geometry.v3"
        ? actual
        : await pageGeometry(source.pdfBase64, geometry.pageIndex, {
            visibility: true,
          });
    currentPolicyIssues.push(
      ...mathematicalDiscrepancies(currentGeometry, parser),
    );
    if (
      parser.status === "parsed" &&
      (parser.result.paperSha256 !== source.paperSha256 ||
        parser.result.pageIndex !== geometry.pageIndex)
    )
      throw Error("归档公式候选未绑定到原 PDF 页。");
    if (
      parser.status === "parsed" &&
      parser.result.schemaVersion === "lemma.docling-page.v2"
    )
      for (const item of parser.result.items) {
        if (!item.crop) continue;
        const crop = item.crop,
          bytes = Buffer.from(crop.base64 || "", "base64");
        if (
          crop.mediaType !== "image/png" ||
          !Number.isInteger(crop.width) ||
          crop.width <= 0 ||
          !Number.isInteger(crop.height) ||
          crop.height <= 0 ||
          bytes.length < 8 ||
          bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
          sha256(bytes) !== crop.sha256
        )
          throw Error("归档公式裁图缺失或摘要不一致。");
      }
  }
  return {
    geometryReproduced: true,
    differencePolicy: policy,
    currentPolicyIssues,
    formulaPredictions: "archived_model_output_not_rerun",
    semanticAccuracyCertified: false,
  };
}
