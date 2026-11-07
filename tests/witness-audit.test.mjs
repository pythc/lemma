import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WITNESS_AUDIT_PROTOCOL as protocol,
  WITNESS_AUDIT_PROMPT,
  normalizeAuditBody,
  validateAuditWire,
} from "../server/audit-wire.mjs";
import {
  AUDIT_BINDING_PROTOCOL,
  verifyAuditEnvelope,
} from "../server/audit-envelope.mjs";
import {
  structuredReviewCall,
  validateStructuredAttempts,
  recoveryConcerns,
} from "../server/structured-review.mjs";
import { callModel } from "../server/model.mjs";
import {
  sourceAuditFixture,
  auditBodyFixture,
} from "./source-audit-fixture.mjs";
import { ALIGNMENT_CATEGORIES } from "../server/semantics.mjs";

const contract = {
  targetHash: "a".repeat(64),
  leanTarget: "∀ n : Nat, n = n",
  pageIndex: 0,
  quote: "Every natural number equals itself.",
};
function body() {
  return auditBodyFixture(
    {
      targetHash: contract.targetHash,
      backTranslation: contract.quote,
      checks: ALIGNMENT_CATEGORIES.map((category) => ({
        category,
        status: "aligned",
        explanation: "Controlled fixture",
        anchors: [{ pageIndex: 0, quote: contract.quote }],
      })),
      sourceAudit: sourceAuditFixture(contract, null, protocol),
      findings: [],
    },
    protocol,
  );
}
test("v7 strict wire has one missing location and forbids model-authored formal metadata", () => {
  const valid = body();
  const result = normalizeAuditBody(valid, protocol);
  validateAuditWire(
    { ...result, targetHash: contract.targetHash },
    { protocol },
  );
  for (const mutate of [
    (r) => (r.quantifiers[0].lexicalScope = ["fixture-0"]),
    (r) => (r.quantifiers[0].kind = "forall"),
    (r) => (r.quantifiers[0].typeDependencies = []),
    (r) => (r.fidelity = { status: "unknown", missing: [] }),
    (r) => (r.fidelityStatus = { status: "unknown", missing: [] }),
    (r) => (r.sourceAudit = { missing: [] }),
    (r) => delete r.missing,
  ]) {
    const r = structuredClone(valid);
    mutate(r);
    assert.throws(() => normalizeAuditBody(r, protocol), /协议/);
  }
});

for (const warning of ["missing", "structural"])
  test(`v7 actual HTTP retains rejected ${warning} warnings and reproduces immutable normalization`, async () => {
    const root = path.resolve(
      process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/native-bound-http",
    );
    await mkdir(root, { recursive: true });
    const out = await mkdtemp(path.join(root, "flat-repair-"));
    const first = body();
    first.extra = "invalid";
    first.missing = [
      {
        symbol: "T",
        reason: "Missing definition",
        anchors: [{ pageIndex: 0, quote: contract.quote }],
      },
    ];
    first.fidelityStatus = "unknown";
    if (warning === "structural") {
      first.missing = [];
      first.fidelityStatus = "preserved";
      first.findings = [
        {
          kind: "structural_correspondence_unresolved",
          category: "quantifiers",
          anchors: [{ pageIndex: 0, quote: contract.quote }],
          targetFragment: contract.leanTarget,
          missingSymbols: [],
          independentOfMissing: false,
          basis:
            "Structure remains unresolved despite the inconsistent status fields.",
          changeWitness: null,
        },
      ];
    }
    const payloads = [first, body()];
    let calls = 0;
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(payloads[calls++]) },
            },
          ],
        }),
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const input = {
      contract,
      context: {
        semanticProtocol: protocol,
        auditBindingProtocol: AUDIT_BINDING_PROTOCOL,
      },
    };
    try {
      const result = await structuredReviewCall(
        callModel,
        {
          key: "local-test-credential-not-echoed-58201",
          model: "local-fixture",
          endpoint: `http://127.0.0.1:${server.address().port}`,
          timeoutMs: 5000,
        },
        { role: "R04", system: WITNESS_AUDIT_PROMPT, input },
        (r) => validateAuditWire(r, { protocol }),
      );
      assert.equal(calls, 2);
      assert.equal(result.attempts[0].outcome, "schema_rejected");
      assert.equal(
        result.attempts.length === 1,
        false,
        "A repaired response must never be first-pass complete",
      );
      assert.deepEqual(result.attempts[0].response, first);
      assert(
        recoveryConcerns(result.attempts).some(
          (i) =>
            i.code ===
            (warning === "structural"
              ? "prior_invalid_fidelity_finding"
              : "prior_invalid_source_audit_concern"),
        ),
      );
      const missingStatus = structuredClone(result.attempts);
      delete missingStatus[0].response.fidelityStatus;
      assert(
        recoveryConcerns(missingStatus).some(
          (i) => i.code === "prior_invalid_source_audit_concern",
        ),
        "Missing the flat status must not erase a received source warning",
      );
      validateStructuredAttempts(
        result.attempts,
        input,
        result.parsed,
        result.record,
      );
      verifyAuditEnvelope(result.parsed, result.record, input);
      const changed = structuredClone(result.parsed);
      changed.sourceAudit.missing = [{ symbol: "injected" }];
      assert.throws(
        () => verifyAuditEnvelope(changed, result.record, input),
        /binding mismatch/,
      );
      const record = structuredClone(result.record);
      delete record.auditEnvelope.bodyNormalization;
      assert.throws(
        () => verifyAuditEnvelope(result.parsed, record, input),
        /binding mismatch/,
      );
      await writeFile(
        path.join(out, "result.json"),
        JSON.stringify(
          {
            classification: "controlled_actual_HTTP_not_model_accuracy",
            calls,
            result,
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
