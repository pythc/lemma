import { EVIDENCE_RUNTIME } from "./runtime-limits.mjs";
import { digest, isHash, isId } from "./evidence.mjs";
import { normalize, text, validateContract } from "./contracts.mjs";
import { ENTRY_TYPES } from "../shared/ledger-labels.mjs";

export const LEDGER_LIMITS = Object.freeze({
  entries: 512,
  bindings: 2048,
  runs: 512,
  revisions: 1024,
  artifacts: EVIDENCE_RUNTIME.paperArtifacts,
});
export function onlyKeys(value, keys) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new Error("请求含不支持的字段，不能直接写入核验状态。");
}
export function validateAnchor(item, source) {
  if (
    !Number.isInteger(item.pageIndex) ||
    item.pageIndex < 0 ||
    item.pageIndex >= source.pageCount
  )
    throw new Error("账本原文页码无效。");
  const quote = text(item.quote, 5000, "原文引句"),
    body = normalize(source.pages[item.pageIndex].text);
  const needle = normalize(quote),
    start = body.indexOf(needle);
  if (start < 0 || body.indexOf(needle, start + 1) >= 0)
    throw new Error("账本引句未在固定原页中唯一找到。");
}
export function entryHash(entry) {
  const { entryHash: ignored, excludedReason, ...content } = entry;
  return digest(content);
}
export function validateLedger(snapshot, source) {
  if (
    snapshot?.schemaVersion !== "lemma.paper-ledger.v1" ||
    !isHash(snapshot.paperSha256) ||
    snapshot.paperSha256 !== source.paperSha256 ||
    !isHash(snapshot.sourceArtifact) ||
    (snapshot.previousRevision !== null &&
      !isHash(snapshot.previousRevision)) ||
    (snapshot.previousReport !== null && !isHash(snapshot.previousReport)) ||
    (snapshot.previousRevision === null) !== (snapshot.previousReport === null)
  )
    throw new Error("账本或论文身份无效。");
  text(snapshot.title, 120, "范围名称");
  text(snapshot.description, 3000, "范围说明");
  if (
    !Array.isArray(source.pages) ||
    source.pages.length !== source.pageCount ||
    source.pages.some((p, i) => p.index !== i || typeof p.text !== "string")
  )
    throw new Error("全文页面清单无效。");
  if (
    !Array.isArray(snapshot.entries) ||
    snapshot.entries.length > LEDGER_LIMITS.entries ||
    !Array.isArray(snapshot.bindings) ||
    snapshot.bindings.length > LEDGER_LIMITS.bindings ||
    !Array.isArray(snapshot.changes) ||
    !snapshot.changes.length ||
    snapshot.changes.length > LEDGER_LIMITS.revisions ||
    !Array.isArray(snapshot.mainIds) ||
    snapshot.mainIds.length > 8
  )
    throw new Error("账本超过条目、运行或修订预算。");
  const ids = new Set(),
    anchors = new Set();
  for (const item of snapshot.entries) {
    if (
      !isId(item.id) ||
      ids.has(item.id) ||
      !Object.hasOwn(ENTRY_TYPES, item.type) ||
      !Number.isInteger(item.version) ||
      item.version < 1 ||
      !Array.isArray(item.dependsOn) ||
      new Set(item.dependsOn).size !== item.dependsOn.length ||
      item.entryHash !== entryHash(item)
    )
      throw new Error("账本条目重复或版本身份无效。");
    text(item.label, 120, "条目编号");
    text(item.statement, 5000, "条目表述");
    validateAnchor(item, source);
    if (item.excludedReason !== null)
      text(item.excludedReason, 1000, "排除理由");
    const location = `${item.type}:${item.pageIndex}:${normalize(item.quote)}`;
    if (anchors.has(location))
      throw new Error("同类条目的原文位置重复，请修订已有条目。");
    anchors.add(location);
    ids.add(item.id);
    if (item.target) {
      validateContract(item.target);
      if (
        ["definition", "citation"].includes(item.type) ||
        item.target.paperSha256 !== snapshot.paperSha256 ||
        item.target.pageIndex !== item.pageIndex ||
        normalize(item.target.quote) !== normalize(item.quote) ||
        item.target.statement !== item.statement ||
        item.target.label !== item.label
      )
        throw new Error("形式目标与账本条目不一致。");
    }
  }
  if (
    new Set(snapshot.mainIds).size !== snapshot.mainIds.length ||
    snapshot.mainIds.some(
      (id) =>
        !ids.has(id) ||
        snapshot.entries.find((e) => e.id === id).type !== "claim",
    )
  )
    throw new Error("主目标必须来自已登记的命题。");
  for (const item of snapshot.entries)
    if (item.dependsOn.some((id) => !ids.has(id)))
      throw new Error("依赖指向不存在的条目。");
  const bindingIds = new Set();
  for (const b of snapshot.bindings) {
    const key = `${b.entryId}:${b.entryHash}:${b.dependencyHash}:${b.root}`;
    if (
      !ids.has(b.entryId) ||
      !isHash(b.entryHash) ||
      !isHash(b.dependencyHash) ||
      !isHash(b.root) ||
      !isId(b.runId) ||
      bindingIds.has(key)
    )
      throw new Error("证据关联重复或无效。");
    bindingIds.add(key);
  }
  if (new Set(snapshot.bindings.map((b) => b.root)).size > LEDGER_LIMITS.runs)
    throw new Error("账本超过本机独立运行预算。");
  return snapshot;
}
export function dependencyHash(snapshot, id) {
  const entries = new Map(snapshot.entries.map((e) => [e.id, e])),
    seen = new Set();
  const visit = (current) => {
    if (seen.has(current)) return;
    const item = entries.get(current);
    if (!item) throw new Error("依赖指向不存在的条目。");
    seen.add(current);
    item.dependsOn.forEach(visit);
  };
  visit(id);
  return digest(
    [...seen].sort().map((key) => {
      const e = entries.get(key);
      return {
        id: key,
        entryHash: e.entryHash,
        excludedReason: e.excludedReason,
      };
    }),
  );
}
export function ledgerReport(snapshot, reports) {
  const counts = {
    proved: 0,
    refuted: 0,
    unknown: 0,
    pending: 0,
    stale: 0,
    conflict: 0,
    excluded: 0,
  };
  const items = snapshot.entries.map((item) => {
    const currentDependency = dependencyHash(snapshot, item.id);
    const evidence = snapshot.bindings
      .filter((b) => b.entryId === item.id)
      .map((b) => {
        const report = reports.get(b.root);
        if (
          !report ||
          report.saved.runId !== b.runId ||
          report.contract.paperSha256 !== snapshot.paperSha256
        )
          throw new Error("关联的评审产物缺失或属于其他论文。");
        const current =
          b.entryHash === item.entryHash &&
          b.dependencyHash === currentDependency;
        if (
          current &&
          (!item.target ||
            report.contract.targetHash !== item.target.targetHash)
        )
          throw new Error("证据目标与当前条目不一致。");
        return {
          ...b,
          current,
          theorem: report.conclusion.theorem,
          targetHash: report.contract.targetHash,
          libraryProfile: report.contract.libraryProfile || "std-v1",
        };
      });
    const available = evidence.filter((b) => b.current);
    const proved = available.some((b) => b.theorem === "formalized_proved"),
      refuted = available.some((b) => b.theorem === "refuted");
    const state = item.excludedReason
      ? "excluded"
      : proved && refuted
        ? "conflict"
        : refuted
          ? "refuted"
          : proved
            ? "proved"
            : available.length
              ? "unknown"
              : evidence.length
                ? "stale"
                : "pending";
    counts[state]++;
    return { ...item, state, evidence };
  });
  const byId = new Map(items.map((e) => [e.id, e]));
  const mains = snapshot.mainIds.map((id) => {
    const seen = new Set(),
      visiting = new Set(),
      cycles = new Set(),
      blocked = new Set();
    const visit = (current) => {
      if (visiting.has(current)) {
        cycles.add(current);
        return;
      }
      if (seen.has(current)) return;
      seen.add(current);
      visiting.add(current);
      const item = byId.get(current);
      if (item.state !== "proved") blocked.add(current);
      item.dependsOn.forEach(visit);
      visiting.delete(current);
    };
    visit(id);
    return {
      id,
      registeredDependencies: [...seen],
      blockedIds: [...blocked],
      cycleIds: [...cycles],
      closed: !blocked.size && !cycles.size,
    };
  });
  const unresolved = items.filter((e) => e.state !== "proved").map((e) => e.id);
  const headline = !mains.length
    ? "尚未指定主目标"
    : counts.conflict
      ? "存在证据冲突，需复核"
      : counts.refuted
        ? "存在已核验的否定结果"
        : mains.every((m) => m.closed)
          ? unresolved.length
            ? "主目标有形式化证据，仍有未完成项"
            : "登记的形式化目标已检查"
          : "仍有未完成的证明义务";
  return {
    schemaVersion: "lemma.ledger-report.v1",
    headline,
    counts,
    registeredEntries: items.length,
    mains,
    unresolvedIds: unresolved,
    wholePaperVerified: false,
    originalProof: "unverified",
    semantic: "separate_review_required",
    caveat:
      "这是人工登记范围的覆盖账本；形式化目标与自然语言、原证明路线及全篇无遗漏仍需独立审阅。排除项保留在登记总数中。",
    items,
  };
}
