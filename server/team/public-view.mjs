import { workSummary, readerTaskPage } from "./work-summary.mjs";
// A delivery projection is navigation, never a replacement for immutable proof
// receipts. Acceptance always checks the original artifact, not this index.
import { setImmediate as yieldIO } from "node:timers/promises";
import { referenceProjection } from "./references.mjs";
import { objectiveResolved } from "./objectives.mjs";
export function proofReceiptSummary(e) {
  const p = e.payload?.result;
  if (e.kind === "team:lean")
    return {
      artifactId: e.id,
      runId: e.payload.runId,
      actorId: e.payload.actorId,
      targetId: p.targetId,
      targetHash: p.result.targetHash,
      mode: p.mode,
      status: p.result.status,
      kind: e.kind,
    };
  if (e.kind === "team:lean_reuse")
    return {
      artifactId: e.id,
      runId: e.payload.runId,
      actorId: e.payload.actorId,
      targetId: p.targetId,
      originalProofReceipt: p.originalProofReceipt,
      priorAcceptanceArtifact: p.priorAcceptanceArtifact,
      nativeCheckExecuted: false,
      kind: e.kind,
    };
  return null;
}
export async function publicTeamRun(
  run,
  getArtifact,
  { proofReceipts, indexStatus = "ready", compact = false } = {},
) {
  if (run.engine !== "team-v1") return run;
  const entries = proofReceipts ?? run.proofReceiptIndex ?? [];
  if (proofReceipts === undefined && !run.proofReceiptIndex)
    for (const id of run.receipts) {
      const entry = proofReceiptSummary({ ...(await getArtifact(id)), id });
      if (entry) entries.push(entry);
    }
  const checks = [],
    proofReuses = [];
  const targets = new Map(run.targets.map((t) => [t.id, t]));
  for (const entry of entries) {
    if (entry.runId !== run.id) continue;
    const { kind, runId, targetHash, ...p } = entry;
    if (kind === "team:lean_reuse") {
      proofReuses.push(p);
      continue;
    }
    const target = targets.get(p.targetId);
    if (!target || targetHash !== target.contract.targetHash) continue;
    checks.push({
      ...p,
      superseded: !!target.supersededBy,
      independentlyAccepted: run.submissions.some(
        (s) =>
          s.status === "pass" &&
          !s.superseded &&
          (s.targetIds.includes(p.targetId) ||
            s.objectiveDecisions?.some(
              (d) =>
                ["proved", "refuted"].includes(d.outcome) &&
                d.evidenceIds?.includes(p.artifactId),
            )) &&
          s.replayIds?.includes(p.artifactId),
      ),
    });
  }
  const view = {
    ...run,
    workSummary: workSummary(run),
    objectives: run.objectives?.map((g) => ({
      ...g,
      resolved: objectiveResolved(run, g),
    })),
    machineChecks: checks,
    proofReuses,
    proofIndexStatus: indexStatus,
    executionMetrics: {
      toolFailures: (run.operations || []).filter((o) => o.status === "failed")
        .length,
      unknownOperations: (run.operations || []).filter(
        (o) => o.status === "unknown",
      ).length,
      diagnosticFailures: (run.executionIndex || []).filter(
        (e) =>
          e.kind === "lean_draft" &&
          typeof e.status === "number" &&
          e.status !== 0,
      ).length,
      queuedOperations: (run.operations || []).filter(
        (o) =>
          run.status === "running" &&
          o.status === "running" &&
          o.phase === "queued",
      ).length,
      scope: "operation_and_diagnostic_counts_not_paper_propositions",
    },
  };
  if (!compact) return view;
  // Keep task/claim identities and the evidence links used by the reader. Huge
  // histories and proof text stay in the original archive and object tools.
  for (const key of [
    "turns",
    "events",
    "messages",
    "receipts",
    "proofReceiptIndex",
    "executionIndex",
    "references",
  ])
    delete view[key];
  const taskPage = readerTaskPage(run);
  view.tasks = taskPage.items;
  view.taskPage = { ...taskPage, items: undefined };
  view.targets = run.targets.map(({ contract, ...t }) => ({
    ...t,
    contract: {
      targetHash: contract.targetHash,
      statement: contract.statement,
      label: contract.label,
      pageIndex: contract.pageIndex,
      quote: contract.quote,
    },
  }));
  view.objectives = view.objectives?.map(({ history, attempts, ...g }) => g);
  const latest = new Map();
  for (const op of run.operations || []) latest.set(op.actorId, op.id);
  const recentFailures = new Set(
    (run.operations || [])
      .filter((o) => o.status === "failed")
      .slice(-30)
      .map((o) => o.id),
  );
  view.operations = (run.operations || [])
    .filter(
      (op) =>
        ["running", "unknown"].includes(op.status) ||
        latest.get(op.actorId) === op.id ||
        recentFailures.has(op.id),
    )
    .map(({ originalArguments, resolvedArguments, ...op }) =>
      referenceProjection(run, op),
    );
  view.progressReports = (run.progressReports || []).filter(
    (p, i, all) => !all.slice(i + 1).some((q) => q.actorId === p.actorId),
  );
  view.projection = {
    complete: false,
    scope: "reader_navigation",
    archiveRoot: run.root,
  };
  return view;
}

// Old archives have no compact index. Build it once in the background, without
// blocking a PDF/reader request or retaining full multi-megabyte proof objects.
export class TeamPublicViews {
  constructor(getArtifact) {
    this.getArtifact = getArtifact;
    this.cache = new Map();
  }
  async read(run) {
    if (run.engine !== "team-v1") return run;
    if (run.proofReceiptIndex)
      return publicTeamRun(run, this.getArtifact, { compact: true });
    let state = this.cache.get(run.id);
    if (!state) {
      state = { entries: [], seen: new Set(), pending: false, error: null };
      this.cache.set(run.id, state);
    }
    const missing = run.receipts.filter((id) => !state.seen.has(id));
    if (!state.pending && !state.error && missing.length) {
      state.pending = true;
      state.work = (async () => {
        for (const id of missing) {
          const p = proofReceiptSummary({
            ...(await this.getArtifact(id)),
            id,
          });
          if (p) state.entries.push(p);
          state.seen.add(id);
          await yieldIO();
        }
      })()
        .catch((e) => {
          state.error = e.message;
        })
        .finally(() => {
          state.pending = false;
        });
    }
    return publicTeamRun(run, this.getArtifact, {
      proofReceipts: state.entries,
      indexStatus: state.error
        ? "unavailable"
        : state.pending
          ? "building"
          : "ready",
      compact: true,
    });
  }
}
