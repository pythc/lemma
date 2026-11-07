import { reviewCompletion } from "../shared/review-completion.mjs";
import { digest, inspectBundle } from "./evidence.mjs";

// Run JSON is mutable navigation. Only the verified immutable conclusion may
// supply the claims and scope used to accept a result.
export function evaluationRecordBinding(run, bundle) {
  const root = inspectBundle(bundle, run.root || run.failureRoot).root;
  const archived =
    root.kind === "adaptive:conclude" ? root.payload?.value : null;
  const bound = !!(
    archived &&
    run.conclusion &&
    Array.isArray(run.claims) &&
    digest(archived) === digest(run.conclusion) &&
    digest(archived.claims ?? null) === digest(run.claims) &&
    digest(archived.reviewScope ?? null) === digest(run.reviewScope ?? null)
  );
  if (archived && !bound)
    throw Error("Review summary does not match its immutable conclusion root");
  return {
    root: root.id,
    bound,
    reason: bound ? null : "no_immutable_conclusion_at_root",
  };
}

const millis = (value) =>
  typeof value === "number" ? value : Date.parse(value);
const duration = (start, end) =>
  Number.isFinite(millis(start)) &&
  Number.isFinite(millis(end)) &&
  millis(end) >= millis(start)
    ? millis(end) - millis(start)
    : null;

// Intervals overlap (a task contains model/tool calls). Never add their durations
// and present the sum as wall time. Missing timestamps remain missing evidence.
export function evaluationTimeline(run, records, input, result) {
  const rows = [],
    seen = new Set();
  const add = (row) => {
    const key = `${row.kind}:${row.owner}:${row.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ ...row, elapsedMs: duration(row.start, row.end) });
  };
  for (const record of [run, ...records]) {
    for (const e of record.modelBudget?.entries || [])
      add({
        kind: "model",
        owner: record.id,
        id: e.id,
        stage: e.logicalStage || e.purpose || e.role,
        start: e.reservedAt || null,
        end: e.endedAt || null,
        dispatchedAt: e.dispatchedAt || null,
        queueMs: e.observedQueueMs ?? null,
        exchangeMs: e.observedElapsedMs ?? null,
        state: e.state,
        protectedCalls: e.protectedCalls ?? null,
        protectedMs: e.protectedMs ?? null,
        phaseDecision: e.phaseDecision || null,
        finishReason: e.finishReason || null,
        usage: e.usage || null,
        receipt: e.receipt || null,
      });
    for (const t of record.tasks || [])
      add({
        kind: "task",
        owner: record.id,
        id: t.id,
        stage: t.role,
        start: t.startedAt || null,
        end: t.endedAt || null,
        state: t.status,
        receipt: t.output || null,
      });
    for (const t of record.nativeTimings || [])
      add({
        kind: "native",
        owner: record.id,
        id: t.id,
        stage: t.name,
        start: t.startedAtMs ?? null,
        end: t.endedAtMs ?? null,
        state: t.status,
        parentId: t.parentId || null,
        resultStatus: t.resultStatus || null,
      });
  }
  rows.sort((a, b) => (millis(a.start) || 0) - (millis(b.start) || 0));
  return {
    schemaVersion: "lemma.evaluation-timeline.v1",
    startedAt: input.startedAt,
    endedAt: result.endedAt,
    wallMs: duration(input.startedAt, result.endedAt),
    intervalPolicy:
      "overlapping_intervals_not_additive; missing_timestamps_are_null",
    rows,
    budgetStop: run.budgetStop || null,
    termination: run.termination || null,
    recordedModelCalls: run.modelCalls ?? null,
  };
}

export function evaluationClosure(
  run,
  {
    integrity,
    recordBound = false,
    replay,
    implementationUnchanged,
    activeRecords = [],
  },
) {
  const completion = reviewCompletion(run);
  const selected =
    run.claims?.filter(
      (c) =>
        !run.reviewScope?.selectedClaimIds ||
        run.reviewScope.selectedClaimIds.includes(c.id),
    ) || [];
  const claims = selected.map((c) => {
    const r = c.formalResult || {},
      check = r.check;
    return {
      id: c.id,
      targetHash: r.contract?.targetHash || null,
      semantic: r.conclusion?.semantic || "unknown",
      native: check
        ? {
            status: check.status,
            mode: check.mode,
            targetHash: check.targetHash,
            axioms: check.axioms || null,
          }
        : null,
      exactTargetVerified: !!(
        r.checkArtifact &&
        check?.status === "verified" &&
        check.targetHash === r.contract?.targetHash &&
        ["proof", "counterexample"].includes(check.mode)
      ),
      authorRoute: r.originalProofRoute?.summary?.status || "unverified",
      authorRouteRoot: r.originalProofRoute?.root || null,
    };
  });
  const selectedTargetClosed = !!(
    integrity &&
    recordBound &&
    implementationUnchanged &&
    completion.reviewComplete &&
    run.conclusion?.reviewComplete === true &&
    !activeRecords.length &&
    claims.length &&
    claims.every((c) => c.exactTargetVerified) &&
    replay?.integrity &&
    replay?.reproduced &&
    replay?.revalidated &&
    replay?.sameEnvironment
  );
  return {
    schemaVersion: "lemma.evaluation-closure.v1",
    executionStatus: run.status,
    recordedReviewComplete: run.conclusion?.reviewComplete ?? null,
    completion,
    claims,
    selectedTargetClosed,
    originalProofProvidedAndVerified:
      selectedTargetClosed &&
      claims.every(
        (c) =>
          c.authorRouteRoot &&
          ["verified_route", "verified_with_completion"].includes(
            c.authorRoute,
          ),
      ),
    sourceProofMissing: claims.some(
      (c) => c.authorRoute === "source_proof_missing",
    ),
    wholePaperVerified: false,
    integrity,
    recordBound,
    implementationUnchanged,
    activeRecords,
    independentReplay: replay || { status: "not_run" },
    secondFamily: "not_accepted",
  };
}
