import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ANCHORED_AUDIT_PROTOCOL as protocol,
  ANCHORED_AUDIT_PROMPT,
  validateAuditWire,
} from "../server/audit-wire.mjs";
import {
  STRICT_AUDIT_BINDING_PROTOCOL,
  strictAuditSchema,
  strictSchemaProjection,
  normalizeStrictAudit,
  validateStrictEndpoint,
} from "../server/strict-audit.mjs";
import { verifyAuditEnvelope } from "../server/audit-envelope.mjs";
import {
  structuredReviewCall,
  validateStructuredAttempts,
} from "../server/structured-review.mjs";
import { callModel } from "../server/model.mjs";
import { ALIGNMENT_CATEGORIES } from "../server/semantics.mjs";
import { sourceAuditFixture } from "./source-audit-fixture.mjs";
import {
  assertStrictRequest,
  strictBodyFixture,
  strictMessageFixture,
} from "./strict-audit-fixture.mjs";

const contract = {
  targetHash: "a".repeat(64),
  leanTarget: "∀ n : Nat, n = n",
  pageIndex: 0,
  quote: "Every natural number equals itself.",
};
const input = {
  contract,
  context: {
    semanticProtocol: protocol,
    auditBindingProtocol: STRICT_AUDIT_BINDING_PROTOCOL,
  },
};
function body(comparison = false) {
  return strictBodyFixture(
    {
      backTranslation: contract.quote,
      checks: ALIGNMENT_CATEGORIES.map((category) => ({
        category,
        status: "aligned",
        explanation: "Explicit fixture",
        anchors: [{ pageIndex: 0, quote: contract.quote }],
      })),
      findings: [],
      ...(!comparison
        ? { sourceAudit: sourceAuditFixture(contract, null, protocol) }
        : {}),
    },
    comparison,
  );
}
const request = {
  role: "R04",
  budgetPurpose: "semantic_blind",
  system: ANCHORED_AUDIT_PROMPT,
  input,
};
const validate = (r) => validateAuditWire(r, { protocol });
async function provider(t, respond) {
  const requests = [];
  const root = path.resolve(
    process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/strict-local-http",
  );
  await mkdir(root, { recursive: true });
  const out = await mkdtemp(path.join(root, "submission-"));
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const wire = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(wire);
      assertStrictRequest(wire, JSON.parse(wire.messages[1].content));
      await respond(wire, res, requests.length);
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const records = [];
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await writeFile(
      path.join(out, "evidence.json"),
      JSON.stringify(
        {
          classification: "controlled_HTTP_not_model_accuracy",
          requests,
          records,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
  });
  return {
    requests,
    records,
    config: {
      endpoint: `http://127.0.0.1:${server.address().port}/beta/chat/completions`,
      model: "controlled-local",
      key: "controlled-secret-no-echo-94021",
      timeoutMs: 3000,
    },
    options: { onAttempt: async (a) => records.push(a) },
  };
}
const reply = (res, message, finish = "tool_calls") =>
  res.end(
    JSON.stringify({
      model: "controlled-local",
      choices: [{ finish_reason: finish, message }],
    }),
  );

test("strict projection is a required closed subset; full client retains quantity and text constraints", () => {
  for (const comparison of [false, true]) {
    const projected = strictSchemaProjection(strictAuditSchema(comparison));
    const walk = (s) => {
      assert(
        !["minLength", "maxLength", "minItems", "maxItems", "$schema"].some(
          (k) => k in s,
        ),
      );
      assert.notEqual(s.type, "null");
      if (s.type === "object") {
        assert.equal(s.additionalProperties, false);
        assert.deepEqual(
          [...s.required].sort(),
          Object.keys(s.properties).sort(),
        );
        Object.values(s.properties).forEach(walk);
      }
      if (s.items) walk(s.items);
      s.anyOf?.forEach(walk);
    };
    walk(projected);
  }
  for (const mutate of [
    (r) => (r.coverage.explanation = "not allowed"),
    (r) => (r.backTranslation = ""),
    (r) => r.checks.pop(),
    (r) => (r.checks[0].anchors = []),
    (r) => delete r.probes,
    (r) => (r.checks[0].explanation = "x".repeat(1601)),
  ]) {
    const r = body();
    mutate(r);
    assert.throws(() => normalizeStrictAudit(r, input), /full client schema/);
  }
  assert.throws(
    () => strictSchemaProjection(z.strictObject({ x: z.string().optional() })),
    /every object field/,
  );
  assert.throws(
    () => strictSchemaProjection(z.strictObject({ x: z.string().nullable() })),
    /Unsupported strict schema type: .*null/,
  );
  assert.throws(() =>
    strictSchemaProjection(
      z.strictObject({ x: z.string().transform((x) => x) }),
    ),
  );
});

test("explicit witness list is reversible, never silently truncated or repaired", () => {
  const r = body();
  const finding = {
    kind: "structural_correspondence_unresolved",
    category: "quantifiers",
    anchors: [{ pageIndex: 0, quote: contract.quote }],
    targetFragment: contract.leanTarget,
    missingSymbols: [],
    independentOfMissing: false,
    basis: "Unresolved source correspondence",
    changeWitness: [],
  };
  r.findings = [finding];
  assert.equal(normalizeStrictAudit(r, input).findings[0].changeWitness, null);
  const w = {
    kind: "quantifiers",
    sourceAnchor: finding.anchors[0],
    sourceFragment: "Every natural number",
    effect: "structure_only",
  };
  finding.changeWitness = [w];
  assert.deepEqual(normalizeStrictAudit(r, input).findings[0].changeWitness, w);
  finding.changeWitness = [w, w];
  assert.throws(() => normalizeStrictAudit(r, input), /full client schema/);
  finding.changeWitness = null;
  assert.throws(() => normalizeStrictAudit(r, input), /full client schema/);
});

test("actual HTTP strict pair uses two independent submissions and detects every envelope mutation", async (t) => {
  const p = await provider(t, (wire, res) =>
    reply(
      res,
      strictMessageFixture(body(!!JSON.parse(wire.messages[1].content).stage)),
    ),
  );
  const blind = await structuredReviewCall(
    callModel,
    p.config,
    request,
    validate,
    p.options,
  );
  const comparisonInput = {
    ...input,
    stage: "comparison_after_immutable_blind_review",
    blindResponse: blind.parsed,
  };
  const comparison = await structuredReviewCall(
    callModel,
    p.config,
    {
      ...request,
      input: comparisonInput,
      budgetPurpose: "semantic_comparison",
    },
    (r) => validateAuditWire(r, { protocol, comparison: true }),
    p.options,
  );
  assert.equal(p.requests.length, 2);
  assert.equal(blind.attempts.length, 1);
  assert.equal(comparison.attempts.length, 1);
  assert.doesNotMatch(
    p.requests[0].messages[0].content,
    /changeWitness=null|changeWitness 仍为 null|changeWitness=\{/,
  );
  assert.notEqual(blind.record.requestId, comparison.record.requestId);
  assert.equal(
    JSON.parse(p.requests[0].messages[1].content).blindResponse,
    undefined,
  );
  validateStructuredAttempts(blind.attempts, input, blind.parsed, blind.record);
  validateStructuredAttempts(
    comparison.attempts,
    comparisonInput,
    comparison.parsed,
    comparison.record,
  );
  for (const mutate of [
    (r) => (r.toolCalls[0].function.arguments += " "),
    (r) => (r.toolCalls[0].id += "changed"),
    (r) => (r.toolCalls[0].function.name = "wrong"),
    (r) => (r.finishReason = "stop"),
    (r) => (r.request.tools[0].function.strict = false),
    (r) => (r.request.tool_choice = "auto"),
    (r) => (r.request.messages[1].content = "{}"),
    (r) => (r.auditEnvelope.bodyNormalization = "lemma.audit-body.flat.v1"),
    (r) => (r.auditEnvelope.submissionPolicy = "retry"),
    (r) => (r.auditRequestBinding.protocol = "lemma.audit-envelope.v1"),
  ]) {
    const record = structuredClone(blind.record);
    mutate(record);
    assert.throws(() => verifyAuditEnvelope(blind.parsed, record, input));
  }
  assert.throws(() =>
    verifyAuditEnvelope(blind.parsed, blind.record, comparisonInput),
  );
  assert.throws(() =>
    verifyAuditEnvelope(
      { ...blind.parsed, targetHash: "b".repeat(64) },
      blind.record,
      input,
    ),
  );
  assert.throws(
    () =>
      validateStructuredAttempts(
        [...blind.attempts, ...blind.attempts],
        input,
        blind.parsed,
        blind.record,
      ),
    /cannot contain format retries/,
  );
});

const badResponses = {
  extra_field: () => {
    const b = body();
    b.coverage.explanation = "Historical failure shape";
    return strictMessageFixture(b);
  },
  missing_field: () => {
    const b = body();
    delete b.probes;
    return strictMessageFixture(b);
  },
  no_tool: () => ({ role: "assistant", content: JSON.stringify(body()) }),
  duplicate_submissions: () => {
    const m = strictMessageFixture(body());
    m.tool_calls.push({ ...m.tool_calls[0], id: "other" });
    return m;
  },
  duplicate_ids: () => {
    const m = strictMessageFixture(body());
    m.tool_calls.push(m.tool_calls[0]);
    return m;
  },
  wrong_tool: () => {
    const m = strictMessageFixture(body());
    m.tool_calls[0].function.name = "other";
    return m;
  },
  malformed_json: () => {
    const m = strictMessageFixture(body());
    m.tool_calls[0].function.arguments = "{";
    return m;
  },
  text_plus_tool: () => ({
    ...strictMessageFixture(body()),
    content: "A second conflicting answer",
  }),
  truncated: () => strictMessageFixture(body()),
};
for (const [name, make] of Object.entries(badResponses))
  test(`actual HTTP ${name} preserves failure and cannot take comparison's slot`, async (t) => {
    const p = await provider(t, (_, res) =>
      reply(
        res,
        make(),
        name === "truncated"
          ? "length"
          : name === "no_tool"
            ? "stop"
            : "tool_calls",
      ),
    );
    await assert.rejects(
      structuredReviewCall(callModel, p.config, request, validate, {
        ...p.options,
        maxAttempts: 2,
      }),
      (e) => {
        assert.equal(e.structuredAttempts.length, 1);
        assert(e.modelRecord);
        assert.notEqual(e.structuredAttempts[0].outcome, "validated");
        return true;
      },
    );
    assert.equal(p.requests.length, 1);
    assert.equal(p.records.length, 1);
    if (name === "extra_field")
      assert.equal(
        p.records[0].response.coverage.explanation,
        "Historical failure shape",
      );
    if (
      ["malformed_json", "truncated", "wrong_tool", "duplicate_ids"].includes(
        name,
      )
    )
      assert(
        JSON.parse(p.records[0].model.strictResponse.publicJson).choices[0]
          .message.tool_calls.length,
      );
  });

for (const failure of ["http400", "unknown", "cancel"])
  test(`actual HTTP ${failure} is archived once, no automatic retry`, async (t) => {
    const controller = new AbortController();
    const p = await provider(t, (_wire, res) => {
      if (failure === "http400") {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            error: {
              code: "invalid_schema",
              message: "Controlled unsupported schema",
            },
          }),
        );
      } else if (failure === "unknown") res.destroy();
      else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write("{");
        setTimeout(() => controller.abort(), 20);
      }
    });
    await assert.rejects(
      structuredReviewCall(
        callModel,
        p.config,
        { ...request, signal: controller.signal },
        validate,
        p.options,
      ),
      (e) => {
        assert.equal(e.structuredAttempts.length, 1);
        return true;
      },
    );
    assert.equal(p.requests.length, 1);
    assert.equal(p.records.length, 1);
  });

test("normal endpoint cannot silently enable strict mode; local-only guard blocks before reservation", async () => {
  for (const endpoint of [
    "https://api.deepseek.com/chat/completions",
    "https://other.example/beta/chat/completions",
    "http://localhost/test",
    "https://api.deepseek.com/beta/chat/completions?x=1",
  ])
    assert.throws(() => validateStrictEndpoint({ endpoint }), /explicit/);
  validateStrictEndpoint({
    endpoint: "https://api.deepseek.com/beta/chat/completions",
  });
  const prior = process.env.LEMMA_MODEL_LOCAL_ONLY;
  process.env.LEMMA_MODEL_LOCAL_ONLY = "1";
  try {
    await assert.rejects(
      callModel(
        { endpoint: "https://api.deepseek.com/beta/chat/completions" },
        request,
      ),
      { code: "model_external_disabled" },
    );
  } finally {
    if (prior === undefined) delete process.env.LEMMA_MODEL_LOCAL_ONLY;
    else process.env.LEMMA_MODEL_LOCAL_ONLY = prior;
  }
});

test("strict connection failure does not retry even before headers were sent", async (t) => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const attempts = [];
  await assert.rejects(
    structuredReviewCall(
      callModel,
      {
        endpoint: `http://127.0.0.1:${port}`,
        model: "local-only",
        key: "closed-port-fixture",
        timeoutMs: 3000,
      },
      request,
      validate,
      { onAttempt: async (a) => attempts.push(a) },
    ),
    (e) => {
      assert.equal(e.modelRecord.error.delivery.outcome, "not_sent");
      assert.deepEqual(e.modelRecord.connectionAttempts, []);
      return true;
    },
  );
  assert.equal(attempts.length, 1);
  const out = path.resolve(
    process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/strict-local-http",
  );
  await mkdir(out, { recursive: true });
  const dir = await mkdtemp(path.join(out, "connection-"));
  await writeFile(
    path.join(dir, "attempts.json"),
    JSON.stringify(attempts, null, 2),
    { flag: "wx" },
  );
});
