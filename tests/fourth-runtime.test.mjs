import { cleanupTestEvidence } from "./retain-test-evidence.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callModel } from "./controlled-model-receipt.mjs";
import {
  reserveExperiment,
  settleExperiment,
} from "../server/experiment-budget.mjs";
import {
  reserveRequest,
  dispatchRequest,
  closureTimeReserve,
  deferOptionalAction,
} from "../server/review-budget.mjs";
test("stage settings and partial body timing are observed on actual HTTP", async () => {
  const received = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    received.push(JSON.parse(raw));
    res.setHeader("content-type", "application/json");
    if (received.length === 1)
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "{}" } }],
        }),
      );
    else {
      res.write('{"choices":[');
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const config = {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    key: "fixture",
    model: "fixture",
    maxOutputTokens: 9000,
    timeoutMs: 2000,
    reasoningEffort: "high",
    stageBudgets: {
      A_READ: { maxOutputTokens: 500, timeoutMs: 200, reasoningEffort: "low" },
    },
  };
  try {
    const r = await callModel(config, {
      role: "A_READ",
      system: "JSON",
      input: {},
      maxTokens: 7000,
    });
    assert.equal(received[0].max_tokens, 500);
    assert.equal(received[0].reasoning_effort, "low");
    assert.equal(r.record.http.bodyComplete, true);
    assert(r.record.timing.bodyCompletedAt);
    await assert.rejects(
      callModel(config, { role: "A_READ", system: "JSON", input: {} }),
      (e) => {
        assert.equal(e.modelRecord.error.phase, "reading_body");
        assert.equal(e.modelRecord.http.bodyComplete, false);
        assert(e.modelRecord.http.retainedBytes > 0);
        assert.equal(e.modelRecord.http.bodyDigestScope, "retained_prefix");
        return true;
      },
    );
    assert.equal(received.length, 2);
    assert.equal(config.maxOutputTokens, 9000);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test("persistent trial cap serializes competitors and never refunds unknown attempts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fourth-ledger-"));
  const env = {
    LEMMA_EXPERIMENT_LEDGER: root,
    LEMMA_EXPERIMENT_COHORT: "diagnostics",
  };
  try {
    await writeFile(
      root + "/ledger.json",
      JSON.stringify({ maxCalls: 296, caps: { diagnostics: 1 }, entries: [] }),
    );
    const r = await Promise.allSettled([
      reserveExperiment({ role: "R04" }, env),
      reserveExperiment({ role: "R04" }, env),
    ]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    await settleExperiment(
      r.find((x) => x.status === "fulfilled").value,
      { requestId: "unknown", error: { code: "model_timeout" } },
      Error("unknown"),
    );
    await assert.rejects(reserveExperiment({}, env));
    const ledger = JSON.parse(await readFile(root + "/ledger.json"));
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].state, "failed_charged");
  } finally {
    await cleanupTestEvidence(root);
  }
});
test("critical path retains time after queuing and defers optional original-route reconstruction", () => {
  const r = {
    createdAt: new Date().toISOString(),
    limits: { maxRunMs: 200000, maxModelCalls: 12 },
    claims: [{ id: "c" }],
    tasks: [{ claimId: "c", kind: "formalize", status: "running" }],
    reviewScope: { maxSelectedClaims: 1 },
  };
  assert.equal(closureTimeReserve(r, 2), 70000);
  assert.equal(
    deferOptionalAction(r, { claimId: "c", kind: "reconstruct_proof" }),
    "selected_target_fidelity_pending",
  );
  assert.equal(
    deferOptionalAction(r, { claimId: "c", kind: "resolve_scope" }),
    null,
  );
  const id = reserveRequest(r, { protectedCalls: 1, protectedMs: 40000 });
  r.createdAt = new Date(Date.now() - 180000).toISOString();
  assert.throws(
    () => dispatchRequest(r, id),
    (e) => e.recoveryStop === "review_budget_exhausted",
  );
  assert.equal(r.modelBudget.entries[0].state, "reserved");
  assert.equal(r.budgetStop.reason, "closure_time_reserve");
});

import { readingChunks } from "../server/adaptive-schema.mjs";
test("bounded reading preserves exact offsets and all text across paragraph and Unicode boundaries", () => {
  const text = "a".repeat(17) + "\n" + "b".repeat(30) + "😀" + "c".repeat(25);
  const chunks = readingChunks({ pages: [{ index: 0, text }] }, 20);
  const parts = chunks.flat();
  assert.equal(parts.map((p) => p.text).join(""), text);
  assert.equal(parts[0].text, "a".repeat(17) + "\n");
  for (const p of parts) {
    assert.equal(text.slice(p.start, p.start + p.text.length), p.text);
    assert(p.text.length <= 20);
    assert(!/[\uD800-\uDBFF]$/u.test(p.text));
  }
  assert.throws(() => readingChunks({ pages: [] }, 0));
});
