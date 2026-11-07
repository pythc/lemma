import test from "node:test";
import assert from "node:assert/strict";
import { anchorInContext } from "../server/context.mjs";
import {
  sourceAnchorIndex,
  ANCHOR_PROTOCOL,
} from "../server/source-anchor-index.mjs";
import {
  NATIVE_AUDIT_PROTOCOL,
  INDEXED_ANCHOR_V2,
  validateAuditWire,
} from "../server/audit-wire.mjs";
import { digest } from "../server/evidence.mjs";
import { sourceAuditFixture } from "./source-audit-fixture.mjs";
const quote = "For every integer x, x = x.",
  contract = {
    paperSha256: digest("paper"),
    targetHash: digest("target"),
    pageIndex: 0,
    quote,
    leanTarget: "∀ x : Int, x=x",
  };
const context = {
  paperSha256: contract.paperSha256,
  selectedPage: 0,
  pages: [{ pageIndex: 0, text: quote }],
  supplements: [],
  anchorProtocol: INDEXED_ANCHOR_V2,
  semanticProtocol: NATIVE_AUDIT_PROTOCOL,
};
test("versioned string references cannot use legacy protocol, foreign paper or forged catalog", () => {
  const id = sourceAnchorIndex(context)[0].anchorId;
  assert.equal(anchorInContext(id, context).quote, quote);
  assert.throws(
    () => anchorInContext(id, { ...context, anchorProtocol: ANCHOR_PROTOCOL }),
    /编码/,
  );
  assert.throws(
    () => anchorInContext(id, { ...context, paperSha256: digest("foreign") }),
    /当前固定原文/,
  );
  assert.throws(
    () =>
      anchorInContext("f".repeat(20), {
        ...context,
        anchorIndex: [{ anchorId: "f".repeat(20), quote }],
      }),
    /当前固定原文/,
  );
  assert.equal(
    anchorInContext(
      { anchorId: id },
      { ...context, anchorProtocol: ANCHOR_PROTOCOL },
    ).quote,
    quote,
  );
});
test("canonical response schema rejects wrong encoding, absent bindings and invented fields", () => {
  const structure = {
    quantifiers: [{ id: "root", name: "x", kind: "forall", scope: [] }],
  };
  const response = {
    targetHash: contract.targetHash,
    backTranslation: quote,
    checks: [
      "variables",
      "quantifiers",
      "domain",
      "assumptions",
      "conclusion",
      "definitions",
    ].map((category) => ({
      category,
      status: "aligned",
      explanation: "Explicit fixture only.",
      anchors: [sourceAnchorIndex(context)[0].anchorId],
    })),
    sourceAudit: sourceAuditFixture(contract, structure),
  };
  validateAuditWire(response);
  const wrong = structuredClone(response);
  wrong.checks[0].anchors = [
    { anchorId: sourceAnchorIndex(context)[0].anchorId },
  ];
  assert.throws(
    () => validateAuditWire(wrong),
    (e) => e.auditValidation.issues[0].path === "checks.0.anchors.0",
  );
  const missing = structuredClone(response);
  delete missing.sourceAudit.quantifiers[0].binderId;
  assert.throws(() => validateAuditWire(missing), /协议/);
  const extra = structuredClone(response);
  extra.sourceAudit.proved = true;
  assert.throws(() => validateAuditWire(extra), /协议/);
});
