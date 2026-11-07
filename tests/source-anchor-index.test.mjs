import test from "node:test";
import assert from "node:assert/strict";
import {
  sourceAnchorIndex,
  ANCHOR_PROTOCOL,
} from "../server/source-anchor-index.mjs";
import { anchorInContext } from "../server/context.mjs";
import { blindSemanticInput } from "../server/semantic-blind.mjs";
import {
  coordinatorClaim,
  requestedClaimLimit,
} from "../server/review-scope.mjs";
import { digest } from "../server/evidence.mjs";
const context = {
  paperSha256: digest("paper"),
  selectedPage: 0,
  anchorProtocol: ANCHOR_PROTOCOL,
  pages: [
    {
      pageIndex: 0,
      text: "Let n be a natural number including zero.\nFor every n, n + 0 = n.",
    },
  ],
  supplements: [],
};
test("compact citation resolves only through immutable source; forged catalog, mixed fields and foreign IDs fail", () => {
  const [a] = sourceAnchorIndex(context),
    v = anchorInContext({ anchorId: a.anchorId }, context);
  assert.equal(v.quote, context.pages[0].text);
  assert.equal(v.sourceTextHash, digest(v.quote));
  assert.throws(() =>
    anchorInContext({ anchorId: a.anchorId, quote: "fake" }, context),
  );
  const foreign = { ...context, paperSha256: digest("another") };
  assert.throws(() => anchorInContext({ anchorId: a.anchorId }, foreign));
  assert.throws(() =>
    anchorInContext(
      { anchorId: "forged" },
      { ...context, anchorIndex: [{ anchorId: "forged", quote: "fake" }] },
    ),
  );
  assert.throws(() =>
    anchorInContext(
      { anchorId: a.anchorId },
      { ...context, anchorProtocol: undefined },
    ),
  );
  const input = blindSemanticInput(
    { leanTarget: "∀ n : Nat, n+0=n", targetHash: digest("target") },
    context,
  );
  assert.deepEqual(input.context.anchorIndex, sourceAnchorIndex(context));
  assert.ok(!Object.hasOwn(input, "alignment"));
});
test("coordinator projection removes full probe payload while preserving its identity and source", () => {
  const report = {
    declarationsSatisfied: false,
    declarations: [
      { name: "X", status: "missing", signature: "x".repeat(10000) },
    ],
    preparationStatus: "ready",
    diagnostics: "x".repeat(20000),
  };
  const c = { id: "c", environmentArtifact: "hash", environmentReport: report };
  const before = JSON.stringify(c);
  const projected = coordinatorClaim(c, {
    reviewScope: { selectedClaimIds: ["c"] },
  });
  assert.equal(projected.environmentReport.reportHash, digest(report));
  assert.ok(JSON.stringify(projected).length < 700);
  assert.equal(JSON.stringify(c), before);
  assert.equal(requestedClaimLimit("自主选择一个命题核查"), 1);
  assert.equal(requestedClaimLimit("不要只选择一个命题"), null);
  assert.equal(requestedClaimLimit("核查全文"), null);
});

test("explicit original-paper single-claim intent remains bounded", () => {
  assert.equal(requestedClaimLimit("自主选择一个原文命题，核查忠实性"), 1);
});
