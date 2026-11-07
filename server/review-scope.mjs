import { digest } from "./evidence.mjs";
// Parse only an explicit, unnegated single-main-claim request. Arbitrary scope
// descriptions retain the existing full candidate policy. Never inspect PDF
// text, paper names or theorem labels to set a special-case scope.
export function requestedClaimLimit(intent) {
  const s = String(intent || "");
  if (
    /(?:不|不要|并非|不是|not|don't|do not)\s*(?:仅|只|just|only)?\s*(?:选择|核查|检查|choose|select|check)/i.test(
      s,
    )
  )
    return null;
  return /(?:选择|核查|检查)\s*(?:一|1)(?:个|条)(?:原文)?(?:命题|定理)|(?:choose|select|check)\s+(?:exactly\s+|only\s+)?one\s+(?:claim|theorem|proposition)/i.test(
    s,
  )
    ? 1
    : null;
}
export function selectedClaim(r, id) {
  return !r.reviewScope || r.reviewScope.selectedClaimIds.includes(id);
}
export function bindReviewScope(r, choices, reason) {
  const body = {
    schemaVersion: "lemma.review-scope.v1",
    paperSha256: r.paperSha256,
    intentHash: digest(r.reviewIntent || ""),
    maxSelectedClaims: requestedClaimLimit(r.reviewIntent),
    selectedClaimIds: choices.map((c) => c.claimId),
    reason,
    unselectedClaimIds: r.claims
      .filter((c) => !choices.some((x) => x.claimId === c.id))
      .map((c) => c.id),
    authority: "agent_selection_not_semantic_approval",
  };
  return { ...body, scopeHash: digest(body) };
}
export function coordinatorClaim(c, r) {
  const { environmentReport, formalResult, ...rest } = c;
  return {
    ...rest,
    selectedForReview: selectedClaim(r, c.id),
    environmentReport: environmentReport
      ? {
          artifact: c.environmentArtifact,
          reportHash: digest(environmentReport),
          declarationsSatisfied: environmentReport.declarationsSatisfied,
          preparationStatus: environmentReport.preparationStatus,
          unavailableDeclarations: (environmentReport.declarations || [])
            .filter((d) => d.status !== "available")
            .map((d) => ({ name: d.name, status: d.status })),
          detailPolicy:
            "read_immutable_artifact_for_exact_signatures_not_proof_evidence",
        }
      : null,
    formalResult: formalResult
      ? {
          status: formalResult.status,
          conclusion: formalResult.conclusion,
          error: formalResult.error,
        }
      : null,
  };
}
