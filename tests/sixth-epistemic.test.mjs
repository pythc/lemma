import test from "node:test";
import assert from "node:assert/strict";
import {
  adjudicateFidelity,
  validateEpistemicFindings,
} from "../server/epistemic-audit.mjs";
import {
  EPISTEMIC_AUDIT_PROMPT,
  EPISTEMIC_COMPARISON_PROMPT,
} from "../server/audit-wire.mjs";
const context = {
  pages: [{ pageIndex: 0, text: "For every x, T(x) is positive." }],
  supplements: [],
  omittedPages: [],
};
const contract = { leanTarget: "∀ x : Nat, x > 0" };
const finding = (kind, extra = {}) => ({
  kind,
  category: "definitions",
  anchors: [{ pageIndex: 0, quote: context.pages[0].text }],
  targetFragment: "x > 0",
  missingSymbols: ["T"],
  independentOfMissing: false,
  basis: "T has no definition in the fixed source.",
  ...extra,
});
const response = (findings = [], status = "aligned") => ({
  checks: [{ status }],
  findings,
});
test("missing source blocks adoption without asserting a known change", () => {
  const r = adjudicateFidelity(
    contract,
    context,
    [response([finding("unsupported_substitution")], "concern")],
    [],
  );
  assert.equal(r.fidelity, "unknown");
  assert.equal(r.admission, "blocked");
});
test("independent witnessed change remains changed alongside missing definitions", () => {
  const r = adjudicateFidelity(
    contract,
    context,
    [
      response([
        finding("source_missing"),
        finding("established_change", {
          missingSymbols: [],
          independentOfMissing: true,
          basis: "The fixed known quantifier was changed.",
        }),
      ]),
    ],
    [],
  );
  assert.equal(r.fidelity, "changed");
  assert.equal(r.admission, "blocked");
  assert.throws(() =>
    validateEpistemicFindings(
      response([finding("established_change")]),
      contract,
      context,
    ),
  );
  assert.throws(() =>
    validateEpistemicFindings(
      response([
        finding("established_change", {
          missingSymbols: [],
          independentOfMissing: true,
          targetFragment: "False",
        }),
      ]),
      contract,
      context,
    ),
  );
});
test("source mathematical concern alone does not reject faithful translation; invalid history persists", () => {
  const r = adjudicateFidelity(
    contract,
    context,
    [response([finding("source_math_concern", { missingSymbols: [] })])],
    [],
    {
      blind: [
        {
          outcome: "schema_rejected",
          response: response([finding("source_missing")], "concern"),
        },
      ],
    },
  );
  assert.equal(r.fidelity, "preserved");
  assert.equal(r.history.length, 1);
  // Production supplies recoveryConcerns as blocking issues; history is not reclassified as an established change.
  const blocked = adjudicateFidelity(
    contract,
    context,
    [response()],
    [{ code: "prior_invalid_response_concern" }],
  );
  assert.equal(blocked.fidelity, "unknown");
});
test("assembled v4 prompts retain local bindings, quantifier dependence, vacuity and epistemic rules", () => {
  for (const p of [EPISTEMIC_AUDIT_PROMPT, EPISTEMIC_COMPARISON_PROMPT])
    for (const text of [
      "局部量词",
      "lexicalScope",
      "typeDependencies",
      "dependsOn",
      "unsupported_substitution",
      "independentOfMissing",
    ])
      assert(p.includes(text), text);
  assert(EPISTEMIC_AUDIT_PROMPT.includes("assumption_consistency"));
  assert(EPISTEMIC_AUDIT_PROMPT.includes("局部 ∀/∃ 绑定"));
});
