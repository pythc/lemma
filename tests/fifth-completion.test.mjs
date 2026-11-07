import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewCompletion,
  terminationCause,
  terminalRun,
} from "../shared/review-completion.mjs";
import { reviewOutcome } from "../shared/review-outcome.mjs";
import { reviewCompletion as archivedCompletionV1 } from "../shared/review-completion-v1.mjs";
const child = () => ({
  contract: { targetHash: "target" },
  check: { status: "verified", targetHash: "target" },
  checkArtifact: "native-receipt",
  semanticArtifact: "semantic-receipt",
  conclusion: { semantic: "agent_reviewed", theorem: "formalized_proved" },
  originalProofRoute: { root: "route", summary: { status: "verified_route" } },
});
test("completion is independent of stopping, archive, scope and theorem truth", () => {
  for (const status of ["completed", "blocked", "cancelled", "interrupted"]) {
    const r = {
      status,
      root: "immutable",
      conclusion: {},
      claims: [{ id: "a" }],
    };
    assert.equal(reviewCompletion(r).reviewComplete, false);
    assert.equal(reviewOutcome(r).interrupted, true);
    assert.equal(reviewOutcome(r).hasReport, true);
  }
  const r = {
    status: "completed",
    claims: [{ id: "a", formalResult: child() }, { id: "unselected" }],
    reviewScope: { selectedClaimIds: ["a"], maxSelectedClaims: 1 },
  };
  assert.equal(reviewCompletion(r).reviewComplete, true);
  r.claims[0].formalResult.conclusion.theorem = "refuted";
  assert.equal(reviewCompletion(r).reviewComplete, true);
  r.claims[0].formalResult.originalProofRoute.summary.status =
    "source_proof_missing";
  assert.equal(
    reviewCompletion(r).obligations.at(-1).result,
    "source_proof_missing",
  );
  assert.equal(reviewCompletion(r).reviewComplete, true);
  delete r.claims[0].formalResult.originalProofRoute.root;
  assert.equal(reviewCompletion(r).reviewComplete, false);
  r.reviewScope.selectedClaimIds.push("missing");
  assert(
    reviewCompletion(r).unresolved.some((o) => o.kind === "selected_scope"),
  );
});
test("environment selection cannot mark an unbounded paper review complete", () => {
  const r = {
    status: "completed",
    root: "old-immutable-root",
    conclusion: { reviewComplete: true },
    claims: [{ id: "a", formalResult: child() }, { id: "b" }],
    reviewScope: { selectedClaimIds: ["a"], maxSelectedClaims: null },
  };
  const before = JSON.stringify(r);
  assert.equal(archivedCompletionV1(r).reviewComplete, true);
  assert.equal(reviewCompletion(r).reviewComplete, false);
  assert.equal(reviewCompletion(r).coverageScope, "all_identified_claims");
  assert(reviewCompletion(r).unresolved.some((o) => o.claimId === "b"));
  assert.equal(reviewOutcome(r).interrupted, true);
  assert.equal(JSON.stringify(r), before, "Historical records stay unchanged");
  r.reviewScope.maxSelectedClaims = 1;
  assert.equal(reviewCompletion(r).reviewComplete, true);
  r.reviewScope.selectedClaimIds = ["a", "b"];
  r.claims[1].formalResult = child();
  assert(reviewCompletion(r).unresolved.some((o) => o.kind === "invalid_scope"));
  r.reviewScope.maxSelectedClaims = null;
  assert.equal(reviewCompletion(r).reviewComplete, true);
  delete r.reviewScope.maxSelectedClaims;
  r.claims[1].formalResult = null;
  assert.equal(reviewCompletion(r).reviewComplete, false);
  assert.equal(reviewCompletion(child()).coverageScope, "selected_claims");
});
test("typed termination preserves known truncation versus unknown exchange", () => {
  assert.equal(
    terminationCause({ modelRecord: { finishReason: "length" } }),
    "generation_truncated",
  );
  assert.equal(
    terminationCause({
      modelRecord: { error: { delivery: { outcome: "unknown" } } },
    }),
    "external_outcome_unknown",
  );
  assert(terminalRun({ status: "blocked" }));
  for (const cause of [
    "schema_invalid",
    "no_actionable_plan",
    "external_outcome_unknown",
  ])
    assert.equal(
      reviewCompletion({ status: "blocked", termination: { cause } })
        .executionOutcome,
      cause,
    );
  const missing = child();
  delete missing.checkArtifact;
  assert.equal(reviewCompletion(missing).reviewComplete, false);
});
