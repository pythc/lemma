import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { callModel } from "../server/model.mjs";
import {
  structuredReviewCall,
  validateStructuredAttempts,
} from "../server/structured-review.mjs";
import {
  AUDIT_BINDING_PROTOCOL,
  verifyAuditEnvelope,
} from "../server/audit-envelope.mjs";
import { EPISTEMIC_COMPARISON_PROMPT } from "../server/audit-wire.mjs";
import { protectedReviewCalls } from "../server/review-budget.mjs";

test("HTTP audit body gains only trusted identity, while swapped and altered receipts fail closed", async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    calls++;
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: '{"backTranslation":"fixture"}' },
          },
        ],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const config = {
    key: "local-fixture",
    model: "scripted",
    timeoutMs: 5000,
    endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
  };
  const input = {
    contract: { targetHash: "a".repeat(64) },
    context: { auditBindingProtocol: AUDIT_BINDING_PROTOCOL },
    stage: "comparison_after_immutable_blind_review",
  };
  const request = { role: "R04", system: EPISTEMIC_COMPARISON_PROMPT, input };
  try {
    const result = await structuredReviewCall(
      callModel,
      config,
      request,
      (r) => {
        assert.equal(r.targetHash, input.contract.targetHash);
        return r;
      },
    );
    assert.equal(calls, 1);
    assert(!JSON.parse(result.record.content).targetHash);
    validateStructuredAttempts(
      result.attempts,
      input,
      result.parsed,
      result.record,
    );
    for (const change of [
      (r) => (r.requestId = "wrong"),
      (r) => (r.auditEnvelope.targetHash = "b".repeat(64)),
      (r) => (r.content = '{"backTranslation":"tampered"}'),
      (r) =>
        (r.request.messages[1].content = JSON.stringify({
          ...input,
          contract: { targetHash: "b".repeat(64) },
        })),
    ]) {
      const record = structuredClone(result.record);
      change(record);
      assert.throws(() => verifyAuditEnvelope(result.parsed, record, input));
    }
    assert.throws(
      () =>
        verifyAuditEnvelope(result.parsed, result.record, input, {
          runId: "foreign",
          taskId: null,
        }),
      /binding mismatch/,
    );
    const before = calls;
    await assert.rejects(
      structuredReviewCall(
        async (c, r) => {
          const v = await callModel(c, r);
          v.record.requestId = "another-request";
          return v;
        },
        config,
        request,
        () => {},
      ),
      /different request/,
    );
    assert.equal(
      calls,
      before + 1,
      "Identity corruption must not trigger schema retry",
    );
    const wireBefore = calls;
    await assert.rejects(
      callModel(config, {
        messages: [{ role: "user", content: "fixture" }],
        tools: [
          {
            type: "function",
            function: {
              name: "submit",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        toolChoice: "required",
        thinking: { type: "enabled" },
      }),
      /non-thinking/,
    );
    assert.equal(
      calls,
      wireBefore,
      "Unsupported forced-thinking combination never reaches HTTP",
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("admission and full-paper reserve different obligations without reducing full-paper protection", () => {
  const component = { admissionBudgetId: "component" };
  assert.equal(protectedReviewCalls(component, { role: "R03" }), 2);
  assert.equal(
    protectedReviewCalls(component, { budgetPurpose: "semantic_blind" }),
    1,
  );
  assert.equal(
    protectedReviewCalls(component, { budgetPurpose: "semantic_comparison" }),
    0,
  );
  assert.equal(
    protectedReviewCalls(
      { ...component, parentReviewId: "real-paper" },
      { role: "R03" },
    ),
    4,
  );
});

test("concurrent component translation requests cannot consume the two reserved audit slots", async () => {
  const { mkdtemp, mkdir } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { EvidenceStore } = await import("../server/evidence.mjs");
  const { reviewModelTransport } =
    await import("../server/review-transport.mjs");
  const { executionContext } = await import("../server/execution-context.mjs");
  await mkdir(new URL("../evidence/seventh-batch-20261022/", import.meta.url), {
    recursive: true,
  });
  const dir = await mkdtemp(
    fileURLToPath(
      new URL(
        "../evidence/seventh-batch-20261022/concurrent-dispatch-",
        import.meta.url,
      ),
    ),
  );
  const store = new EvidenceStore(dir);
  await store.init();
  const parent = {
    id: "11111111-1111-4111-8111-111111111111",
    schemaVersion: "lemma.admission-budget.v1",
    status: "running",
    createdAt: new Date().toISOString(),
    limits: { maxModelCalls: 4, maxRunMs: 60000 },
    modelCalls: 0,
  };
  await store.saveRun(parent);
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    calls++;
    res.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const config = {
    key: "local-fixture",
    model: "scripted",
    concurrency: 4,
    timeoutMs: 5000,
    endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
  };
  const transport = reviewModelTransport({
    store,
    model: callModel,
    getReview: (id) => store.getRun(id),
    saveReview: (r) => store.saveRun(r),
  });
  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        executionContext.run(
          { run: { id: `child-${i}`, admissionBudgetId: parent.id } },
          () =>
            transport(config, {
              role: "R03",
              input: {},
              system: "controlled fixture",
            }),
        ),
      ),
    );
    assert.equal(calls, 2);
    assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 2);
    const saved = await store.getRun(parent.id);
    assert.equal(saved.modelBudget.entries.length, 2);
    assert(saved.modelBudget.entries.every((e) => e.state === "received"));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
