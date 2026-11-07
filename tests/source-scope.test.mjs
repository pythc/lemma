import test from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "../server/evidence.mjs";
import { anchorInContext } from "../server/context.mjs";
import {
  propositionScope,
  reviewPropositionScope,
  validateStoredScope,
} from "../server/source-scope.mjs";
const context = {
  paperSha256: sha256("independent multi-page source fixture"),
  pages: [
    { pageIndex: 0, text: "Theorem Q. If x is an element of S," },
    {
      pageIndex: 1,
      text: "then f(x) belongs to T. Proof. The argument follows.",
    },
  ],
  supplements: [],
};
const locator = anchorInContext({ pageIndex: 0, quote: "Theorem Q." }, context);
const proposal = {
  spans: [
    { pageIndex: 0, quote: context.pages[0].text },
    { pageIndex: 1, quote: "then f(x) belongs to T." },
  ],
  premises: [{ pageIndex: 0, quote: "If x is an element of S," }],
  conclusion: [{ pageIndex: 1, quote: "then f(x) belongs to T." }],
  explanation: "The statement continues across the page break.",
};
test("cross-page proposition spans remain distinct from a short locator and replay against source", () => {
  const scope = propositionScope(proposal, context, locator);
  assert.equal(scope.spans.length, 2);
  assert.equal(scope.locator.quote, "Theorem Q.");
  assert.deepEqual(validateStoredScope(scope, context), scope);
  assert.equal(
    reviewPropositionScope(
      {
        scopeHash: scope.scopeHash,
        decision: "complete",
        explanation: "The premise and conclusion are present.",
        anchors: [proposal.spans[1]],
      },
      scope,
      context,
    ).authority,
    "independent_agent_not_human_or_kernel",
  );
});
test("scope changes keep predecessor identities and cannot move to another proposition", () => {
  const first = propositionScope(proposal, context, locator);
  const next = propositionScope(
    { ...proposal, explanation: "Independently selected complete statement." },
    context,
    locator,
    first,
  );
  assert.equal(next.previousScope, first.scopeHash);
  assert.notEqual(next.scopeHash, first.scopeHash);
  assert.throws(
    () =>
      propositionScope(
        { ...proposal, spans: [proposal.spans[1]] },
        context,
        locator,
      ),
    /定位片段/,
  );
});
test("scope validation rejects fabricated conclusions, out-of-range premises, overlaps and changed papers", () => {
  assert.throws(() =>
    propositionScope(
      {
        ...proposal,
        conclusion: [{ pageIndex: 1, quote: "then f(x) belongs to U." }],
      },
      context,
      locator,
    ),
  );
  assert.throws(
    () =>
      propositionScope(
        {
          ...proposal,
          conclusion: [{ pageIndex: 1, quote: "Proof. The argument follows." }],
        },
        context,
        locator,
      ),
    /范围内/,
  );
  assert.throws(
    () =>
      propositionScope(
        { ...proposal, spans: [proposal.spans[0], proposal.spans[0]] },
        context,
        locator,
      ),
    /重叠/,
  );
  const scope = propositionScope(proposal, context, locator);
  assert.throws(
    () =>
      validateStoredScope(scope, {
        ...context,
        paperSha256: sha256("other paper"),
      }),
    /身份/,
  );
  assert.throws(
    () => validateStoredScope({ ...scope, conclusion: [] }, context),
    /摘要/,
  );
});
test("an incomplete independent scope assessment stays incomplete and cannot reuse another scope", () => {
  const scope = propositionScope(proposal, context, locator);
  assert.equal(
    reviewPropositionScope(
      {
        scopeHash: scope.scopeHash,
        decision: "incomplete",
        explanation: "An endpoint condition requires more source text.",
        anchors: [proposal.spans[0]],
      },
      scope,
      context,
    ).decision,
    "incomplete",
  );
  assert.throws(() =>
    reviewPropositionScope(
      { scopeHash: sha256("foreign"), decision: "complete" },
      scope,
      context,
    ),
  );
});

test("scope recovery identity ignores wording and whitespace, but changes with actual source selections", async () => {
  const { scopeFailureFingerprint } =
    await import("../server/source-scope.mjs");
  const a = scopeFailureFingerprint(proposal, locator, "out of range");
  assert.equal(
    scopeFailureFingerprint(
      {
        ...proposal,
        explanation: "new wording",
        premises: proposal.premises.map((a) => ({
          ...a,
          quote: a.quote.replaceAll(" ", "  "),
        })),
      },
      locator,
      "out of range",
    ),
    a,
  );
  assert.notEqual(
    scopeFailureFingerprint(
      { ...proposal, spans: [proposal.spans[0]] },
      locator,
      "out of range",
    ),
    a,
  );
});
