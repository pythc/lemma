import { digest } from "./evidence.mjs";
// Count observed request intervals, never task lifetimes or queued intervals.
export async function reviewMetrics(run, store) {
  const records = new Map();
  const add = (model) => {
    if (model?.requestId) records.set(model.requestId, model);
  };
  for (const t of run.tasks) {
    for (const a of t.attempts || []) add(a.model);
    if (t.childRunId) {
      try {
        const child = await store.getRun(t.childRunId);
        for (const task of child.tasks)
          if (task.output) add((await store.get(task.output)).payload.model);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
  }
  // The shared ledger includes SDK turns and prover helpers which are not
  // necessarily exposed as top-level task models. Prefer its immutable receipts.
  const origin = run.continuation?.originArtifact
    ? await store.get(run.continuation.originArtifact)
    : null;
  const previous = origin ? await store.get(origin.payload.previousRoot) : null;
  for (const entry of run.modelBudget?.entries || []) {
    if (!entry.receipt) continue;
    const receipt = await store.get(entry.receipt);
    if (
      receipt.kind !== "review_budget_receipt" ||
      (receipt.payload.reviewId !== run.id &&
        !(
          origin?.kind === "paper_continuation_origin" &&
          origin.payload.previousRunId === run.continuedFrom &&
          origin.payload.paperSha256 === run.paperSha256 &&
          previous.inputs.includes(entry.receipt) &&
          origin.payload.inheritedReservations.some(
            (e) =>
              e.id === entry.id &&
              e.receipt === entry.receipt &&
              e.reviewId === receipt.payload.reviewId &&
              e.entryHash === digest(entry),
          )
        )) ||
      receipt.payload.reservation !== entry.id
    )
      throw Error("预算收据身份不匹配。");
    add(receipt.payload.model);
  }
  const actual = [...records.values()].filter(
    (m) =>
      m.request &&
      m.startedAt &&
      m.endedAt &&
      m.resource?.executionStarted !== false &&
      m.error?.delivery?.outcome !== "not_sent",
  );
  const points = actual
    .flatMap((m) => [
      [Date.parse(m.resource?.executionStartedAt || m.startedAt), 1],
      [Date.parse(m.endedAt), -1],
    ])
    .filter(([n]) => Number.isFinite(n))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0,
    maxConcurrentRequests = 0,
    overlappingRequestMs = 0,
    last = null;
  for (const [at, delta] of points) {
    if (last !== null && running > 1) overlappingRequestMs += at - last;
    running += delta;
    maxConcurrentRequests = Math.max(maxConcurrentRequests, running);
    last = at;
  }
  const usageComplete =
    actual.length > 0 &&
    actual.length === (run.modelCalls || 0) &&
    actual.every((m) => Number.isFinite(m.usage?.total_tokens));
  const terminal = ["completed", "cancelled", "blocked"].includes(run.status);
  const finishedAt = terminal
    ? [...run.events].reverse().find((e) => e.type === run.status)?.at ||
      run.updatedAt
    : null;
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  return {
    modelCalls: run.modelCalls || 0,
    recordedRequests: actual.length,
    attempts: run.tasks.reduce((n, t) => n + (t.attempts?.length || 0), 0),
    recoveries: run.tasks.filter((t) =>
      ["diagnose", "diagnose_child"].includes(t.kind),
    ).length,
    recoveredTasks: run.tasks.filter(
      (t) => t.status === "succeeded" && t.attempts?.length > 1,
    ).length,
    unresolvedTasks: run.tasks.filter((t) => t.status === "unresolved").length,
    actualLeanClaimChecks: run.claims.filter(
      (c) =>
        c.formalResult?.check &&
        ("exitCode" in c.formalResult.check || c.formalResult.check.parser),
    ).length,
    semanticApprovals: run.claims.filter((c) => c.formalResult?.approval)
      .length,
    humanPauseRequests: run.events.filter((e) => e.type === "pause_requested")
      .length,
    humanSkippedBranches: run.events.filter(
      (e) => e.type === "human_skipped_child",
    ).length,
    evidenceArtifacts: new Set(
      run.tasks
        .flatMap((t) => [
          t.output,
          t.childArtifact,
          ...(t.attempts || []).flatMap((a) => [a.output, a.responseArtifact]),
        ])
        .filter(Boolean),
    ).size,
    wallClockMs: Math.max(0, end - Date.parse(run.createdAt)),
    maxConcurrentRequests,
    overlappingRequestMs,
    tokenUsage: usageComplete
      ? actual.reduce((n, m) => n + m.usage.total_tokens, 0)
      : null,
    tokenUsageComplete: usageComplete,
    cost: null,
  };
}
