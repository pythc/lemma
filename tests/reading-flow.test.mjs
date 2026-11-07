import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  resultKey,
  resultIsVisible,
  placeMarginNotes,
} from "../src/reading-flow.js";
import { acknowledgeResult, resultAcknowledgements } from "../src/storage.js";

const run = {
  id: "run-a",
  paperSha256: "pdf-a",
  status: "completed",
  root: "sha-result-a",
};
test("result acknowledgement is separate from mathematical approval and exact to paper, run and result", async () => {
  assert.equal(resultIsVisible(run, "pdf-a", {}), false);
  const seen = await acknowledgeResult("pdf-a", run);
  assert.equal(resultIsVisible(run, "pdf-a", seen), true);
  assert.equal(
    resultIsVisible({ ...run, root: "new-root" }, "pdf-a", seen),
    false,
  );
  assert.equal(resultIsVisible({ ...run, id: "run-b" }, "pdf-a", seen), false);
  assert.equal(resultIsVisible(run, "pdf-b", seen), false);
  assert.equal(run.approval, undefined);
  assert.deepEqual(await resultAcknowledgements("pdf-a"), seen);
  assert.deepEqual(await resultAcknowledgements("pdf-b"), {});
});
test("preparing, running, semantic confirmation, failure and missing root never unlock results", async () => {
  assert.equal(resultKey(null, undefined), null);
  assert.equal(resultIsVisible(null, undefined, {}), false);
  await assert.rejects(acknowledgeResult(undefined, null), /评审尚未结束/);
  for (const status of [
    "preparing",
    "running",
    "awaiting_confirmation",
    "blocked",
    "cancelled",
    "interrupted",
  ]) {
    const candidate = { ...run, status };
    assert.equal(resultKey(candidate, "pdf-a"), null);
    await assert.rejects(acknowledgeResult("pdf-a", candidate));
  }
  assert.equal(resultKey({ ...run, root: null }, "pdf-a"), null);
  await assert.rejects(acknowledgeResult("pdf-b", run));
});
const note = (id, y, page = 0) => ({
  id,
  anchor: { pageIndex: page, rects: y === null ? [] : [{ y }], quote: "quote" },
});
test("margin cards follow PDF anchors, avoid overlap as expanded height changes, and retain unknown positions", () => {
  const notes = [
    note("later", 0.25),
    note("first", 0.2),
    note("unknown", null),
    note("other", 0.1, 1),
  ];
  const compact = placeMarginNotes(notes, {}, 0, 1000, {
    first: 90,
    later: 100,
  });
  assert.deepEqual(
    compact.placed.map((x) => [x.note.id, x.top]),
    [
      ["first", 200],
      ["later", 306],
    ],
  );
  const expanded = placeMarginNotes(notes, {}, 0, 1000, {
    first: 900,
    later: 100,
  });
  assert.equal(expanded.placed[1].top, 1116);
  assert.ok(expanded.height >= 1232);
  assert.deepEqual(
    expanded.unplaced.map((n) => n.id),
    ["unknown"],
  );
  const matched = placeMarginNotes(
    [note("matched", null)],
    { matched: [{ y: 0.4 }] },
    0,
    500,
  );
  assert.equal(matched.placed[0].top, 200);
  assert.equal(
    placeMarginNotes([note("invalid", NaN)], {}, 0, 500).unplaced.length,
    1,
  );
});

import {
  readingStatus,
  readingLimitations,
} from "../shared/reading-status.mjs";
test("legacy failed-reading report is presented as unknown without changing its archived root", () => {
  const r = {
    status: "completed",
    root: "immutable-result",
    unreadPages: [0, 1],
    readingGaps: [{ pages: [0, 1], reason: "HTTP 502" }],
    tasks: [{ kind: "read", status: "unresolved" }],
    conclusion: { claimCount: 0, headline: "本轮评审已汇总" },
  };
  const original = JSON.stringify(r);
  assert.equal(readingStatus(r).failed, true);
  assert.deepEqual(readingLimitations(r), [
    "尚未完成阅读的页面：1、2",
    "第 1、2 页：HTTP 502",
  ]);
  assert.equal(JSON.stringify(r), original);
  assert.equal(
    readingStatus({
      ...r,
      unreadPages: [],
      readingGaps: [],
      tasks: [{ kind: "read", status: "succeeded" }],
    }).failed,
    false,
  );
});
test("text extraction gaps and AI reading failures remain distinct in partial coverage", () => {
  const r = {
    missingTextPages: [0],
    unreadPages: [0, 2],
    readingGaps: [{ pages: [2], reason: "HTTP 502" }],
    paperMap: { readPages: [1] },
    tasks: [],
  };
  assert.equal(readingStatus(r).failed, false);
  assert.equal(readingStatus(r).incomplete, true);
  assert.deepEqual(readingLimitations(r), [
    "未提取到文本的页面：1",
    "尚未完成阅读的页面：3",
    "第 3 页：HTTP 502",
  ]);
});

import { evidenceDisplay } from "../shared/evidence-display.mjs";
test("customer evidence hides runtime counters in root and step errors without rewriting archives", () => {
  const error =
    "原证明核验达到运行限制：model_calls（本次输入 9000 字符，已调用 256 次模型）";
  const archived = {
    error,
    steps: [{ explanation: error }],
    budget: { calls: 256 },
  };
  const view = evidenceDisplay(archived, "original_proof_report");
  assert.doesNotMatch(JSON.stringify(view), /9000|256|model_calls/);
  assert.match(view.description, /尚未完成/);
  assert.equal(archived.error, error);
  assert.equal(archived.budget.calls, 256);
});
test("evidence reader shows actual derivations while excluding engineering records", () => {
  const preview = {
    value: {
      summary: "核对上确界条件",
      assumptions: ["有界"],
      steps: [{ explanation: "取严格小于上确界的数" }],
      dependencies: ["上确界性质"],
      statistics: { recordedRequests: 2 },
      request: { messages: ["private envelope"] },
      pages: [{ index: 0, text: "Theorem 1" }],
    },
  };
  const result = evidenceDisplay(preview);
  assert.equal(result.description, "核对上确界条件");
  assert.deepEqual(result.lists[1], ["论证步骤", ["取严格小于上确界的数"]]);
  assert.deepEqual(result.pages, [{ pageIndex: 0, text: "Theorem 1" }]);
  assert.ok(!JSON.stringify(result).includes("recordedRequests"));
  assert.ok(!JSON.stringify(result).includes("private envelope"));
});
test("invalid archived model output stays readable instead of breaking the evidence dialog", () => {
  const result = evidenceDisplay({
    parsed: {
      summary: { broken: true },
      steps: [null, {}, "有效片段"],
      dependencies: "not an array",
      pages: [null, 2, { pageIndex: -1, text: "bad" }],
      counterexample: { description: "反例说明" },
    },
  });
  assert.equal(result.description, "");
  assert.deepEqual(result.lists, [["论证步骤", ["有效片段"]]]);
  assert.deepEqual(result.pages, []);
  assert.equal(result.counterexample, "反例说明");
});

test("a model supplied check field cannot turn an evidence preview into a Lean verdict", async () => {
  const { evidenceDisplay } = await import("../shared/evidence-display.mjs");
  const value = {
    value: {
      check: { status: "verified", mode: "proof" },
      explanation: "model claim",
    },
  };
  assert.ok(
    !evidenceDisplay(value, "adaptive:inspect_proof").lists.some(
      ([label]) => label === "Lean 检查",
    ),
  );
  const local = {
    check: { status: "verified", mode: "proof" },
    status: "conditional",
    contract: { leanTarget: "∀ h : False, True" },
  };
  assert.ok(
    evidenceDisplay(local, "original:step_result")
      .lists.find(([label]) => label === "Lean 检查")[1][0]
      .includes("前序义务"),
  );
});

test("a sealed partial report requires its own display acknowledgement and does not authorize a proof", async () => {
  const partial = {
    ...run,
    id: "partial-report",
    status: "blocked",
    root: "partial-root",
    conclusion: { executionOutcome: "infrastructure_interrupted" },
  };
  assert.equal(resultIsVisible(partial, "pdf-a", {}), false);
  const seen = await acknowledgeResult("pdf-a", partial);
  assert.equal(resultIsVisible(partial, "pdf-a", seen), true);
  assert.equal(
    resultIsVisible({ ...partial, root: "later-root" }, "pdf-a", seen),
    false,
  );
  assert.equal(partial.approval, undefined);
});
