// Execution stopping, mathematical resolution and durable archival are separate.
// This module is also a read-only interpretation of legacy records.
export const COMPLETION_VERSION = "lemma.review-completion.v2";
export const terminalRun = (run) =>
  ["completed", "blocked", "cancelled", "interrupted", "incomplete"].includes(
    run?.status,
  );
export function terminationCause(error, fallback = "unresolved_obligations") {
  const record = error?.modelRecord;
  if (
    record?.error?.code === "model_http_error" &&
    record?.http?.status === 402
  )
    return "provider_account_blocked";
  if (record?.finishReason === "length") return "generation_truncated";
  if (record?.error?.delivery?.outcome === "unknown")
    return "external_outcome_unknown";
  if (error?.recoveryStop === "review_budget_exhausted")
    return "budget_exhausted";
  if (
    error?.auditValidation ||
    /schema|协议|结构|JSON/i.test(error?.message || "")
  )
    return "schema_invalid";
  return fallback;
}
export function claimObligations(run) {
  const c = run?.conclusion || {};
  const route = run?.originalProofRoute;
  const sourceMissing =
    route?.summary?.status === "source_proof_missing" && !!route.root;
  const routeResolved =
    !!route?.root &&
    (["verified_route", "verified_with_completion"].includes(
      route?.summary?.status,
    ) ||
      (route?.summary?.status === "has_problem" &&
        (route.summary.counts?.problem || 0) > 0));
  return [
    {
      kind: "fidelity",
      resolved:
        ["agent_reviewed", "human_confirmed"].includes(c.semantic) &&
        !!(run?.semanticArtifact || run?.approvalArtifact),
      evidence: run?.semanticArtifact || run?.approvalArtifact || null,
    },
    {
      kind: "theorem",
      resolved:
        ["formalized_proved", "refuted"].includes(c.theorem) &&
        !!run?.checkArtifact &&
        run?.check?.status === "verified" &&
        run.check.targetHash === run.contract?.targetHash,
      evidence: run?.checkArtifact || null,
    },
    {
      kind: "author_route",
      resolved: routeResolved || sourceMissing,
      result: sourceMissing
        ? "source_proof_missing"
        : route?.summary?.status || "unverified",
      evidence: route?.root || null,
    },
  ].filter(
    (o) =>
      !run?.requiredObligations || run.requiredObligations.includes(o.kind),
  );
}
export function reviewCompletion(run) {
  const selectedIds = Array.isArray(run.reviewScope?.selectedClaimIds)
    ? run.reviewScope.selectedClaimIds
    : null;
  const limit = run.reviewScope?.maxSelectedClaims;
  const bounded = Number.isSafeInteger(limit) && limit > 0;
  // An environment choice is not permission to narrow a full-paper review.
  // Only an explicitly bounded scope may exclude identified source claims.
  const selected = Array.isArray(run.claims)
    ? run.claims.filter(
        (c) => !bounded || !selectedIds || selectedIds.includes(c.id),
      )
    : null;
  const obligations = selected
    ? selected.flatMap((c) =>
        claimObligations(c.formalResult).map((o) => ({
          ...o,
          claimId: c.id,
          evidence: o.evidence || c.formalArtifact || null,
        })),
      )
    : claimObligations(run);
  // Missing selected IDs and an empty scope cannot be silently counted as closed.
  if (
    selected &&
    (!selected.length ||
      selectedIds?.some((id) => !selected.some((c) => c.id === id)))
  )
    obligations.push({
      kind: "selected_scope",
      resolved: false,
      evidence: run.reviewScopeArtifact || null,
    });
  if (
    selected &&
    ((bounded && (!selectedIds || selectedIds.length > limit)) ||
      (limit != null && !bounded) ||
      (selectedIds && new Set(selectedIds).size !== selectedIds.length))
  )
    obligations.push({
      kind: "invalid_scope",
      resolved: false,
      evidence: run.reviewScopeArtifact || null,
    });
  const unresolved = obligations.filter((o) => !o.resolved);
  const cause =
    run.status === "cancelled"
      ? "cancelled"
      : run.infrastructureFailure
        ? run.infrastructureFailure.kind === "provider_account_blocked"
          ? "provider_account_blocked"
          : "infrastructure_interrupted"
        : run.budgetStop
          ? "budget_exhausted"
          : run.termination?.cause ||
            (/(?:截断|length)/i.test(run.stopReason || "")
              ? "generation_truncated"
              : /协调未产生有效新计划/.test(run.stopReason || "")
                ? "no_actionable_plan"
                : unresolved.length
                  ? "unresolved_obligations"
                  : "obligations_resolved");
  return {
    schemaVersion: COMPLETION_VERSION,
    coverageScope:
      selected && !bounded ? "all_identified_claims" : "selected_claims",
    reviewComplete: unresolved.length === 0,
    executionOutcome: cause,
    obligations,
    unresolved,
  };
}
