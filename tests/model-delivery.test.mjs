import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { callModel } from "./controlled-model-receipt.mjs";
import { failureClass } from "../server/autonomy-schema.mjs";
import { reviewOutcome, claimVerdict } from "../shared/review-outcome.mjs";
import { resultKey } from "../src/reading-flow.js";
const listen = (server, port = 0) =>
  new Promise((r) => server.listen(port, "127.0.0.1", r));
const close = (server) => new Promise((r) => server.close(r));
const config = (port) => ({
  endpoint: `http://127.0.0.1:${port}/chat/completions`,
  model: "fixture",
  key: "fixture-not-a-secret",
  timeoutMs: 10000,
});
const req = {
  role: "fixture",
  system: "Controlled transport fixture.",
  input: { value: 1 },
};
const response = {
  choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
};
test("only a confirmed unsent connection failure retries, preserving failed local receipts", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(response));
  });
  await listen(server);
  const port = server.address().port;
  await close(server);
  const restore = setTimeout(() => void listen(server, port), 200);
  try {
    const r = await callModel(config(port), req);
    assert.equal(r.parsed.ok, true);
    assert.equal(r.record.connectionAttempts.length, 1);
    assert.equal(
      r.record.connectionAttempts[0].error.delivery.outcome,
      "not_sent",
    );
    assert.equal(
      r.record.connectionAttempts[0].error.delivery.headersSent,
      false,
    );
    assert.equal(
      failureClass({ modelRecord: r.record.connectionAttempts[0] }),
      "provider_unavailable",
    );
  } finally {
    clearTimeout(restore);
    await close(server);
  }
});
test("a sent request whose socket closes is unknown and is never silently retried", async () => {
  let count = 0;
  const server = createServer((req) => {
    count++;
    req.socket.destroy();
  });
  await listen(server);
  try {
    await assert.rejects(callModel(config(server.address().port), req), (e) => {
      assert.equal(count, 1);
      assert.equal(e.modelRecord.error.delivery.outcome, "unknown");
      assert.equal(e.modelRecord.error.delivery.headersSent, true);
      assert.equal(failureClass(e), "outcome_unknown");
      return true;
    });
  } finally {
    await close(server);
  }
});
test("known provider HTTP failure is archived once, not retried at transport level", async () => {
  let count = 0;
  const server = createServer((req, res) => {
    count++;
    res.writeHead(503, { "content-type": "application/json" });
    res.end('{"error":{"code":"unavailable"}}');
  });
  await listen(server);
  try {
    await assert.rejects(callModel(config(server.address().port), req), (e) => {
      assert.equal(e.modelRecord.http.status, 503);
      assert.equal(count, 1);
      return true;
    });
  } finally {
    await close(server);
  }
});
test("partial outage report can be acknowledged without promoting historic model opinions", () => {
  const run = {
    id: "r",
    paperSha256: "p",
    status: "blocked",
    root: "h",
    conclusion: { executionOutcome: "infrastructure_interrupted" },
  };
  assert.equal(resultKey(run, "p"), "r:h");
  assert.equal(resultKey({ ...run, status: "running" }, "p"), null);
  assert.equal(reviewOutcome(run).interrupted, true);
  assert.equal(
    reviewOutcome({
      ...run,
      status: "completed",
      conclusion: {},
      stopReason:
        "协调未产生有效新计划：模型响应传输失败，未生成有效评审产物。",
    }).interrupted,
    true,
  );
  assert.equal(
    claimVerdict({
      status: "no_issue_found",
      independentReview: { status: "unresolved" },
    }),
    "初步分析已保存，独立复核未完成",
  );
});

test("annotation previews disclose failed independent review without modifying the archived opinion", async () => {
  const { annotationsFromRuns } = await import("../src/reader-model.js");
  const finding = {
    claimId: "c",
    status: "no_issue_found",
    summary: "Initial fixture opinion.",
    anchors: [{ pageIndex: 0, quote: "source" }],
    taskId: "t",
    evidence: "e",
  };
  const run = {
    id: "r",
    paperSha256: "p",
    engine: "langgraph-v1",
    createdAt: "fixture",
    claims: [
      { id: "c", label: "C", independentReview: { status: "unresolved" } },
    ],
    findings: [finding],
    tasks: [],
  };
  const notes = annotationsFromRuns([run], "p");
  assert.equal(notes[0].title, "初步意见，复核未完成");
  assert.match(notes[0].summary, /复核未完成/);
  assert.equal(finding.summary, "Initial fixture opinion.");
});
