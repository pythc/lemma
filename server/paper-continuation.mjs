import { randomUUID } from "node:crypto";
import { budgetSnapshot } from "./review-budget.mjs";
import { digest, isHash } from "./evidence.mjs";
import { ACTIONS } from "../shared/adaptive.mjs";

// Explicit, offline migration of a settled review. This never dispatches a
// model or modifies the source run. Prior task IDs remain evidence identities.
export async function preparePaperContinuation(
  store,
  previousId,
  { implementationBefore, implementationAfter } = {},
) {
  const prior = await store.getRun(previousId);
  const previousRoot = prior.root || prior.failureRoot;
  if (
    prior.engine !== "langgraph-v1" ||
    prior.orchestrationVersion !== 2 ||
    !["cancelled", "blocked"].includes(prior.status) ||
    !previousRoot ||
    budgetSnapshot(prior).inFlight ||
    prior.tasks.some((t) =>
      ["running", "queued", "recovering"].includes(t.status),
    )
  )
    throw Error("Continuation requires a fully settled archived paper review");
  if (
    ![implementationBefore, implementationAfter].every(isHash) ||
    implementationBefore === implementationAfter
  )
    throw Error(
      "Continuation requires distinct frozen implementation identities",
    );
  const archived = await store.get(previousRoot);
  if (
    !["adaptive_cancelled", "adaptive_failed", "adaptive_report"].includes(
      archived.kind,
    ) ||
    archived.payload.runId !== prior.id ||
    archived.payload.paperSha256 !== prior.paperSha256
  )
    throw Error("Continuation archive does not belong to the settled review");
  for (const t of prior.tasks.filter((t) => t.childRunId)) {
    const c = await store.getRun(t.childRunId);
    if (
      ["running", "preparing", "awaiting_confirmation"].includes(c.status) ||
      c.parentReviewId !== prior.id ||
      c.parentTaskId !== t.id ||
      c.paperSha256 !== prior.paperSha256
    )
      throw Error("Continuation child is unfinished or has a foreign identity");
  }
  const createdAt = new Date().toISOString();
  const inheritedReservations = [];
  for (const e of prior.modelBudget?.entries || []) {
    if (!e.receipt) continue;
    const receipt = await store.get(e.receipt);
    if (
      !archived.inputs.includes(e.receipt) ||
      receipt.kind !== "review_budget_receipt" ||
      receipt.payload.reservation !== e.id
    )
      throw Error(
        "Inherited budget receipt is not bound to the archived review",
      );
    inheritedReservations.push({
      id: e.id,
      receipt: e.receipt,
      reviewId: receipt.payload.reviewId,
      entryHash: digest(e),
    });
  }
  const unknownEntries = (prior.modelBudget?.entries || []).filter(
    (e) => e.state === "unknown",
  );
  const blockedActions = [...(prior.continuation?.blockedActions || [])];
  for (const e of unknownEntries) {
    const t = prior.tasks.find(
      (t) => t.id === e.taskId || t.childRunId === e.ownerRunId,
    );
    if (!t?.claimId || !ACTIONS[t.kind])
      throw Error(
        "Unclassified unknown outcome prevents automatic continuation",
      );
    if (
      !blockedActions.some((b) => b.claimId === t.claimId && b.kind === t.kind)
    )
      blockedActions.push({
        claimId: t.claimId,
        kind: t.kind,
        taskId: t.id,
        requestId: e.requestId,
      });
  }
  const eligible = prior.claims.filter(
    (c) =>
      c.formalResult?.status === "blocked" &&
      !c.formalResult.contract &&
      !blockedActions.some((b) => b.claimId === c.id && b.kind === "formalize"),
  );
  if (!eligible.length)
    throw Error(
      "No known failed translation is eligible for this repair continuation",
    );
  const origin = {
    previousRunId: prior.id,
    previousRoot,
    previousRunSha256: digest(prior),
    paperSha256: prior.paperSha256,
    implementationBefore,
    implementationAfter,
    createdAt,
    inheritedBudget: budgetSnapshot(prior),
    inheritedReservations,
    budgetStartedAt: prior.budgetStartedAt || prior.createdAt,
    retryClaimIds: eligible.map((c) => c.id),
    blockedActions,
    scope: "same_session_continuation_not_a_fresh_sample",
    suppliedMathematicalEdits: 0,
    replayUnknown: false,
  };
  const originArtifact = await store.put("paper_continuation_origin", origin, [
    previousRoot,
  ]);
  const next = structuredClone(prior);
  Object.assign(next, {
    id: randomUUID(),
    continuedFrom: prior.id,
    createdAt,
    updatedAt: createdAt,
    budgetStartedAt: origin.budgetStartedAt,
    continuation: { ...origin, originArtifact },
    status: "paused",
    pauseRequested: true,
    waitReason: "修复后的续跑已准备，尚未派发",
    root: null,
    failureRoot: null,
    conclusion: null,
    error: null,
    termination: null,
    stopReason: null,
    finishAt: null,
    lastDecisionEvidence: null,
    infrastructureFailure: null,
    events: [],
    revision: 0,
    recoveryAttempts: [],
  });
  // Keep received failures and roots; do not attach old mutable children to a
  // new parent or silently resume a private SDK checkpoint in a new process.
  for (const t of next.tasks) {
    t.inheritedFrom = {
      reviewId: prior.id,
      taskId: t.id,
      childRunId: t.childRunId || null,
      status: t.status,
    };
    // Generic /resume requeues interrupted tasks. Historical work is evidence,
    // not an implicit authorization to replay a request with an unknown result.
    if (t.status === "interrupted") t.status = "cancelled";
    delete t.childRunId;
    t.childFinal = true;
    if (t.kind === "environment_probe")
      t.key = `inherited:${prior.id}:${t.key}`;
  }
  const originTask = {
    id: randomUUID(),
    key: `continuation:${prior.id}`,
    kind: "continuation",
    title: "保留已有证据，继续核查未解决问题",
    status: "succeeded",
    createdAt,
    endedAt: createdAt,
    output: originArtifact,
    inputs: [previousRoot],
    parents: [],
  };
  next.tasks.push(originTask);
  for (const c of next.claims) {
    if (!eligible.some((e) => e.id === c.id)) continue;
    c.previousFormalizationStalled = c.formalizationStalled || null;
    delete c.formalizationStalled;
    next.tasks.push({
      ...ACTIONS.formalize,
      id: randomUUID(),
      // task() selects by key, so a later continuation must not select a
      // cancelled historical task instead of its newly queued replacement.
      key: `continuation:${prior.id}:formalize:${c.id}`,
      kind: "formalize",
      claimId: c.id,
      title: `继续形式化 ${c.label}`,
      question:
        "在修复后的工具阶段与原文定位协议下，忠实形式化同一完整命题；无法表达时保留具体失败。",
      reason: "实现版本已改变；原失败保持归档，重新执行来源、原生和语义核查。",
      strategy: "保留完整范围和原始定位片段，不增加假设。",
      status: "queued",
      createdAt,
      attempts: [],
      attempt: 0,
      output: null,
      parents: [originTask.id],
      basedOn: [originTask.id],
      inputs: [originArtifact, next.sourceArtifact],
      anchors: [c.anchor],
    });
  }
  await store.saveRun(next);
  return next;
}

export function unknownContinuationAction(run, action) {
  return (
    run.continuation?.blockedActions?.some(
      (b) => b.kind === action.kind && b.claimId === action.claimId,
    ) || false
  );
}
