import { randomUUID } from "node:crypto";
import { unknownModelOutcome } from "./model-delivery.mjs";
const charged = new Set(["dispatching", "received", "unknown"]);
const pending = new Set(["reserved", "dispatching"]);
export function budgetSnapshot(r) {
  const b = r.modelBudget;
  const entries = b?.entries || [];
  const used =
    (b?.legacyCalls ?? r.modelCalls ?? 0) +
    entries.filter((x) => charged.has(x.state)).length;
  const reserved = entries.filter((x) => x.state === "reserved").length;
  return {
    maxCalls: r.limits?.maxModelCalls ?? 0,
    used,
    reserved,
    inFlight: entries.filter((x) => pending.has(x.state)).length,
    remainingCalls: Math.max(
      0,
      (r.limits?.maxModelCalls ?? 0) - used - reserved,
    ),
    remainingMs:
      r.limits?.maxRunMs && r.createdAt
        ? Math.max(
            0,
            r.limits.maxRunMs -
              (Date.now() - Date.parse(r.budgetStartedAt || r.createdAt)),
          )
        : null,
  };
}
export function budgetError(r, reason = "model_calls") {
  r.budgetStop = {
    reason,
    at: new Date().toISOString(),
    remaining: budgetSnapshot(r),
  };
  const message = ["closure_reserve", "closure_time_reserve"].includes(reason)
    ? "剩余额度已保留给必需语义复核，本次请求未发送。"
    : reason === "wall_time"
      ? "本轮运行预算耗尽，未发起模型请求。"
      : "本轮模型调用预算耗尽，未发起模型请求。";
  return Object.assign(Error(message), {
    recoveryStop: "review_budget_exhausted",
    modelRecord: {
      role: null,
      request: null,
      requestId: null,
      content: null,
      resource: { executionStarted: false },
      error: {
        code: "model_budget_exhausted",
        message,
        delivery: { outcome: "not_sent" },
      },
    },
  });
}
export function reserveRequest(r, meta) {
  const snapshot = budgetSnapshot(r);
  if (snapshot.remainingMs === 0) throw budgetError(r, "wall_time");
  if (!snapshot.remainingCalls) throw budgetError(r);
  if (snapshot.remainingCalls <= (meta.protectedCalls || 0))
    throw budgetError(r, "closure_reserve");
  if (
    meta.protectedMs &&
    snapshot.remainingMs !== null &&
    snapshot.remainingMs <= meta.protectedMs
  )
    throw budgetError(r, "closure_time_reserve");
  r.modelBudget ||= {
    schemaVersion: "lemma.review-budget.v1",
    legacyCalls: r.modelCalls || 0,
    entries: [],
  };
  const entry = {
    id: randomUUID(),
    ...meta,
    state: "reserved",
    reservedAt: new Date().toISOString(),
    requestId: null,
    receipt: null,
  };
  r.modelBudget.entries.push(entry);
  return entry.id;
}
export function dispatchRequest(r, id) {
  const e = r.modelBudget.entries.find((e) => e.id === id);
  if (e.state !== "reserved")
    throw Error("Request reservation already consumed");
  if (budgetSnapshot(r).remainingMs === 0) throw budgetError(r, "wall_time");
  const remainingMs = budgetSnapshot(r).remainingMs;
  if (e.protectedMs && remainingMs !== null && remainingMs <= e.protectedMs)
    throw budgetError(r, "closure_time_reserve");
  e.state = "dispatching";
  e.dispatchedAt = new Date().toISOString();
  r.modelCalls = budgetSnapshot(r).used;
}
export function settleRequest(r, id, record, error, receipt) {
  const e = r.modelBudget.entries.find((e) => e.id === id);
  // A complete receipt, including malformed JSON or length, is a known result.
  const unsent =
    record?.error?.delivery?.outcome === "not_sent" ||
    record?.resource?.executionStarted === false ||
    (!record && e.state === "reserved");
  e.state = unsent
    ? "not_sent"
    : error && (!record || unknownModelOutcome(record))
      ? "unknown"
      : "received";
  e.endedAt = new Date().toISOString();
  e.requestId = record?.requestId || null;
  e.receipt = receipt || null;
  e.finishReason = record?.finishReason || null;
  e.errorCode = record?.error?.code || null;
  e.usage = record?.usage || null;
  e.observedElapsedMs = record?.elapsedMs ?? null;
  e.observedQueueMs = record?.resource?.queueMs ?? null;
  e.reserveEstimateScope = e.protectedMs
    ? "remaining_independent_audits_not_current_request_duration"
    : null;
  r.modelCalls = budgetSnapshot(r).used;
}
// Every wrapper for a store shares one lock per parent review. Counter updates
// and persistence are serialized across outer calls, SDK turns and provers.
const locks = new WeakMap();
export async function withBudgetLock(store, id, fn) {
  if (!locks.has(store)) locks.set(store, new Map());
  const map = locks.get(store);
  const prior = map.get(id) || Promise.resolve();
  const work = prior.catch(() => {}).then(fn);
  map.set(id, work);
  try {
    return await work;
  } finally {
    if (map.get(id) === work) map.delete(id);
  }
}

// Reserve only obligations already implied by the active evidence path.
// An original-route proof attempt retains one subsequent independent audit.
export function protectedReviewCalls(owner, request, task) {
  if (!owner?.parentReviewId && owner?.admissionBudgetId)
    return request.budgetPurpose === "semantic_blind"
      ? 1
      : request.budgetPurpose === "semantic_comparison"
        ? 0
        : 2;
  if (!owner?.parentReviewId) return 0;
  if (!owner.semanticReview)
    return request.budgetPurpose === "semantic_blind"
      ? 3 // comparison, one theorem candidate, one source-route audit
      : request.role === "R04"
        ? 2
        : 4; // both semantic stages and both mathematical obligations
  const role = task?.role || request.role || "";
  return role.startsWith("R06_") && !role.endsWith("_AUDIT") ? 1 : 0;
}

// Estimate only from completed exchanges in this review, never from future data.
// Cold start is an explicit conservative estimate, not an SLA or reserved token spend.
export function closureTimeReserve(parent, calls) {
  if (!calls) return 0;
  const samples = (parent.modelBudget?.entries || [])
    .filter((e) => e.state === "received" && e.dispatchedAt && e.endedAt)
    .map((e) => Date.parse(e.endedAt) - Date.parse(e.dispatchedAt))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const estimate = Math.max(
    30000,
    samples[Math.max(0, Math.ceil(samples.length * 0.9) - 1)] || 0,
  );
  return Math.ceil(estimate * calls) + 10000;
}
export const optionalBeforeFidelity = (kind) =>
  [
    "inspect_definitions",
    "inspect_proof",
    "counterexample",
    "reconstruct_proof",
  ].includes(kind);
export function deferOptionalAction(r, action) {
  if (!optionalBeforeFidelity(action.kind)) return null;
  const claim = r.claims.find((c) => c.id === action.claimId);
  if (
    r.reviewScope?.maxSelectedClaims === 1 &&
    (r.tasks.some(
      (t) =>
        t.claimId === action.claimId &&
        [
          "formalize",
          "recover_domain",
          "retry_translation",
          "resolve_scope",
        ].includes(t.kind) &&
        ["queued", "running", "recovering", "awaiting_confirmation"].includes(
          t.status,
        ),
    ) ||
      (claim?.formalResult && !claim.formalResult.approval))
  )
    return "selected_target_fidelity_pending";
  const b = budgetSnapshot(r);
  if (
    b.remainingCalls <= 2 ||
    (b.remainingMs !== null && b.remainingMs <= closureTimeReserve(r, 2))
  )
    return "closure_capacity_reserved";
  return null;
}
