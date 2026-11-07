import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviewModelTransport } from "../server/review-transport.mjs";
import { callModel } from "../server/model.mjs";
import { EvidenceStore } from "../server/evidence.mjs";
import { executionContext } from "../server/execution-context.mjs";
import {
  budgetSnapshot,
  reserveRequest,
  dispatchRequest,
  settleRequest,
  protectedReviewCalls,
} from "../server/review-budget.mjs";
import {
  knownGenerationLimit,
  infrastructureFailure,
  unknownModelOutcome,
} from "../server/model-delivery.mjs";
import { reviewOutcome } from "../shared/review-outcome.mjs";
test("last-slot contention uses one actual HTTP request and stores a reachable receipt", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "budget-wire-"));
  const store = new EvidenceStore(dir);
  await store.init();
  const parent = {
    id: "p",
    status: "running",
    orchestrationVersion: 2,
    createdAt: new Date().toISOString(),
    limits: { maxModelCalls: 1, maxRunMs: 5000 },
    modelCalls: 0,
  };
  let wire = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    wire++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
        usage: { total_tokens: 3 },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const config = {
    model: "budget-test",
    key: "fixture-key",
    endpoint: `http://127.0.0.1:${server.address().port}`,
    timeoutMs: 5000,
  };
  const transport = reviewModelTransport({
    model: callModel,
    getReview: async () => parent,
    saveReview: async () => {},
    store,
  });
  try {
    const out = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        executionContext.run({ run: parent }, () =>
          transport(config, { role: "A_READ", system: "JSON", input: {} }),
        ),
      ),
    );
    assert.equal(out.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(wire, 1);
    assert.equal(parent.modelCalls, 1);
    assert.equal(parent.modelBudget.entries.length, 1);
    const e = parent.modelBudget.entries[0];
    assert.equal(e.state, "received");
    assert.equal(
      (await store.get(e.receipt)).payload.model.requestId,
      e.requestId,
    );
    assert.equal(budgetSnapshot(parent).remainingCalls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
test("reserved unsent requests release capacity; unknown sent outcomes stay charged; closure reserve is enforced", () => {
  const r = { limits: { maxModelCalls: 3 }, modelCalls: 0 };
  const a = reserveRequest(r, { role: "R03", protectedCalls: 2 });
  assert.throws(
    () => reserveRequest(r, { role: "R03", protectedCalls: 2 }),
    (e) =>
      e.recoveryStop === "review_budget_exhausted" &&
      r.budgetStop.reason === "closure_reserve",
  );
  settleRequest(
    r,
    a,
    { resource: { executionStarted: false } },
    Error("cancelled"),
    null,
  );
  assert.equal(budgetSnapshot(r).remainingCalls, 3);
  const b = reserveRequest(r, { role: "R03" });
  dispatchRequest(r, b);
  settleRequest(
    r,
    b,
    { requestId: "b", error: { code: "model_transport_error" } },
    Error("lost"),
    null,
  );
  assert.equal(budgetSnapshot(r).used, 1);
  assert.equal(r.modelBudget.entries[1].state, "unknown");
});
test("known received generation limit is distinct from an interrupted response; historic budget reports remain incomplete", () => {
  const r = {
    finishReason: "length",
    http: { status: 200, truncated: false, bodyDigestScope: "complete_body" },
    error: { code: "model_incomplete" },
  };
  assert.equal(knownGenerationLimit(r), true);
  assert.equal(infrastructureFailure(r), false);
  assert.equal(unknownModelOutcome(r), false);
  assert.equal(
    unknownModelOutcome({
      http: { status: 200 },
      error: { code: "model_transport_error" },
    }),
    true,
  );
  const run = {
    status: "completed",
    root: "old",
    stopReason: "达到本轮预算，保留未完成义务。",
  };
  const before = JSON.stringify(run);
  assert.equal(reviewOutcome(run).interrupted, true);
  assert.equal(JSON.stringify(run), before);
});

test("active evidence obligations retain independent audits without imposing a fixed route", () => {
  const owner = { parentReviewId: "p" };
  assert.equal(protectedReviewCalls(owner, { role: "R03" }), 4);
  assert.equal(
    protectedReviewCalls(owner, {
      role: "R04",
      budgetPurpose: "semantic_blind",
    }),
    3,
  );
  assert.equal(protectedReviewCalls(owner, { role: "R04" }), 2);
  owner.semanticReview = {};
  assert.equal(
    protectedReviewCalls(
      owner,
      { role: "HARNESS_TOOL_MODEL" },
      { role: "R06_STEP" },
    ),
    1,
  );
  assert.equal(protectedReviewCalls(owner, { role: "R06_ROUTE_AUDIT" }), 0);
  assert.equal(protectedReviewCalls(owner, { role: "R03" }), 0);
});

test("budget stop prevents parent diagnostics from spending reserved audit capacity", async () => {
  const parent = {
    id: "p",
    status: "running",
    orchestrationVersion: 2,
    limits: { maxModelCalls: 10 },
    budgetStop: { reason: "closure_reserve" },
  };
  let calls = 0;
  const model = reviewModelTransport({
    model: async () => {
      calls++;
    },
    getReview: async () => parent,
    saveReview: async () => {},
    store: {},
  });
  await assert.rejects(
    executionContext.run({ run: parent }, () =>
      model({}, { role: "A_CHILD_DIAGNOSE" }),
    ),
    (e) => e.recoveryStop === "review_budget_exhausted",
  );
  assert.equal(calls, 0);
});
test("wall-time expiration charges a sent unknown response and archives its HTTP receipt", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "budget-deadline-"));
  const store = new EvidenceStore(dir);
  await store.init();
  const parent = {
    id: "deadline",
    status: "running",
    orchestrationVersion: 2,
    createdAt: new Date().toISOString(),
    limits: { maxModelCalls: 2, maxRunMs: 250 },
    modelCalls: 0,
  };
  let wire = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    wire++;
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const model = reviewModelTransport({
    model: callModel,
    getReview: async () => parent,
    saveReview: async () => {},
    store,
  });
  try {
    await assert.rejects(
      executionContext.run({ run: parent }, () =>
        model(
          {
            model: "fixture",
            key: "fixture",
            endpoint: `http://127.0.0.1:${server.address().port}`,
            timeoutMs: 5000,
          },
          { role: "A_READ", system: "JSON", input: {} },
        ),
      ),
    );
    assert.equal(wire, 1);
    assert.equal(parent.modelCalls, 1);
    assert.equal(parent.budgetStop.reason, "wall_time");
    const e = parent.modelBudget.entries[0];
    assert.equal(e.state, "unknown");
    assert.equal(
      (await store.get(e.receipt)).payload.model.resource.executionStarted,
      true,
    );
    assert.equal(parent.infrastructureFailure, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

test("reservation persistence failure stops later wrappers even with freshly loaded parent objects", async () => {
  const stored = {
    id: "persist",
    status: "running",
    orchestrationVersion: 2,
    limits: { maxModelCalls: 5 },
  };
  let calls = 0,
    fail = true;
  const store = {};
  const options = {
    model: async () => {
      calls++;
    },
    getReview: async () => structuredClone(stored),
    saveReview: async () => {
      if (fail) throw Error("disk unavailable");
    },
    store,
  };
  await assert.rejects(
    executionContext.run({ run: stored }, () =>
      reviewModelTransport(options)({}, { role: "A_READ" }),
    ),
    /disk unavailable/,
  );
  fail = false;
  await assert.rejects(
    executionContext.run({ run: stored }, () =>
      reviewModelTransport(options)({}, { role: "A_READ" }),
    ),
    /尚未发送/,
  );
  assert.equal(calls, 0);
  const outcome = reviewOutcome({
    ...stored,
    budgetStop: { reason: "wall_time" },
  });
  assert.equal(outcome.budgetExhausted, true);
  assert.match(outcome.headline, /预算/);
});
