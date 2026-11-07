import test from "node:test";
import assert from "node:assert/strict";
import { anchorInContext, resolveContextAnchor } from "../server/context.mjs";
import { digest } from "../server/evidence.mjs";
import {
  validateAlignment,
  validateAgentResolutions,
} from "../server/semantics.mjs";

const claim =
  "If there is no convergent subsequence, there exists ε > 0 with finitely many terms.";
const context = {
  pages: [
    { pageIndex: 2, text: "For any ε > 0, a sequence converges. The band is" },
    {
      pageIndex: 3,
      text: `called ε-band. For every ε > 0 consider convergence. ${claim}`,
    },
  ],
  supplements: [],
  omittedPages: [],
};
const focusAnchor = { pageIndex: 3, quote: claim };

test("duplicate epsilon quotes resolve only within the exact fixed claim and replay strictly", () => {
  const repairs = [];
  const a = resolveContextAnchor({ pageIndex: 3, quote: "ε > 0" }, context, {
    focusAnchor,
    repairs,
  });
  assert.deepEqual(a, anchorInContext(a, context));
  assert.equal(a.pageIndex, 3);
  assert.match(a.quote, /no convergent subsequence/);
  assert.equal(repairs[0].method, "unique_within_fixed_claim");
  assert.throws(
    () => resolveContextAnchor({ pageIndex: 3, quote: "ε > 0" }, context),
    /3 个精确位置/,
  );
});
test("a wrong page is corrected only for an exact unique quote in the fixed context", () => {
  const repairs = [];
  const a = resolveContextAnchor(
    { pageIndex: 2, quote: "called ε-band" },
    context,
    { repairs },
  );
  assert.equal(a.pageIndex, 3);
  assert.deepEqual(a, anchorInContext(a, context));
  assert.equal(repairs[0].requested.pageIndex, 2);
  assert.throws(
    () =>
      resolveContextAnchor({ pageIndex: 2, quote: "called δ-band" }, context),
    /0 个精确位置/,
  );
});
test("bare offsets and untrusted hashes do not choose arbitrary repeated text", () => {
  const a = { pageIndex: 3, quote: "ε > 0", start: 26 };
  assert.throws(() => resolveContextAnchor(a, context));
  const body = context.pages[1].text;
  const start = body.indexOf("ε > 0");
  const found = resolveContextAnchor(
    { ...a, start, sourceTextHash: digest(body) },
    context,
  );
  assert.deepEqual(found, anchorInContext(found, context));
  assert.throws(() =>
    resolveContextAnchor({ ...a, sourceTextHash: "0".repeat(64) }, context),
  );
});
test("multiple occurrences inside the focus stay unresolved; supplements cannot be substituted", () => {
  const c = {
    pages: [{ pageIndex: 0, text: "Assume ε > 0, then choose ε > 0." }],
    supplements: [],
  };
  assert.throws(
    () =>
      resolveContextAnchor({ pageIndex: 0, quote: "ε > 0" }, c, {
        focusAnchor: { pageIndex: 0, quote: c.pages[0].text },
      }),
    /2 个精确位置/,
  );
  assert.throws(() =>
    resolveContextAnchor({ supplementId: "missing", quote: claim }, context),
  );
});
test("canonical alignment preserves the fixed Lean target and all six categories", () => {
  const contract = {
    pageIndex: 3,
    quote: claim,
    leanTarget: "∀ (f : ℕ → ℝ), True",
  };
  const raw = [
    "variables",
    "quantifiers",
    "domain",
    "assumptions",
    "conclusion",
    "definitions",
  ].map((category) => ({
    category,
    leanFragment: "f : ℕ → ℝ",
    explanation: "Fixture source mapping only.",
    anchors: [{ pageIndex: 3, quote: "ε > 0" }],
  }));
  const repairs = [],
    before = structuredClone(contract);
  const aligned = validateAlignment(raw, contract, context, repairs);
  assert.equal(aligned.length, 6);
  assert.equal(repairs.length, 6);
  assert.deepEqual(contract, before);
  assert.deepEqual(validateAlignment(aligned, contract, context), aligned);
});

test("complete keyed alignment is normalized without supplying semantic content", () => {
  const contract = {
    pageIndex: 3,
    quote: claim,
    leanTarget: "∀ (f : ℕ → ℝ), True",
  };
  const entries = [
    "variables",
    "quantifiers",
    "domain",
    "assumptions",
    "conclusion",
    "definitions",
  ].map((category) => ({
    category,
    leanFragment: "f : ℕ → ℝ",
    explanation: "Fixture source mapping only.",
    anchors: [{ pageIndex: 3, quote: claim }],
  }));
  const raw = Object.fromEntries(
    entries.map(({ category, ...value }) => [category, value]),
  );
  const before = structuredClone(raw),
    repairs = [];
  assert.deepEqual(
    validateAlignment(raw, contract, context, repairs),
    validateAlignment(entries, contract, context),
  );
  assert.deepEqual(raw, before);
  assert.deepEqual(repairs, [
    {
      method: "six_category_object_to_array",
      scope: "representation_only_no_semantic_content_added",
    },
  ]);
  for (const broken of [
    { ...raw, variables: { ...raw.variables, category: "domain" } },
    { ...raw, variables: { ...raw.variables, leanFragment: "invented" } },
    {
      ...raw,
      variables: {
        ...raw.variables,
        anchors: [{ pageIndex: 3, quote: "not in the source" }],
      },
    },
    Object.fromEntries(Object.entries(raw).slice(1)),
  ])
    assert.throws(() => validateAlignment(broken, contract, context));
});

test("original-proof findings do not become invented semantic issues; actual issues remain mandatory", () => {
  const review = {
    targetHash: "a",
    issues: [],
    targetCheck: { status: "well_typed", targetHash: "a" },
  };
  const finding = {
    issueId: "proof-finding",
    decision: "confirmed_with_reason",
    reason: "The paper proof has a gap, but this is not a translation issue.",
  };
  assert.deepEqual(validateAgentResolutions(review, [finding]), {
    resolutions: [],
    ignoredNonSemanticResolutions: [finding],
  });
  review.issues = [{ id: "real-semantic-issue" }];
  assert.throws(() => validateAgentResolutions(review, [finding]), /逐项解决/);
  const actual = { ...finding, issueId: "real-semantic-issue" };
  assert.deepEqual(
    validateAgentResolutions(review, [finding, actual]).resolutions,
    [actual],
  );
});
