import { remainingPathEstimate } from "./path-budget.mjs";
import { budgetSnapshot } from "./review-budget.mjs";
// Local slices consume the existing parent allowance. They neither increase nor
// replace product ceilings. Unused time/calls remain available to later duties.
export function obligationAllowance(
  parent,
  first,
  owner = {},
  kind = "theorem",
) {
  const b = budgetSnapshot(parent),
    remainingMs = b.remainingMs ?? 12 * 3600000;
  const current = remainingPathEstimate(parent, owner, { phase: kind });
  const other = first
    ? remainingPathEstimate(parent, owner, {
        phase: kind === "theorem" ? "author_route" : "theorem",
        other: kind === "theorem",
      })
    : null;
  const nativeAndArchiveMs = current.native.archive.ms;
  const otherObligationReserveMs = other?.requiredMs || 0;
  return {
    maxCalls: Math.max(0, b.remainingCalls - (other?.modelCalls || 0)),
    maxElapsedMs: Math.max(
      1,
      Math.floor(remainingMs - nativeAndArchiveMs - otherObligationReserveMs),
    ),
    parentSnapshot: b,
    feasibleMinimum:
      current.feasibleMinimum === null || other?.feasibleMinimum === null
        ? null
        : b.remainingCalls >= current.modelCalls + (other?.modelCalls || 0) &&
          remainingMs >= current.requiredMs + otherObligationReserveMs,
    capacity: current.capacity,
    pathEstimate: current,
    reserve: {
      nativeAndArchiveMs,
      otherObligationReserveMs,
      other,
      method: "remaining_required_path_observed_native_and_model_costs",
    },
  };
}
export function phaseBudgetError(reason) {
  return Object.assign(
    Error(`当前义务阶段容量不足：${reason}；已保留其他义务的额度。`),
    {
      recoveryStop: "obligation_budget_exhausted",
      modelRecord: {
        resource: { executionStarted: false },
        error: {
          code: "obligation_budget_exhausted",
          delivery: { outcome: "not_sent" },
        },
      },
    },
  );
}
export function reserveObligation(owner) {
  const p = owner?.activeObligation;
  if (!p) return;
  if (p.closed || Date.now() >= p.deadlineAt)
    throw phaseBudgetError("deadline");
  if (p.reservedCalls >= p.maxCalls) throw phaseBudgetError("model_calls");
  p.reservedCalls++;
}
export function guardObligation(owner) {
  const p = owner?.activeObligation;
  if (p && (p.closed || Date.now() >= p.deadlineAt))
    throw phaseBudgetError("deadline_after_queue");
}
