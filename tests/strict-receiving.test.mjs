import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyAuditEnvelope } from "../server/audit-envelope.mjs";
import {
  validateStructuredAttempts,
  structuredReviewCall,
} from "../server/structured-review.mjs";
import { parseUniqueJson } from "../server/unique-json.mjs";
import {
  validateStrictResponseShape,
  verifyStrictResponseReceipt,
} from "../server/strict-response.mjs";
import { callModel } from "../server/model.mjs";
import { LEGACY_STRICT_AUDIT_BINDING_PROTOCOL } from "../server/strict-audit.mjs";
const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/strict-tools-v2-receipts.json", import.meta.url),
    "utf8",
  ),
);
for (const row of fixture.cases)
  test(
    "old v2 archive retains historical interpretation, current policy is separate: " +
      row.name,
    () => {
      const a = row.attempt,
        input = JSON.parse(
          a.model.request.messages.find((m) => m.role === "user").content,
        );
      assert.equal(
        input.context.auditBindingProtocol,
        LEGACY_STRICT_AUDIT_BINDING_PROTOCOL,
      );
      validateStructuredAttempts([a], input, a.response, a.model);
      verifyAuditEnvelope(a.response, a.model, input);
      // Old receipts do not contain the new complete-public-response attestation.
      assert.throws(() => verifyStrictResponseReceipt(a.model), /receipt/);
      const currentCheck = () => {
        const choice = validateStrictResponseShape(
          parseUniqueJson(JSON.stringify(row.response)),
        );
        parseUniqueJson(choice.message.tool_calls[0].function.arguments);
      };
      if (row.name === "valid_control") assert.doesNotThrow(currentCheck);
      else assert.throws(currentCheck);
    },
  );
test("legacy v2 cannot dispatch fresh requests through either entry", async () => {
  const input = {
    context: { auditBindingProtocol: LEGACY_STRICT_AUDIT_BINDING_PROTOCOL },
  };
  let called = false;
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
      auditRequestBinding: { protocol: LEGACY_STRICT_AUDIT_BINDING_PROTOCOL },
    }),
    /archived replay only/,
  );
});

test("explicit evaluation selection binds v3/endpoint/non-thinking without changing R03 config", async () => {
  const { selectStrictAuditConfig, strictAuditConfigurationPreview } =
    await import("../server/strict-audit-config.mjs");
  const { STRICT_AUDIT_BINDING_PROTOCOL } =
    await import("../server/strict-audit.mjs");
  const base = {
    model: "configured-fixture",
    key: "local-key-not-in-preview",
    endpoint: "http://127.0.0.1:1/v1/chat/completions",
  };
  assert.equal(selectStrictAuditConfig(base, {}), base);
  assert.throws(
    () =>
      selectStrictAuditConfig(base, {
        LEMMA_AUDIT_BINDING_PROTOCOL: STRICT_AUDIT_BINDING_PROTOCOL,
      }),
    /endpoint required/,
  );
  assert.throws(
    () =>
      selectStrictAuditConfig(base, {
        LEMMA_AUDIT_BINDING_PROTOCOL: "lemma.audit-envelope.tools.v2",
      }),
    /current strict/,
  );
  const selected = selectStrictAuditConfig(base, {
    LEMMA_AUDIT_BINDING_PROTOCOL: STRICT_AUDIT_BINDING_PROTOCOL,
    LEMMA_STRICT_AUDIT_ENDPOINT: "http://127.0.0.1:1/beta/chat/completions",
  });
  assert.equal(base.endpoint, "http://127.0.0.1:1/v1/chat/completions");
  assert.equal(selected.auditBindingProtocol, STRICT_AUDIT_BINDING_PROTOCOL);
  const input = {
    context: {
      auditBindingProtocol: STRICT_AUDIT_BINDING_PROTOCOL,
      semanticProtocol: "lemma.source-audit.v8",
    },
  };
  const preview = strictAuditConfigurationPreview(
    selected,
    input,
    "controlled preview",
  );
  assert(!JSON.stringify(preview).includes(base.key));
  assert.equal(preview.thinking.type, "disabled");
  assert.equal(preview.statisticallyIndependentExperts, false);
});
