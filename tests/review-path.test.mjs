import test from "node:test";
import assert from "node:assert/strict";
import {
  groupReviewTasks,
  overviewDependencies,
  visibleParents,
} from "../src/review-path.js";

const t = (id, kind, parents = [], extra = {}) => ({
  id,
  kind,
  parents,
  status: "succeeded",
  ...extra,
});
test("historical report production does not look successful when all reading failed", () => {
  const run = {
    unreadPages: [0],
    tasks: [
      t("read", "read", [], { status: "unresolved" }),
      t("report", "conclude", ["read"]),
    ],
    claims: [],
  };
  const raw = JSON.stringify(run);
  const report = groupReviewTasks(run).groups.find((g) => g.kind === "report");
  assert.equal(report.status, "unresolved");
  assert.equal(report.title, "评审未完成");
  assert.equal(JSON.stringify(run), raw);
});
test("overview never creates future stages, and every source task remains accounted for without mutation", () => {
  const r = {
    claims: [{ id: "a", label: "Theorem 1" }],
    tasks: [
      t("i", "import"),
      t("r", "read", ["i"]),
      t("e", "environment", ["r"]),
      t("p", "environment_probe", ["e"], { claimId: "a" }),
      t("d", "decide", ["p"]),
      t("a", "formalize", ["d"], { claimId: "a", status: "unresolved" }),
      t("fix", "diagnose", ["a"], { recoveryFor: "a" }),
      t("z", "conclude", ["fix"]),
    ],
  };
  const original = structuredClone(r),
    g = groupReviewTasks(r);
  assert.deepEqual(r, original);
  assert.deepEqual(
    [
      ...g.groups.flatMap((g) => g.taskIds),
      ...g.dispatch.map((t) => t.id),
    ].sort(),
    r.tasks.map((t) => t.id).sort(),
  );
  assert.equal(
    g.groups.find((g) => g.kind === "environment").taskIds.includes("p"),
    true,
  );
  assert.equal(g.groups.find((g) => g.kind === "claim").status, "unresolved");
  const early = groupReviewTasks({ tasks: r.tasks.slice(0, 2) });
  assert.deepEqual(
    early.groups.map((g) => g.kind),
    ["import", "read"],
  );
});
test("collapsed links require real source dependencies and cross-claim feedback cannot create overview cycles", () => {
  const r = {
    claims: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    tasks: [
      t("i", "import"),
      t("r", "read", ["i"]),
      t("e", "environment", ["r"]),
      t("d", "decide", ["e"]),
      t("a1", "inspect_proof", ["d"], { claimId: "a" }),
      t("b1", "inspect_proof", ["a1"], { claimId: "b" }),
      t("a2", "inspect_proof", ["b1"], { claimId: "a" }),
      t("z", "conclude", ["a2", "b1"]),
    ],
  };
  const g = groupReviewTasks(r),
    edges = overviewDependencies(r, g);
  assert.ok(
    edges.some(
      (e) => e.source === "group:environment" && e.target === "group:claim:a",
    ),
  );
  assert.ok(
    !edges.some(
      (e) => e.source === "group:claim:a" && e.target === "group:claim:b",
    ),
  );
  assert.ok(
    !edges.some(
      (e) => e.source === "group:claim:b" && e.target === "group:claim:a",
    ),
  );
  const disconnected = { tasks: [t("x", "import"), t("y", "read")] };
  assert.deepEqual(
    overviewDependencies(disconnected, groupReviewTasks(disconnected)),
    [],
  );
});
test("branch links traverse hidden dispatch and diagnostics, and never invent chronological dependencies", () => {
  const tasks = [
    t("a", "inspect_proof"),
    t("d", "decide", ["a"]),
    t("b", "formalize", ["d"]),
    t("c", "counterexample"),
  ];
  assert.deepEqual(visibleParents(tasks[2], tasks, new Set(["a", "b", "c"])), [
    "a",
  ]);
  assert.deepEqual(
    visibleParents(tasks[3], tasks, new Set(["a", "b", "c"])),
    [],
  );
});
test("active and pending child states are retained; unrelated successful diagnostics cannot erase a failure", () => {
  const r = {
    claims: [{ id: "a", label: "Theorem 2" }],
    tasks: [
      t("x", "formalize", [], {
        claimId: "a",
        childRunId: "child",
        childStatus: "awaiting_confirmation",
        childFinal: false,
      }),
      t("y", "diagnose", ["x"], { recoveryFor: "x" }),
    ],
  };
  assert.equal(groupReviewTasks(r).groups[0].status, "awaiting_confirmation");
  r.tasks[0].childStatus = "running";
  assert.equal(groupReviewTasks(r).groups[0].status, "running");
  r.tasks[0].childFinal = true;
  r.tasks[0].status = "unresolved";
  assert.equal(groupReviewTasks(r).groups[0].status, "unresolved");
});
