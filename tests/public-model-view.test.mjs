import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { canonical, sha256 } from "../server/evidence.mjs";
import { callModel } from "../server/model.mjs";
import { structuredReviewCall } from "../server/structured-review.mjs";
import {
  ANCHORED_AUDIT_PROTOCOL,
  ANCHORED_AUDIT_PROMPT,
  validateAuditWire,
} from "../server/audit-wire.mjs";
import { STRICT_AUDIT_BINDING_PROTOCOL } from "../server/strict-audit.mjs";
import {
  privateModelMessage,
  publicModelResult,
  publicProviderMetadata,
} from "../server/public-model-view.mjs";
import { unknownModelOutcome } from "../server/model-delivery.mjs";
import {
  reserveRequest,
  dispatchRequest,
  settleRequest,
  budgetSnapshot,
} from "../server/review-budget.mjs";
import { ALIGNMENT_CATEGORIES } from "../server/semantics.mjs";
import { sourceAuditFixture } from "./source-audit-fixture.mjs";
import {
  strictBodyFixture,
  strictMessageFixture,
} from "./strict-audit-fixture.mjs";

const marker = "synthetic_private_archive_marker_never_a_real_secret";
const quote = "Every natural number equals itself.";
const contract = {
  targetHash: "a".repeat(64),
  leanTarget: "∀ n : Nat, n = n",
  pageIndex: 0,
  quote,
};
const input = {
  contract,
  context: {
    semanticProtocol: ANCHORED_AUDIT_PROTOCOL,
    auditBindingProtocol: STRICT_AUDIT_BINDING_PROTOCOL,
  },
};
const request = { role: "R04", system: ANCHORED_AUDIT_PROMPT, input };
function response() {
  return {
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: strictMessageFixture(
          strictBodyFixture({
            backTranslation: quote,
            findings: [],
            checks: ALIGNMENT_CATEGORIES.map((category) => ({
              category,
              status: "aligned",
              explanation: "Explicit public mathematical audit",
              anchors: [{ pageIndex: 0, quote }],
            })),
            sourceAudit: sourceAuditFixture(
              contract,
              null,
              ANCHORED_AUDIT_PROTOCOL,
            ),
          }),
        ),
      },
    ],
  };
}
async function fixture(t, mutate, { status = 200 } = {}) {
  const root = path.resolve(
    process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/public-archive",
  );
  await mkdir(root, { recursive: true });
  const out = await mkdtemp(path.join(root, "archive-"));
  let calls = 0,
    raw;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    calls++;
    const next = mutate(response());
    raw = typeof next === "string" ? next : JSON.stringify(next);
    res.statusCode = status;
    res.end(raw);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const config = {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    model: "local-only",
    key: "dummy-current-key",
    timeoutMs: 5000,
  };
  const attempts = [];
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await writeFile(
      path.join(out, "public-attempts.json"),
      JSON.stringify(
        {
          classification: "controlled_public_archive_not_external_model",
          calls,
          rawSha256: sha256(raw || ""),
          attempts,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
  });
  return {
    config,
    attempts,
    options: { onAttempt: async (a) => attempts.push(a) },
    get calls() {
      return calls;
    },
    get raw() {
      return raw;
    },
  };
}
const validate = (r) =>
  validateAuditWire(r, { protocol: ANCHORED_AUDIT_PROTOCOL });

test("all default result/spread/canonical views are public while SDK context stays in memory", async (t) => {
  const p = await fixture(t, (r) => {
    Object.assign(r.choices[0].message, {
      reasoning_content: marker,
      reasoning_details: { trace: marker },
      analysis: marker,
      thinking: marker,
      chain_of_thought: marker,
    });
    r.recovery = {
      thinking: marker,
      access_token: marker,
      nested: { authorization: marker },
      [marker]: marker,
    };
    r.lifecycle = {
      chain_of_thought: marker,
      thoughts_message_count: 2,
      recovered_from_snapshot: true,
    };
    r.gateway_budget = {
      generation_posts: 1,
      generation_retries: 0,
      unknown: { secret: marker },
    };
    return r;
  });
  const r = await structuredReviewCall(
    callModel,
    p.config,
    request,
    validate,
    p.options,
  );
  for (const view of [
    r,
    { ...r, message: { ...r.message } },
    publicModelResult(r),
  ]) {
    assert(!JSON.stringify(view).includes(marker));
    assert(!canonical(view).includes(marker));
    assert(!inspect(view).includes(marker));
  }
  assert.equal(privateModelMessage({ ...r }).reasoning_content, marker);
  assert.throws(
    () => privateModelMessage(JSON.parse(JSON.stringify(r))),
    /Private provider context is unavailable/,
  );
  assert.throws(
    () => privateModelMessage(JSON.parse(JSON.stringify(r))),
    /Private provider context is unavailable/,
  );
  assert.equal(r.record.lifecycle.thoughts_message_count, 2);
  assert.equal(r.record.gatewayBudget.generation_retries, 0);
  assert.equal(p.calls, 1);
  assert.equal(r.attempts.length, 1);
});
test("mathematical public strings are never field-name scrubbed", async (t) => {
  const p = await fixture(t, (r) => {
    const body = JSON.parse(
      r.choices[0].message.tool_calls[0].function.arguments,
    );
    body.backTranslation = "Let thinking and access_token be symbols; α = α.";
    r.choices[0].message.tool_calls[0].function.arguments =
      JSON.stringify(body);
    return r;
  });
  const r = await structuredReviewCall(
    callModel,
    p.config,
    request,
    validate,
    p.options,
  );
  assert.equal(
    r.parsed.backTranslation,
    "Let thinking and access_token be symbols; α = α.",
  );
});
for (const field of [
  "access_token",
  "accessToken",
  "api_key",
  "Authorization",
  "cookie",
  "reasoning_details",
  "thinking",
  "chainOfThought",
  "unrecognized_metadata",
])
  test(`unknown/sensitive metadata is opaque on success and failure: ${field}`, async (t) => {
    const p = await fixture(t, (r) => ({
      ...r,
      recovery: { [field]: marker },
    }));
    const r = await structuredReviewCall(
      callModel,
      p.config,
      request,
      validate,
      p.options,
    );
    assert(!JSON.stringify(r).includes(marker));
    assert(!JSON.stringify(r.record.strictResponse).includes(marker));
    const bad = await fixture(t, (r) => ({
      ...r,
      unexpected_metadata: { [field]: marker },
    }));
    await assert.rejects(
      structuredReviewCall(
        callModel,
        bad.config,
        request,
        validate,
        bad.options,
      ),
      (error) => {
        assert(error.modelRecord);
        assert(!JSON.stringify(error.modelRecord).includes(marker));
        assert.equal(unknownModelOutcome(error.modelRecord), false);
        return true;
      },
    );
    assert.equal(bad.calls, 1);
    assert(!JSON.stringify(bad.attempts).includes(marker));
  });
for (const where of ["usage", "recovery"])
  test(`wide received ${where} preserves receipt and settles as received`, async (t) => {
    const p = await fixture(t, (r) => ({
      ...r,
      [where]: Array(200000).fill(0),
    }));
    const owner = { limits: { maxModelCalls: 2 }, modelCalls: 0 };
    const ticket = reserveRequest(owner, { role: "R04" });
    dispatchRequest(owner, ticket);
    await assert.rejects(
      structuredReviewCall(callModel, p.config, request, validate, p.options),
      (error) => {
        const record = error.modelRecord;
        assert(record);
        assert(record.requestId);
        assert.equal(record.http.bodySha256, sha256(p.raw));
        assert.equal(record.http.bodyComplete, true);
        assert.equal(record.error.code, "model_response_structure_limit");
        assert.equal(record.error.delivery.outcome, "received");
        assert.equal(unknownModelOutcome(record), false);
        assert.equal(p.attempts[0].model, record);
        settleRequest(owner, ticket, record, error, "receipt");
        return true;
      },
    );
    assert.equal(owner.modelBudget.entries[0].state, "received");
    assert.equal(budgetSnapshot(owner).used, 1);
    assert.equal(p.calls, 1);
  });
test("unexpected post-receive capture failure is wrapped without losing identity", async (t) => {
  const p = await fixture(t, (r) => {
    r.choices[0].message.reasoning_content = marker;
    return r;
  });
  const stringify = JSON.stringify;
  JSON.stringify = function (value, ...args) {
    if (value?.archivedAs === "private") {
      JSON.stringify = stringify;
      throw new RangeError("controlled capture fault");
    }
    return stringify(value, ...args);
  };
  try {
    await assert.rejects(
      structuredReviewCall(callModel, p.config, request, validate, p.options),
      (error) => {
        assert.equal(
          error.modelRecord.error.code,
          "model_response_processing_error",
        );
        assert.equal(error.modelRecord.error.delivery.outcome, "received");
        assert.equal(error.modelRecord.http.bodySha256, sha256(p.raw));
        assert(error.modelRecord.requestId);
        assert(p.attempts[0].model);
        assert(!stringify(p.attempts).includes(marker));
        return true;
      },
    );
  } finally {
    JSON.stringify = stringify;
  }
  assert.equal(p.calls, 1);
});
test("opaque policy keeps established counters and hides unknown field names", () => {
  const v = publicProviderMetadata({
    [marker]: marker,
    reasoning_tokens: 4,
    recovered_from_snapshot: true,
  });
  assert(!JSON.stringify(v).includes(marker));
  assert.equal(v.reasoning_tokens, 4);
  assert.equal(v.recovered_from_snapshot, true);
});
test("HTTP-error projection failure also retains the received receipt", async (t) => {
  const raw =
    '{"recovery":' +
    "[".repeat(7200) +
    JSON.stringify(marker) +
    "]".repeat(7200) +
    "}";
  assert.throws(() => JSON.stringify(JSON.parse(raw)), RangeError);
  const p = await fixture(t, () => raw, { status: 503 });
  await assert.rejects(
    structuredReviewCall(callModel, p.config, request, validate, p.options),
    (error) => {
      const r = error.modelRecord;
      assert.equal(r.error.code, "model_response_processing_error");
      assert.equal(r.error.delivery.outcome, "received");
      assert.equal(r.http.status, 503);
      assert.equal(r.http.bodySha256, sha256(raw));
      assert.equal(r.http.bodyComplete, true);
      assert(r.requestId);
      assert(!JSON.stringify(r).includes(marker));
      return true;
    },
  );
  assert.equal(p.calls, 1);
  assert.equal(p.attempts.length, 1);
});
for (const type of [
  "reasoning",
  "thinking",
  "analysis",
  "reasoning_content",
  "chain_of_thought",
  "redacted_thinking",
  "encrypted_reasoning",
])
  test(`typed private content is opaque in a rejected strict receipt: ${type}`, async (t) => {
    const p = await fixture(t, (r) => {
      r.choices[0].message.content = [{ type, text: marker }];
      return r;
    });
    await assert.rejects(
      structuredReviewCall(callModel, p.config, request, validate, p.options),
      (error) => {
        assert.equal(
          error.modelRecord.error.code,
          "model_invalid_strict_response",
        );
        assert.equal(error.modelRecord.error.delivery.outcome, "received");
        assert(!JSON.stringify(error.modelRecord).includes(marker));
        return true;
      },
    );
    assert.equal(p.calls, 1);
    assert.equal(p.attempts.length, 1);
  });
test("unknown function and sensitive message metadata names are opaque", async (t) => {
  const p = await fixture(t, (r) => {
    r.choices[0].message.content = [{ type: "reasoning", text: marker }];
    r.choices[0].message.tool_calls[0].function[marker] = "opaque value";
    r.choices[0].message[`access_token_${marker}`] = "opaque value";
    return r;
  });
  const r = await callModel(p.config, {
    messages: [{ role: "user", content: "public probe" }],
    tools: [{ type: "function", function: { name: "submit_semantic_audit" } }],
  });
  assert(!JSON.stringify(publicModelResult(r)).includes(marker));
  assert.throws(
    () => privateModelMessage(JSON.parse(JSON.stringify(r))),
    /Private provider context is unavailable/,
  );
  assert.equal(p.calls, 1);
  await assert.rejects(
    structuredReviewCall(callModel, p.config, request, validate, p.options),
    (error) => {
      assert.equal(
        error.modelRecord.error.code,
        "model_invalid_strict_response",
      );
      assert(!JSON.stringify(error.modelRecord).includes(marker));
      return true;
    },
  );
  assert.equal(p.calls, 2);
});
