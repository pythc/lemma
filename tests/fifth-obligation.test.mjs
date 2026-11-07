import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvidenceStore } from "../server/evidence.mjs";
import { executionContext } from "../server/execution-context.mjs";
import { reviewModelTransport } from "../server/review-transport.mjs";
import { callModel } from "../server/model.mjs";
import { obligationAllowance } from "../server/obligation-budget.mjs";
test("actual HTTP planning cannot consume the next proof allowance; queue deadline and cancellation stop dispatch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-fifth-")),
    store = new EvidenceStore(dir);
  await store.init();
  const parent = {
    id: "p",
    orchestrationVersion: 2,
    status: "running",
    createdAt: new Date().toISOString(),
    limits: { maxRunMs: 240000, maxModelCalls: 6 },
    modelCalls: 0,
  };
  const child = { id: "c", parentReviewId: "p", semanticReview: {} };
  let sent = 0;
  const server = createServer(async (req, res) => {
    for await (const c of req) {
    }
    sent++;
    res.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const config = {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    key: "fixture",
    model: "fixture",
    timeoutMs: 1000,
    stageBudgets: {
      source_planning: { maxOutputTokens: 100 },
      proof_construction: { maxOutputTokens: 200 },
    },
  };
  const invoke = reviewModelTransport({
    model: callModel,
    store,
    getReview: async () => parent,
    saveReview: async () => {},
  });
  const request = (role) =>
    executionContext.run({ run: child, task: { role } }, () =>
      invoke(config, {
        role: "HARNESS_TOOL_MODEL",
        system: "explicit scripted fixture",
        input: {},
      }),
    );
  try {
    const a = obligationAllowance(parent, true);
    assert.equal(a.maxCalls, 5);
    assert.equal(a.feasibleMinimum, null);
    assert.equal(a.reserve.nativeAndArchiveMs, 10000);
    child.activeObligation = {
      ...a,
      deadlineAt: Date.now() + a.maxElapsedMs,
      reservedCalls: 0,
    };
    for (let i = 0; i < 5; i++) {
      const r = await request("R06_GRAPH");
      assert.equal(r.record.logicalStage, "source_planning");
    }
    await assert.rejects(
      request("R06_INTERFACES"),
      (e) => e.recoveryStop === "obligation_budget_exhausted",
    );
    assert.equal(sent, 5);
    assert(!parent.budgetStop);
    const b = obligationAllowance(parent, false);
    assert.equal(b.maxCalls, 1);
    child.activeObligation = {
      ...b,
      deadlineAt: Date.now() + b.maxElapsedMs,
      reservedCalls: 0,
    };
    const proof = await request("R09G");
    assert.equal(proof.record.logicalStage, "proof_construction");
    assert.equal(sent, 6);
    child.activeObligation.deadlineAt = Date.now() - 1;
    await assert.rejects(
      request("R09G"),
      (e) => e.recoveryStop === "obligation_budget_exhausted",
    );
    assert.equal(sent, 6);
    child.activeObligation.deadlineAt = Date.now() + 1000;
    parent.status = "cancelled";
    await assert.rejects(request("R09G"), /父评审已结束/);
    assert.equal(sent, 6);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
