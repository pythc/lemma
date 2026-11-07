import test from "node:test";
import assert from "node:assert/strict";
import { toolCallView } from "../src/tool-call-view.js";

test("unknown operations and stopped running operations never animate as live or imply a retry", () => {
  const op = { status: "unknown", startedAt: "2026-10-31T10:00:00Z" };
  const unknown = toolCallView(op, "running");
  assert.equal(unknown.status, "unknown");
  assert.match(unknown.summary, /未自动重试/);
  assert.equal(unknown.duration, undefined);
  for (const state of ["paused", "pausing", "cancelled", "completed"]) {
    const stopped = toolCallView({ ...op, status: "running" }, state);
    assert.equal(stopped.status, "unknown");
    assert.match(stopped.summary, /待核对/);
  }
});

test("queueing and execution-after-verification retain their different phase labels", () => {
  const queued = toolCallView(
    { status: "running", phase: "queued", resource: "lean-host" },
    "running",
  );
  assert.equal(queued.status, "pending");
  assert.match(queued.summary, /等待/);
  const post = toolCallView(
    { status: "running", phase: "post_verification", resource: "lean-host" },
    "running",
  );
  assert.equal(post.statusLabel, "执行后核验");
  assert.match(post.summary, /原生执行已结束/);
});

test("returned diagnostics, negative checks, and reuse remain separate from tool failures and paper proof", () => {
  for (const resultSummary of [
    { exitCode: 1 },
    { status: "not_verified" },
    { status: "verified" },
  ]) {
    const view = toolCallView(
      { status: "completed", resultSummary },
      "running",
    );
    assert.equal(view.status, "returned");
    assert.equal(view.category, "returned");
  }
  const diagnostic = toolCallView(
    { status: "completed", resultSummary: { exitCode: 0 } },
    "completed",
  );
  assert.match(diagnostic.summary, /不是论文证明/);
  const reused = toolCallView(
    {
      status: "completed",
      resultSummary: { nativeCheckExecuted: false, status: "verified" },
    },
    "paused",
  );
  assert.equal(reused.statusLabel, "已复用回执");
  assert.match(reused.summary, /未执行新的内核检查/);
});

test("early parameter rejection does not appear as an executed proof failure", () => {
  const view = toolCallView(
    { status: "failed", error: { dispatchState: "not_dispatched" } },
    "paused",
  );
  assert.equal(view.status, "error");
  assert.equal(view.statusLabel, "未执行");
  assert.match(view.summary, /参数校验拒绝，未执行/);
});

test("cancellation and unrecognized future states are never mapped to success", () => {
  assert.equal(
    toolCallView({ status: "cancelled" }, "cancelled").status,
    "cancelled",
  );
  assert.equal(
    toolCallView({ status: "future_state" }, "running").status,
    "unknown",
  );
  assert.match(
    toolCallView({ status: "future_state" }, "running").summary,
    /不能据此判断/,
  );
});

test("only valid recorded start/end pairs yield a completed duration", () => {
  assert.equal(
    toolCallView({ status: "completed", startedAt: 0, endedAt: 0 }, "paused")
      .duration,
    0,
  );
  assert.equal(
    toolCallView(
      {
        status: "completed",
        startedAt: "2026-10-31T10:00:00Z",
        endedAt: "2026-10-31T10:00:05Z",
      },
      "paused",
    ).duration,
    5000,
  );
  for (const pair of [
    { startedAt: "bad", endedAt: 1 },
    { startedAt: 20, endedAt: 10 },
    { startedAt: Infinity },
    { startedAt: null },
  ]) {
    assert.equal(
      toolCallView({ status: "completed", ...pair }, "paused").duration,
      undefined,
    );
  }
});
