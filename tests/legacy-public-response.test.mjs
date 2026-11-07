import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validateStructuredAttempts,
  structuredReviewCall,
} from "../server/structured-review.mjs";
import { verifyAuditEnvelope } from "../server/audit-envelope.mjs";
import { callModel } from "../server/model.mjs";
import { PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL } from "../server/strict-audit.mjs";

test("historical v3 public-response receipt retains its original replay interpretation", async () => {
  const a = JSON.parse(
    await readFile(
      new URL("./fixtures/strict-v3-receipt.json", import.meta.url),
      "utf8",
    ),
  );
  const input = JSON.parse(
    a.model.request.messages.find((m) => m.role === "user").content,
  );
  assert.equal(
    input.context.auditBindingProtocol,
    PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL,
  );
  validateStructuredAttempts([a], input, a.response, a.model);
  verifyAuditEnvelope(a.response, a.model, input);
});
test("previous v3 cannot issue fresh requests at either application entry", async () => {
  let called = false;
  const input = {
    context: { auditBindingProtocol: PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL },
  };
  await assert.rejects(
    structuredReviewCall(
      async () => {
        called = true;
      },
      null,
      { input },
      () => {},
    ),
    /archived replay only/,
  );
  assert.equal(called, false);
  await assert.rejects(
    callModel(null, {
      auditRequestBinding: { protocol: PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL },
    }),
    /archived replay only/,
  );
});
