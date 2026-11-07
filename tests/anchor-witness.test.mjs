import test from "node:test";
import assert from "node:assert/strict";
import {
  validateEpistemicFindings,
  adjudicateFidelity,
} from "../server/epistemic-audit.mjs";
import {
  ANCHORED_AUDIT_PROTOCOL,
  WITNESS_AUDIT_PROTOCOL,
  INDEXED_ANCHOR_V2,
  anchoredComparisonSchema,
  ANCHORED_COMPARISON_PROMPT,
  ANCHORED_AUDIT_PROMPT,
} from "../server/audit-wire.mjs";
import { sourceAnchorIndex } from "../server/source-anchor-index.mjs";
const quote = "For every natural number n, U(n) is at least n.";
const other = "A separate source sentence.";
const context = {
  semanticProtocol: ANCHORED_AUDIT_PROTOCOL,
  anchorProtocol: INDEXED_ANCHOR_V2,
  paperSha256: "b".repeat(64),
  pages: [
    { pageIndex: 0, text: quote },
    { pageIndex: 1, text: other },
  ],
  supplements: [],
};
const anchor = sourceAnchorIndex(context).find(
  (a) => a.quote === quote,
).anchorId;
const foreign = sourceAnchorIndex(context).find(
  (a) => a.quote === other,
).anchorId;
const contract = { leanTarget: "∃ n : Nat, n + 4 ≥ n" };
const finding = () => ({
  kind: "established_change",
  category: "quantifiers",
  anchors: [anchor],
  targetFragment: "∃ n : Nat",
  missingSymbols: [],
  independentOfMissing: true,
  basis: "Known universal to existential change.",
  changeWitness: {
    kind: "quantifiers",
    sourceAnchor: anchor,
    sourceFragment: "For every natural number n",
    effect: "mathematical_difference",
  },
});
const validate = (f) =>
  validateEpistemicFindings({ findings: [f] }, contract, context);
test("v8 direct anchor references accept a single ID or identical position object without an array index", () => {
  assert.equal(validate(finding()).length, 1);
  const f = finding();
  f.anchors = [{ pageIndex: 0, quote }];
  f.changeWitness.sourceAnchor = f.anchors[0];
  assert.equal(validate(f).length, 1);
  assert(!ANCHORED_COMPARISON_PROMPT.includes("sourceAnchorIndex"));
  assert(!ANCHORED_AUDIT_PROMPT.includes("sourceAnchorIndex"));
  const invalid = finding();
  invalid.changeWitness.sourceAnchorIndex = 0;
  assert(!anchoredComparisonSchema.shape.findings.safeParse([invalid]).success);
});
for (const [name, mutate] of [
  ["nonexistent", (f) => (f.changeWitness.sourceAnchor = "a".repeat(20))],
  ["foreign finding", (f) => (f.changeWitness.sourceAnchor = foreign)],
  ["duplicate", (f) => f.anchors.push(anchor)],
  ["duplicate ID/object alias", (f) => f.anchors.push({ pageIndex: 0, quote })],
  ["foreign fragment", (f) => (f.changeWitness.sourceFragment = other)],
  ["wrong category", (f) => (f.changeWitness.kind = "definitions")],
  ["missing symbol falsely independent", (f) => (f.missingSymbols = ["U"])],
  [
    "nearby span is not selected anchor",
    (f) =>
      (f.changeWitness.sourceAnchor = {
        pageIndex: 0,
        quote: "For every natural number n",
      }),
  ],
])
  test(`v8 rejects ${name}`, () => {
    const f = finding();
    mutate(f);
    assert.throws(() => validate(f));
  });
test("legacy v7 out-of-range witness stays failed; v8 does not infer a replacement", () => {
  const f = finding();
  delete f.changeWitness.sourceAnchor;
  f.changeWitness.sourceAnchorIndex = 1;
  assert.throws(() =>
    validateEpistemicFindings({ findings: [f] }, contract, {
      ...context,
      semanticProtocol: WITNESS_AUDIT_PROTOCOL,
    }),
  );
  assert.throws(() => validate(f));
});
test("direct known change survives missing definitions, while missing-dependent and structure-only evidence cannot establish change", () => {
  const missing = {
    ...finding(),
    kind: "source_missing",
    category: "definitions",
    targetFragment: "n + 4",
    missingSymbols: ["U"],
    independentOfMissing: false,
    changeWitness: null,
  };
  const decide = (f) =>
    adjudicateFidelity(
      contract,
      context,
      [{ checks: [{ status: "unresolved" }], findings: [missing, f] }],
      [],
    );
  assert.equal(decide(finding()).fidelity, "changed");
  const dependent = finding();
  dependent.changeWitness.sourceFragment = "U(n)";
  assert.equal(decide(dependent).fidelity, "unknown");
  const structural = finding();
  structural.changeWitness.effect = "structure_only";
  assert.equal(decide(structural).fidelity, "unknown");
});
