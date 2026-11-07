import { durableFile } from "./durable-files.mjs";
import { EVIDENCE_RUNTIME } from "./runtime-limits.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  open,
} from "node:fs/promises";
import path from "node:path";
const runWrites = new Map();

export function canonical(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item, index) => canonical(item, `${path}[${index}]`)).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k], `${path}.${k}`)}`)
      .join(",")}}`;
  throw Object.assign(
    new Error(`证据包含不支持的值。位置：${path}；类型：${typeof value}`),
    { evidenceValuePath: path },
  );
}
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
export const digest = (value) => sha256(canonical(value));
export const isHash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isId = (value) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);

// Only execution-owned model records can introduce harness evidence roots.
// Never interpret arbitrary mathematical hashes in a model answer as artifacts.
export function receivedModelRoots(value) {
  const roots = value instanceof Error ? [value.harnessRoot] : [];
  for (const record of [value?.model, value?.record, value?.modelRecord])
    if (record?.source === "deepagents-js") roots.push(record.harnessRoot);
  return [...new Set(roots.filter(isHash))];
}

export class EvidenceStore {
  constructor(root) {
    this.root = root;
  }
  async init() {
    await mkdir(path.join(this.root, "artifacts"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(path.join(this.root, "runs"), { recursive: true, mode: 0o700 });
  }
  async put(kind, payload, inputs = []) {
    if (!Array.isArray(inputs) || !inputs.every(isHash))
      throw new Error("无效证据依赖。");
    const body = { kind, payload, inputs };
    const id = digest(body);
    try {
      await durableFile(
        path.join(this.root, "artifacts", `${id}.json`),
        canonical(body),
        { immutable: true },
      );
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      else await this.get(id);
    }
    return id;
  }
  async get(id) {
    if (!isHash(id)) throw new Error("无效证据 ID。");
    const body = JSON.parse(
      await readFile(path.join(this.root, "artifacts", `${id}.json`), "utf8"),
    );
    if (digest(body) !== id) throw new Error("证据摘要不匹配。");
    return { id, ...body };
  }
  async saveRun(run) {
    if (!isId(run.id)) throw new Error("无效任务 ID。");
    const dest = path.resolve(this.root, "runs", `${run.id}.json`);
    // Parallel agents share this record. Atomic rename alone does not stop an
    // older, larger write from completing after a newer snapshot.
    const previous = runWrites.get(dest) || Promise.resolve();
    const write = previous
      .catch(() => {})
      .then(async () => {
        await durableFile(dest, JSON.stringify(run));
      });
    runWrites.set(dest, write);
    try {
      await write;
    } finally {
      if (runWrites.get(dest) === write) runWrites.delete(dest);
    }
  }
  async getRun(id) {
    if (!isId(id)) throw new Error("无效任务 ID。");
    const projected = await this.projectionLoader?.(id);
    if (projected) return projected;
    return JSON.parse(
      await readFile(path.join(this.root, "runs", `${id}.json`), "utf8"),
    );
  }
  async bundle(
    root,
    { maxArtifacts = EVIDENCE_RUNTIME.artifacts, compactPdf = false } = {},
  ) {
    const artifacts = [],
      visited = new Set();
    const pdfs = new Map();
    const visit = async (id) => {
      if (visited.has(id)) return;
      visited.add(id);
      if (visited.size > maxArtifacts) throw new Error("证据图超过导出预算。");
      const artifact = await this.get(id);
      for (const input of artifact.inputs) await visit(input);
      if (
        compactPdf &&
        ["paper_source", "task:R02"].includes(artifact.kind) &&
        typeof artifact.payload.pdfBase64 === "string"
      ) {
        const { pdfBase64, ...payload } = artifact.payload;
        const pdfRef = sha256(Buffer.from(pdfBase64, "base64"));
        if (
          pdfRef !== payload.paperSha256 ||
          (pdfs.has(pdfRef) && pdfs.get(pdfRef) !== pdfBase64)
        )
          throw new Error("源 PDF 身份不一致。");
        pdfs.set(pdfRef, pdfBase64);
        artifacts.push({ ...artifact, payload, pdfRef });
      } else artifacts.push(artifact);
    };
    await visit(root);
    return compactPdf
      ? {
          schemaVersion: "lemma.paper-evidence.v1",
          root,
          pdfs: [...pdfs].map(([sha256, base64]) => ({ sha256, base64 })),
          artifacts,
        }
      : { schemaVersion: "lemma.evidence.v1", root, artifacts };
  }
  async listRuns(paperSha256) {
    if (!isHash(paperSha256)) throw new Error("论文摘要无效。");
    const items = [];
    for (const name of await readdir(path.join(this.root, "runs"))) {
      if (!name.endsWith(".json") || !isId(name.slice(0, -5))) continue;
      const run = await this.getRun(name.slice(0, -5));
      if (run.paperSha256 === paperSha256 && !run.parentReviewId)
        items.push({
          id: run.id,
          createdAt: run.createdAt,
          status: run.status,
          label:
            run.engine === "langgraph-v1"
              ? "自主论文评审"
              : run.engine === "cs-review-v1"
                ? "计算机论文评审"
                : run.contract?.label || "未固定命题",
          engine: run.engine || null,
          revision: run.revision || 0,
          pageIndex: run.pageIndex,
          headline: run.conclusion?.headline || null,
          root: run.root,
        });
    }
    return {
      items: items
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20),
      total: items.length,
    };
  }
}

export function inspectBundle(
  bundle,
  expectedRoot,
  maxArtifacts = EVIDENCE_RUNTIME.artifacts,
) {
  if (
    bundle?.schemaVersion !== "lemma.evidence.v1" ||
    !isHash(bundle.root) ||
    !Array.isArray(bundle.artifacts) ||
    bundle.artifacts.length > maxArtifacts
  )
    throw new Error("不是受支持的证据包。");
  if (expectedRoot && bundle.root !== expectedRoot)
    throw new Error("证据包不是预期版本。");
  const artifacts = new Map();
  for (const { id, ...body } of bundle.artifacts) {
    if (!isHash(id) || digest(body) !== id || artifacts.has(id))
      throw new Error("证据重复或被修改。");
    if (!Array.isArray(body.inputs) || !body.inputs.every(isHash))
      throw new Error("无效依赖。");
    artifacts.set(id, { id, ...body });
  }
  const visiting = new Set(),
    visited = new Set();
  const stack = [{ id: bundle.root, leaving: false }];
  while (stack.length) {
    const { id, leaving } = stack.pop();
    if (leaving) {
      visiting.delete(id);
      visited.add(id);
      continue;
    }
    if (visited.has(id)) continue;
    if (visiting.has(id)) throw new Error("证据存在循环依赖。");
    const item = artifacts.get(id);
    if (!item) throw new Error("证据包缺少依赖。");
    visiting.add(id);
    stack.push({ id, leaving: true });
    for (const input of [...item.inputs].reverse())
      stack.push({ id: input, leaving: false });
  }
  if (visited.size !== artifacts.size)
    throw new Error("证据包包含未关联的产物。");
  return { root: artifacts.get(bundle.root), artifacts };
}

export function evidenceClosure(bundle, root) {
  const all = new Map(bundle.artifacts.map((a) => [a.id, a])),
    selected = new Map(),
    pending = [root];
  while (pending.length) {
    const id = pending.pop();
    if (selected.has(id)) continue;
    const a = all.get(id);
    if (!a) throw Error("证据闭包缺少依赖。");
    selected.set(id, a);
    pending.push(...a.inputs);
  }
  const result = {
    schemaVersion: "lemma.evidence.v1",
    root,
    artifacts: [...selected.values()],
  };
  inspectBundle(result, root);
  return result;
}

// PDF bytes appear once on the wire; original artifact identities are restored before validation.
export function unpackPaperBundle(bundle) {
  if (
    bundle?.schemaVersion !== "lemma.paper-evidence.v1" ||
    !Array.isArray(bundle.pdfs) ||
    bundle.pdfs.length !== 1 ||
    !Array.isArray(bundle.artifacts) ||
    bundle.artifacts.length > EVIDENCE_RUNTIME.paperArtifacts
  )
    throw new Error("论文级证据包无效或超限。");
  const pdf = bundle.pdfs[0];
  if (
    !isHash(pdf.sha256) ||
    typeof pdf.base64 !== "string" ||
    pdf.base64.length > 36 * 1024 * 1024 ||
    sha256(Buffer.from(pdf.base64, "base64")) !== pdf.sha256
  )
    throw new Error("证据包的 PDF 字节摘要不匹配。");
  let references = 0;
  const artifacts = bundle.artifacts.map(({ pdfRef, ...artifact }) => {
    if (pdfRef === undefined) {
      if (artifact.payload?.pdfBase64)
        throw new Error("论文包中出现未归一的 PDF 副本。");
      return artifact;
    }
    if (
      !["paper_source", "task:R02"].includes(artifact.kind) ||
      pdfRef !== pdf.sha256 ||
      artifact.payload.paperSha256 !== pdfRef ||
      Object.hasOwn(artifact.payload, "pdfBase64")
    )
      throw new Error("PDF 引用不匹配。");
    references++;
    return {
      ...artifact,
      payload: { ...artifact.payload, pdfBase64: pdf.base64 },
    };
  });
  if (!references) throw new Error("论文包没有源文件依赖。");
  return { schemaVersion: "lemma.evidence.v1", root: bundle.root, artifacts };
}
