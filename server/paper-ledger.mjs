import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  digest,
  sha256,
  isHash,
  isId,
  inspectBundle,
  unpackPaperBundle,
} from "./evidence.mjs";
import { normalize, text } from "./contracts.mjs";
import { extractInWorker } from "./pipeline.mjs";
import { inspectReviewEvidence } from "./review-evidence.mjs";
import {
  onlyKeys,
  validateLedger,
  entryHash,
  dependencyHash,
  ledgerReport,
  LEDGER_LIMITS,
} from "./ledger-model.mjs";

const GENERATOR_SHA256 = sha256(
  (
    await Promise.all(
      [
        "./paper-ledger.mjs",
        "./ledger-model.mjs",
        "./review-evidence.mjs",
        "./evidence.mjs",
        "./contracts.mjs",
        "./pdf.mjs",
        "./pdf-worker.mjs",
        "./pipeline.mjs",
        "../shared/ledger-labels.mjs",
      ].map((name) => readFile(fileURLToPath(new URL(name, import.meta.url)))),
    )
  )
    .map(sha256)
    .join("\n"),
);

function subBundle(artifacts, root) {
  const selected = new Map();
  const visit = (id) => {
    if (selected.has(id)) return;
    const a = artifacts.get(id);
    if (!a) throw new Error("账本缺少运行证据。");
    selected.set(id, a);
    a.inputs.forEach(visit);
  };
  visit(root);
  return {
    schemaVersion: "lemma.evidence.v1",
    root,
    artifacts: [...selected.values()],
  };
}
function checkSourceMatch(info, source) {
  if (
    info.contract.paperSha256 !== source.paperSha256 ||
    info.source.payload.text !== source.pages[info.contract.pageIndex]?.text
  )
    throw new Error("评审原文与当前论文快照不一致。");
}
function readLedgerGraph(bundle, expectedRoot) {
  const expanded = unpackPaperBundle(bundle),
    { root, artifacts } = inspectBundle(
      expanded,
      expectedRoot,
      LEDGER_LIMITS.artifacts,
    );
  if (
    root.kind !== "paper_ledger_report" ||
    !isHash(root.payload.revision) ||
    root.inputs.length !== 1 ||
    root.inputs[0] !== root.payload.revision
  )
    throw new Error("不是带固定账本修订的论文报告。");
  const revision = artifacts.get(root.payload.revision),
    snapshot = revision?.payload;
  const source = artifacts.get(snapshot?.sourceArtifact);
  if (
    revision?.kind !== "paper_ledger_revision" ||
    source?.kind !== "paper_source"
  )
    throw new Error("账本原文或修订缺失。");
  validateLedger(snapshot, source.payload);
  // Verify every revision, including retained entries/bindings, instead of trusting a latest-only manifest.
  const historicalReports = [];
  let node = revision,
    depth = 0;
  while (node) {
    if (++depth > LEDGER_LIMITS.revisions)
      throw new Error("账本修订链超过预算。");
    const value = node.payload;
    validateLedger(value, source.payload);
    const expectedInputs = [
      ...new Set([
        value.sourceArtifact,
        ...(value.previousRevision ? [value.previousRevision] : []),
        ...(value.previousReport ? [value.previousReport] : []),
        ...value.bindings.map((b) => b.root),
      ]),
    ].sort();
    if (
      node.kind !== "paper_ledger_revision" ||
      value.sourceArtifact !== source.id ||
      digest([...node.inputs].sort()) !== digest(expectedInputs)
    )
      throw new Error("账本修订的源文或证据依赖不完整。");
    if (!value.previousRevision) {
      if (value.changes.length !== 1 || value.changes[0].type !== "create")
        throw new Error("账本初始修订无效。");
      break;
    }
    const parent = artifacts.get(value.previousRevision);
    const parentReport = artifacts.get(value.previousReport);
    if (
      !parent ||
      parentReport?.kind !== "paper_ledger_report" ||
      parentReport.payload.revision !== parent.id ||
      digest(parentReport.inputs) !== digest([parent.id]) ||
      parent.payload.changes.length + 1 !== value.changes.length ||
      digest(value.changes.slice(0, -1)) !== digest(parent.payload.changes) ||
      parent.payload.entries.some(
        (e) => !value.entries.some((next) => next.id === e.id),
      ) ||
      parent.payload.bindings.some(
        (b) => !value.bindings.some((next) => digest(next) === digest(b)),
      )
    )
      throw new Error("账本历史、未完成条目或证据被删除。");
    historicalReports.push({
      snapshot: parent.payload,
      report: parentReport.payload.report,
    });
    node = parent;
  }
  const reports = new Map();
  for (const b of snapshot.bindings)
    if (!reports.has(b.root)) {
      const info = inspectReviewEvidence(subBundle(artifacts, b.root), b.root);
      checkSourceMatch(info, source.payload);
      reports.set(b.root, info);
    }
  const report = ledgerReport(snapshot, reports);
  for (const historical of historicalReports)
    if (
      digest(ledgerReport(historical.snapshot, reports)) !==
      digest(historical.report)
    )
      throw new Error("历史报告与其修订及证据不一致。");
  if (digest(root.payload.report) !== digest(report))
    throw new Error("账本报告与登记义务及证据不一致。");
  return { root, revision, snapshot, source, reports, artifacts, report };
}

export async function replayPaperBundle(bundle, expectedRoot, replayReview) {
  const graph = readLedgerGraph(bundle, expectedRoot);
  const actual = await extractInWorker(graph.source.payload.pdfBase64, null);
  if (digest(actual) !== digest(graph.source.payload))
    throw new Error("论文级快照与实际 PDF 重新解析不一致。");
  const results = [],
    reports = new Map(graph.reports);
  for (const [root, info] of graph.reports) {
    const replay = await replayReview(subBundle(graph.artifacts, root), root);
    results.push({ root, runId: info.saved.runId, ...replay });
    reports.set(root, { ...info, conclusion: replay.conclusion });
  }
  const report = ledgerReport(graph.snapshot, reports),
    reportMatched = digest(report) === digest(graph.report);
  const sameGenerator = graph.root.payload.generatorSha256 === GENERATOR_SHA256;
  return {
    schemaVersion: "lemma.paper-replay.v1",
    root: bundle.root,
    revision: graph.revision.id,
    generatorSha256: GENERATOR_SHA256,
    sourceReextracted: true,
    report,
    reportMatched,
    results,
    sameEnvironment:
      results.length > 0 &&
      sameGenerator &&
      results.every((r) => r.sameEnvironment),
    reproduced:
      results.length > 0 &&
      sameGenerator &&
      reportMatched &&
      results.every((r) => r.reproduced),
    revalidated: results.length > 0 && results.every((r) => r.revalidated),
    scope: "registered_obligations_not_whole_paper",
    wholePaperVerified: false,
  };
}

export class PaperLedger {
  constructor({ store, pipeline }) {
    Object.assign(this, { store, pipeline });
    this.locks = new Set();
  }
  async init() {
    await mkdir(path.join(this.store.root, "ledgers"), {
      recursive: true,
      mode: 0o700,
    });
  }
  async lock(paper, action) {
    if (!isHash(paper)) throw new Error("论文摘要无效。");
    if (this.locks.has(paper)) throw new Error("范围正在更新，请刷新后重试。");
    this.locks.add(paper);
    try {
      return await action();
    } finally {
      this.locks.delete(paper);
    }
  }
  async index(paper) {
    if (!isHash(paper)) throw new Error("论文摘要无效。");
    try {
      const index = JSON.parse(
        await readFile(
          path.join(this.store.root, "ledgers", paper + ".json"),
          "utf8",
        ),
      );
      if (
        index.paperSha256 !== paper ||
        !isHash(index.root) ||
        !isHash(index.revision)
      )
        throw new Error("账本索引无效。");
      return index;
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  async graph(paper) {
    const index = await this.index(paper);
    if (!index) return null;
    const graph = readLedgerGraph(
      await this.store.bundle(index.root, {
        compactPdf: true,
        maxArtifacts: LEDGER_LIMITS.artifacts,
      }),
      index.root,
    );
    if (
      graph.snapshot.paperSha256 !== paper ||
      graph.revision.id !== index.revision
    )
      throw new Error("账本索引与证据不一致。");
    return graph;
  }
  view(graph) {
    return {
      root: graph.root.id,
      revision: graph.revision.id,
      snapshot: graph.snapshot,
      report: graph.report,
      pageCount: graph.source.payload.pageCount,
      pagesWithoutText: graph.source.payload.pages
        .filter((p) => p.quality === "no_text")
        .map((p) => p.index),
      generatorChanged: graph.root.payload.generatorSha256 !== GENERATOR_SHA256,
      limits: LEDGER_LIMITS,
    };
  }
  async get(paper) {
    const graph = await this.graph(paper);
    return graph ? this.view(graph) : null;
  }
  async commit(snapshot, source) {
    validateLedger(snapshot, source);
    const reports = new Map();
    for (const b of snapshot.bindings)
      if (!reports.has(b.root)) {
        const info = inspectReviewEvidence(
          await this.store.bundle(b.root),
          b.root,
        );
        checkSourceMatch(info, source);
        reports.set(b.root, info);
      }
    const report = ledgerReport(snapshot, reports);
    const inputs = [
      ...new Set([
        snapshot.sourceArtifact,
        ...(snapshot.previousRevision ? [snapshot.previousRevision] : []),
        ...(snapshot.previousReport ? [snapshot.previousReport] : []),
        ...snapshot.bindings.map((b) => b.root),
      ]),
    ];
    const revision = await this.store.put(
      "paper_ledger_revision",
      snapshot,
      inputs,
    );
    const root = await this.store.put(
      "paper_ledger_report",
      { revision, report, generatorSha256: GENERATOR_SHA256 },
      [revision],
    );
    const candidate = await this.store.bundle(root, {
      compactPdf: true,
      maxArtifacts: LEDGER_LIMITS.artifacts,
    });
    if (Buffer.byteLength(JSON.stringify(candidate)) > 50 * 1024 * 1024)
      throw new Error("新修订将超过 50 MB 归档预算，保留上一修订。");
    readLedgerGraph(candidate, root);
    const dest = path.join(
        this.store.root,
        "ledgers",
        snapshot.paperSha256 + ".json",
      ),
      temp = dest + "." + randomUUID() + ".tmp";
    await writeFile(
      temp,
      JSON.stringify({ paperSha256: snapshot.paperSha256, revision, root }),
      { mode: 0o600 },
    );
    await rename(temp, dest);
    return this.view({
      snapshot,
      source: { payload: source },
      report,
      revision: { id: revision },
      root: { id: root, payload: { generatorSha256: GENERATOR_SHA256 } },
    });
  }
  async create(paper, input) {
    return this.lock(paper, async () => {
      onlyKeys(input, ["pdfBase64", "title", "description"]);
      if (await this.index(paper))
        throw new Error("此文件已有范围账本，请读取当前修订。");
      const source = await extractInWorker(input.pdfBase64, null);
      if (source.paperSha256 !== paper)
        throw new Error("论文摘要与文件不匹配。");
      const sourceArtifact = await this.store.put("paper_source", source);
      return this.commit(
        {
          schemaVersion: "lemma.paper-ledger.v1",
          paperSha256: paper,
          sourceArtifact,
          previousRevision: null,
          previousReport: null,
          title: text(input.title, 120, "范围名称"),
          description: text(input.description, 3000, "范围说明"),
          mainIds: [],
          entries: [],
          bindings: [],
          changes: [
            {
              type: "create",
              at: new Date().toISOString(),
              authority: "local_human_registration_not_authenticated_identity",
            },
          ],
        },
        source,
      );
    });
  }
  async mutate(paper, input) {
    return this.lock(paper, async () => {
      onlyKeys(input, ["expectedRevision", "operation", "payload"]);
      const graph = await this.graph(paper);
      if (!graph || graph.revision.id !== input.expectedRevision)
        throw new Error("账本修订冲突，请刷新后重新应用修改。");
      const snapshot = structuredClone(graph.snapshot),
        payload = input.payload;
      const change = { type: input.operation, at: new Date().toISOString() };
      const item = () => {
        const value = snapshot.entries.find((e) => e.id === payload.entryId);
        if (!value) throw new Error("未找到账本条目。");
        change.entryId = value.id;
        return value;
      };
      const version = (e) => {
        e.version++;
        e.entryHash = entryHash(e);
      };
      const associate = async (entry, runId) => {
        if (["definition", "citation"].includes(entry.type))
          throw new Error("定义或文献匹配不能用一条定理证明代替。");
        if (!isId(runId)) throw new Error("运行编号无效。");
        const run = await this.store.getRun(runId);
        if (!run.root) throw new Error("评审尚未完成归档。");
        const info = inspectReviewEvidence(
            await this.store.bundle(run.root),
            run.root,
          ),
          c = info.contract;
        checkSourceMatch(info, graph.source.payload);
        if (
          info.saved.runId !== runId ||
          c.pageIndex !== entry.pageIndex ||
          normalize(c.quote) !== normalize(entry.quote) ||
          c.label !== entry.label ||
          c.statement !== entry.statement ||
          (entry.target && entry.target.targetHash !== c.targetHash)
        )
          throw new Error("评审与条目的原文、表述或固定目标不同。");
        if (!entry.target) {
          entry.target = c;
          version(entry);
        }
        const binding = {
          entryId: entry.id,
          entryHash: entry.entryHash,
          dependencyHash: dependencyHash(snapshot, entry.id),
          runId,
          root: run.root,
          recordedAt: change.at,
        };
        if (
          snapshot.bindings.some(
            (b) =>
              b.entryId === binding.entryId &&
              b.entryHash === binding.entryHash &&
              b.dependencyHash === binding.dependencyHash &&
              b.root === binding.root,
          )
        )
          throw new Error("同一版本已关联此运行。");
        snapshot.bindings.push(binding);
        return info;
      };
      switch (input.operation) {
        case "import_review_obligations": {
          onlyKeys(payload, ["runId"]);
          const run = await this.store.getRun(payload.runId);
          if (
            run.paperSha256 !== paper ||
            !Array.isArray(run.pendingObligations) ||
            !run.pendingObligations.length
          )
            throw new Error("该评审没有本论文的待处理义务。");
          change.runId = run.id;
          change.entryIds = [];
          for (const item of run.pendingObligations) {
            if (
              snapshot.entries.some(
                (e) =>
                  e.type === item.type &&
                  e.pageIndex === item.pageIndex &&
                  normalize(e.quote) === normalize(item.quote),
              )
            )
              continue;
            const e = {
              id: randomUUID(),
              type: item.type,
              label: item.label,
              pageIndex: item.pageIndex,
              quote: item.quote,
              statement: item.statement,
              version: 1,
              dependsOn: [],
              excludedReason: null,
              target: null,
            };
            e.entryHash = entryHash(e);
            snapshot.entries.push(e);
            change.entryIds.push(e.id);
          }
          if (!change.entryIds.length)
            throw new Error("这些义务已登记，请修改已有条目。");
          break;
        }
        case "add_entry": {
          onlyKeys(payload, [
            "type",
            "label",
            "pageIndex",
            "quote",
            "statement",
          ]);
          const e = {
            id: randomUUID(),
            ...payload,
            version: 1,
            dependsOn: [],
            excludedReason: null,
            target: null,
          };
          e.entryHash = entryHash(e);
          snapshot.entries.push(e);
          change.entryId = e.id;
          break;
        }
        case "adopt_run": {
          onlyKeys(payload, ["runId", "type", "asMain"]);
          if (
            typeof payload.asMain !== "boolean" ||
            !["claim", "proof_step", "condition"].includes(payload.type)
          )
            throw new Error("登记运行的类别或主目标选项无效。");
          const run = await this.store.getRun(payload.runId);
          if (!run.root) throw new Error("评审尚未完成归档。");
          const info = inspectReviewEvidence(
              await this.store.bundle(run.root),
              run.root,
            ),
            c = info.contract;
          checkSourceMatch(info, graph.source.payload);
          const e = {
            id: randomUUID(),
            type: payload.type,
            label: c.label,
            pageIndex: c.pageIndex,
            quote: c.quote,
            statement: c.statement,
            version: 1,
            target: null,
            dependsOn: [],
            excludedReason: null,
          };
          e.entryHash = entryHash(e);
          snapshot.entries.push(e);
          change.entryId = e.id;
          await associate(e, payload.runId);
          if (payload.asMain) snapshot.mainIds.push(e.id);
          break;
        }
        case "link_run":
          onlyKeys(payload, ["entryId", "runId"]);
          await associate(item(), payload.runId);
          break;
        case "set_dependencies": {
          onlyKeys(payload, ["entryId", "dependsOn", "reason"]);
          const e = item();
          change.reason = text(payload.reason, 1000, "依赖修订理由");
          if (
            !Array.isArray(payload.dependsOn) ||
            payload.dependsOn.length > LEDGER_LIMITS.entries
          )
            throw new Error("依赖清单无效。");
          e.dependsOn = [...payload.dependsOn].sort();
          version(e);
          break;
        }
        case "edit_entry": {
          onlyKeys(payload, [
            "entryId",
            "label",
            "pageIndex",
            "quote",
            "statement",
            "reason",
          ]);
          const e = item();
          change.reason = text(payload.reason, 1000, "条目修订理由");
          Object.assign(e, {
            label: payload.label,
            pageIndex: payload.pageIndex,
            quote: payload.quote,
            statement: payload.statement,
            target: null,
          });
          version(e);
          break;
        }
        case "set_main": {
          onlyKeys(payload, ["entryId", "selected", "reason"]);
          const e = item();
          if (e.type !== "claim" || typeof payload.selected !== "boolean")
            throw new Error("主目标必须是已登记命题。");
          change.reason = text(payload.reason, 1000, "主目标范围变更理由");
          snapshot.mainIds = payload.selected
            ? [...new Set([...snapshot.mainIds, e.id])]
            : snapshot.mainIds.filter((id) => id !== e.id);
          break;
        }
        case "exclude": {
          onlyKeys(payload, ["entryId", "reason"]);
          const e = item();
          e.excludedReason =
            payload.reason === null
              ? null
              : text(payload.reason, 1000, "排除理由");
          change.reason = e.excludedReason || "恢复到登记范围";
          break;
        }
        case "set_scope": {
          onlyKeys(payload, ["title", "description", "reason"]);
          change.reason = text(payload.reason, 1000, "范围变更理由");
          snapshot.title = text(payload.title, 120, "范围名称");
          snapshot.description = text(payload.description, 3000, "范围说明");
          break;
        }
        default:
          throw new Error("不支持的账本操作。");
      }
      snapshot.previousRevision = graph.revision.id;
      snapshot.previousReport = graph.root.id;
      snapshot.changes.push(change);
      return this.commit(snapshot, graph.source.payload);
    });
  }
  async bundle(paper) {
    const index = await this.index(paper);
    if (!index) throw new Error("未建立范围账本。");
    const bundle = await this.store.bundle(index.root, {
      compactPdf: true,
      maxArtifacts: LEDGER_LIMITS.artifacts,
    });
    if (Buffer.byteLength(JSON.stringify(bundle)) > 50 * 1024 * 1024)
      throw new Error("论文级证据包超过 50 MB 导出预算。");
    readLedgerGraph(bundle, index.root);
    return bundle;
  }
  async replay(paper) {
    return this.pipeline.reserve(async () => {
      const bundle = await this.bundle(paper);
      return replayPaperBundle(bundle, bundle.root, (value, root) =>
        this.pipeline.replayReserved(value, root),
      );
    });
  }
}
