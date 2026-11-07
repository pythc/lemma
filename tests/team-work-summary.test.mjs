import test from "node:test";
import assert from "node:assert/strict";
import { readerTaskPage, workSummary } from "../server/team/work-summary.mjs";
test("task pagination retains its boundary under new branch creation and never loses main navigation", () => {
  const run = {
    revision: 1,
    tasks: Array.from({ length: 160 }, (_, i) => ({
      id: String(i),
      role: i ? "task" : "main",
    })),
  };
  const first = readerTaskPage(run);
  assert.equal(first.items.length, 61);
  assert.equal(first.nextBefore, 100);
  run.tasks.push({ id: "new", role: "task" });
  const second = readerTaskPage(run, {
    bound: first.bound,
    before: first.nextBefore,
  });
  assert.equal(second.items[1].id, "40");
  assert.equal(second.items.at(-1).id, "99");
  assert.equal(second.items[0].role, "main");
  assert.throws(() => readerTaskPage(run, { before: -1 }), /cursor/);
});
test("work summary separates navigation, native work and repeated intent without closing any objective", () => {
  const run = {
    operations: [
      { id: "nav", name: "read_source", status: "completed" },
      {
        id: "a",
        logicalKey: "same",
        name: "lean_draft",
        status: "failed",
        nativeTimings: [{ name: "native.kernel" }],
      },
      {
        id: "b",
        logicalKey: "same",
        name: "lean_draft",
        status: "completed",
        newExecutionReason: "Intentional measurement",
        nativeTimings: [{ name: "native.kernel" }],
      },
    ],
    objectives: [{ status: "open" }],
    submissions: [{ status: "pass", superseded: true }],
    targets: [{}, {}],
  };
  const s = workSummary(run);
  assert.equal(s.nativeKernelSpans, 2);
  assert.equal(s.navigationCalls, 1);
  assert.equal(s.acceptedSubmissions, 0);
  assert.equal(s.repeatedChecks.length, 1);
  assert.deepEqual(s.repeatedChecks[0].explicitNewReasons, [
    "Intentional measurement",
  ]);
  assert.equal(s.openObjectives, 1);
  assert.match(s.advisory, /No automatic stop/);
  assert.equal(run.objectives[0].status, "open");
});
