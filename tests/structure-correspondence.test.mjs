import test from "node:test";
import assert from "node:assert/strict";
import { adjudicateFidelity } from "../server/epistemic-audit.mjs";
import { WITNESS_AUDIT_PROTOCOL } from "../server/audit-wire.mjs";
const quote =
  "Every integer is nonnegative after squaring, and there exists an integer equal to four.";
const context = {
  semanticProtocol: WITNESS_AUDIT_PROTOCOL,
  pages: [{ pageIndex: 0, text: quote }],
  supplements: [],
};
const contract = { leanTarget: "∀ x : Int, x*x ≥ 0 ∧ ∃ y : Int, y = 4" };
const finding = (effect) => ({
  kind: "established_change",
  category: "quantifiers",
  anchors: [{ pageIndex: 0, quote }],
  targetFragment: contract.leanTarget,
  missingSymbols: [],
  independentOfMissing: true,
  basis: "Controlled structural witness.",
  changeWitness: {
    kind: "quantifiers",
    sourceAnchorIndex: 0,
    sourceFragment: quote,
    effect,
  },
});
test("a structure-only witness cannot establish mathematical difference or acceptance", () => {
  const r = adjudicateFidelity(
    contract,
    context,
    [
      {
        checks: [{ status: "concern" }],
        findings: [finding("structure_only")],
      },
    ],
    [],
  );
  assert.equal(r.fidelity, "unknown");
  assert.equal(r.admission, "blocked");
  assert.equal(
    r.findings[0].evidenceIssues[0].code,
    "structure_is_not_mathematical_difference",
  );
  const old = adjudicateFidelity(
    contract,
    { ...context, semanticProtocol: "lemma.source-audit.v6" },
    [
      {
        checks: [{ status: "concern" }],
        findings: [finding("structure_only")],
      },
    ],
    [],
  );
  assert.equal(old.fidelity, "changed", "Old adjudication is not rewritten");
  const difference = adjudicateFidelity(
    contract,
    context,
    [
      {
        checks: [{ status: "concern" }],
        findings: [finding("mathematical_difference")],
      },
    ],
    [],
  );
  assert.equal(difference.fidelity, "changed");
  assert.equal(difference.admission, "blocked");
});
