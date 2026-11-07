import { cleanupTestEvidence } from "./retain-test-evidence.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { executionContext } from "../server/execution-context.mjs";
import { callModel } from "../server/model.mjs";
import { reviewModelTransport } from "../server/review-transport.mjs";
import { modelPool } from "../server/resource-pool.mjs";
import { unknownModelOutcome } from "../server/model-delivery.mjs";

test(
  "continuation aborts an actual pending HTTP request at the original review deadline",
  { timeout: 10000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "continuation-deadline-"));
    const store = new EvidenceStore(dir);
    await store.init();
    const parent = {
      id: "parent",
      orchestrationVersion: 2,
      status: "running",
      createdAt: new Date().toISOString(),
      budgetStartedAt: new Date(Date.now() - 58500).toISOString(),
      limits: { maxModelCalls: 20, maxRunMs: 60000 },
      modelCalls: 0,
    };
    let calls = 0;
    const provider = createServer(async (req) => {
      for await (const _ of req) {
        /* Receive the request, deliberately do not answer. */
      }
      calls++;
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const transport = reviewModelTransport({
      model: callModel,
      store,
      getReview: async () => parent,
      saveReview: async () => {},
    });
    try {
      const start = Date.now();
      await assert.rejects(
        executionContext.run({ run: parent }, () =>
          transport(
            {
              endpoint: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
              key: "local-fixture",
              model: "deadline-fixture",
              timeoutMs: 5000,
            },
            {
              role: "A_COORDINATOR",
              system: "Controlled local test",
              input: {},
            },
          ),
        ),
      );
      assert(
        Date.now() - start < 4500,
        "New record creation must not reset the HTTP deadline",
      );
      assert.equal(calls, 1);
      assert.equal(parent.budgetStop.reason, "wall_time");
      assert.equal(parent.modelCalls, 1);
      assert.equal(parent.modelBudget.entries[0].state, "unknown");
      assert.equal(
        (await store.get(parent.modelBudget.entries[0].receipt)).kind,
        "review_budget_receipt",
      );
    } finally {
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await cleanupTestEvidence(dir);
    }
  },
);

for (const status of [503, 402])
  test(`HTTP ${status} blocks queued SDK, future child and prover calls before network dispatch`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "review-transport-"));
    const store = new EvidenceStore(dir);
    await store.init();
    const source = await store.put("fixture", {
      text: "controlled dispatch test",
    });
    const parent = {
      id: "parent",
      orchestrationVersion: 2,
      status: "running",
      paperSha256: sha256("controlled dispatch test"),
      sourceArtifact: source,
      limits: { maxModelCalls: 20 },
      modelCalls: 0,
    };
    let wireCalls = 0,
      firstResponse,
      notifyFirst;
    const firstReceived = new Promise((resolve) => {
      notifyFirst = resolve;
    });
    const provider = createServer(async (req, res) => {
      for await (const _ of req) {
        /* Drain the actual request body. */
      }
      wireCalls++;
      firstResponse = res;
      notifyFirst();
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const config = {
      endpoint: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
      key: "controlled-fixture-key",
      model: "dispatch-fixture",
      concurrency: 1,
      timeoutMs: 5000,
    };
    const options = {
      model: callModel,
      store,
      getReview: async (id) => {
        assert.equal(id, "parent");
        return parent;
      },
      saveReview: async () => {},
    };
    const transport = reviewModelTransport(options);
    const request = { role: "R03", system: "controlled fixture", input: {} };
    const child = {
      id: "child",
      parentReviewId: "parent",
      sourceArtifact: source,
    };
    const settled = (promise) =>
      promise.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    try {
      const first = executionContext.run({ run: child }, () =>
        settled(transport(config, request)),
      );
      await firstReceived;
      const second = executionContext.run(
        { run: { ...child, id: "sibling" } },
        () => settled(transport(config, request)),
      );
      for (let i = 0; i < 100 && modelPool(config).snapshot().queued !== 1; i++)
        await new Promise((resolve) => setTimeout(resolve, 2));
      assert.equal(modelPool(config).snapshot().queued, 1);
      firstResponse.writeHead(status, { "Content-Type": "application/json" });
      firstResponse.end(
        JSON.stringify({ error: { message: "controlled outage" } }),
      );
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.error.modelRecord.http.status, status);
      assert.equal(b.error.modelRecord.error.code, "model_dispatch_blocked");
      assert.equal(b.error.modelRecord.error.delivery.outcome, "not_sent");
      assert.equal(unknownModelOutcome(b.error.modelRecord), false);
      assert.equal(wireCalls, 1, "Queued sibling never reached the provider");
      const originalFailure = parent.infrastructureFailure;
      assert.equal(
        originalFailure.kind,
        status === 402 ? "provider_account_blocked" : "provider_unavailable",
      );
      const { reviewCompletion, terminationCause } =
        await import("../shared/review-completion.mjs");
      assert.equal(
        reviewCompletion(parent).executionOutcome,
        status === 402
          ? "provider_account_blocked"
          : "infrastructure_interrupted",
      );
      if (status === 402) {
        assert.equal(
          terminationCause(a.error, "no_actionable_plan"),
          "provider_account_blocked",
        );
        const { AutonomousReview } = await import("../server/autonomous.mjs");
        parent.tasks = [];
        const engine = new AutonomousReview({
          store,
          pipeline: { active: new Map() },
          getConfig: async () => config,
        });
        engine.load = async () => parent;
        engine.syncChildren = async () => {};
        assert.deepEqual(await engine.dispatch({ runId: parent.id }), {
          route: "conclude",
        });
        assert.match(parent.stopReason, /402.*账户或余额/);
        const { reviewOutcome } = await import("../shared/review-outcome.mjs");
        assert.match(reviewOutcome(parent).message, /402.*账户或余额/);
      }
      const receipt = await store.get(originalFailure.artifact);
      assert.equal(receipt.kind, "review_model_failure");
      assert.equal(receipt.payload.ownerRunId, "child");
      assert.equal(receipt.payload.model.http.status, status);
      for (const role of [
        "A_COORDINATOR",
        "A_DIAGNOSE",
        "HARNESS_CONTEXT_SUMMARY",
        "R04",
        "R06_STEP",
      ]) {
        await assert.rejects(
          executionContext.run({ run: child }, () =>
            transport(config, { ...request, role }),
          ),
          /尚未发送/,
        );
      }
      for (const owner of [child, parent]) {
        await assert.rejects(
          executionContext.run({ run: owner }, () =>
            transport(config, request),
          ),
          /尚未发送/,
        );
      }
      const prover = reviewModelTransport({
        ...options,
        countChildCalls: false,
      });
      await assert.rejects(
        executionContext.run({ run: child }, () => prover(config, request)),
        /尚未发送/,
      );
      assert.equal(wireCalls, 1);
      assert.equal(parent.modelCalls, 1);
      assert.deepEqual(
        parent.modelBudget.entries.map((e) => e.state),
        [status === 402 ? "received" : "unknown", "not_sent"],
      );
      assert.equal(
        parent.infrastructureFailure,
        originalFailure,
        "Local blocked calls preserve the original outage",
      );
    } finally {
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await cleanupTestEvidence(dir);
    }
  });

test("known unsent requests and received formatting errors are distinct from interrupted responses", () => {
  assert.equal(
    unknownModelOutcome({
      error: {
        code: "model_connection_unavailable",
        delivery: { outcome: "not_sent" },
      },
    }),
    false,
  );
  assert.equal(
    unknownModelOutcome({
      error: { code: "model_invalid_json", delivery: { outcome: "received" } },
    }),
    false,
  );
  assert.equal(
    unknownModelOutcome({
      error: { code: "model_cancelled" },
      resource: { executionStarted: false },
    }),
    false,
  );
  assert.equal(
    unknownModelOutcome({
      http: { status: 200 },
      error: { code: "model_transport_error" },
    }),
    true,
  );
  assert.equal(
    unknownModelOutcome({
      http: { status: 200 },
      error: { code: "model_invalid_json" },
    }),
    false,
  );
});
