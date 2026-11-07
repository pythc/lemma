import { publicTeamRun } from "../server/team/public-view.mjs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { draftModules, leanImports } from "../server/execution-environment.mjs";
import { pinnedPackages } from "../server/python-environments.mjs";
import { sourceSpan } from "../server/team/source-spans.mjs";
import { TeamOperations } from "../server/team/operations.mjs";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 500; i++) {
    if (fn()) return;
    await delay(20);
  }
  throw Error("condition not reached");
}
test("dependency headers ignore strings and nested comments and preserve explicit pinned imports", () => {
  assert.deepEqual(
    leanImports(
      '/- import Mathlib.Fake /- nested -/ -/\nimport Mathlib.Data.Nat.Basic -- hi\ndef x := "import Mathlib.Bad"\nimport Std',
    ),
    ["Mathlib.Data.Nat.Basic", "Std"],
  );
  assert.deepEqual(
    draftModules("import Mathlib\nimport Mathlib.Data.Nat.Basic", [
      "Mathlib.Data.Nat.Basic",
    ]),
    ["Mathlib.Data.Nat.Basic", "Mathlib"],
  );
  assert.throws(() => pinnedPackages([{ name: "--index-url", version: "1" }]));
  assert.throws(() => pinnedPackages([{ name: "mpmath", version: ">=1" }]));
  assert.deepEqual(pinnedPackages([{ name: "MPMath", version: "1.3.0" }]), [
    { name: "mpmath", version: "1.3.0" },
  ]);
});
test("invalid source ranges return exact corrective bounds without changing original text", () => {
  assert.throws(
    () => sourceSpan({ pages: [{ index: 0, text: "A𝛼B" }] }, 0, 0, 9),
    (e) =>
      e.navigation.validRange.end === 4 && e.navigation.field === "start/end",
  );
});
test("resource phases have separate timing and queued phase never carries a previous start", async () => {
  const op = { id: "o", status: "running" },
    runtime = { edit: async (_, fn) => fn({ operations: [op] }) };
  const operations = new TeamOperations(runtime);
  await operations.resourcePhase("r", "o", "lean-library", "executing");
  await operations.resourcePhase("r", "o", "lean-host", "queued");
  assert.equal(op.executionStartedAt, null);
  assert.equal(op.resourceStages.length, 2);
  assert.ok(op.resourceStages[0].endedAt);
});
test(
  "two backend processes share three kernel slots; queue cancellation and owner death release capacity",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lemma-host-")),
      children = [];
    t.after(async () => {
      for (const c of children)
        if (c.exitCode === null && !c.signalCode) {
          c.send("cancel");
        }
      await delay(200);
      for (const c of children)
        if (c.exitCode === null && !c.signalCode) c.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    });
    const start = () => {
      const c = fork(
        new URL("./helpers/native-host-process.mjs", import.meta.url),
        [],
        {
          env: { ...process.env, LEMMA_NATIVE_RESOURCE_ROOT: root },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      c.events = [];
      c.on("message", (m) => c.events.push(m));
      children.push(c);
      return c;
    };
    const a = start(),
      b = start(),
      c = start();
    await until(() =>
      [a, b, c].every((p) => p.events.some((e) => e.event === "executing")),
    );
    const d = start();
    await until(() => d.events.some((e) => e.event === "queued"));
    await delay(200);
    assert.ok(!d.events.some((e) => e.event === "executing"));
    d.send("cancel");
    await until(() => d.events.some((e) => e.event === "settled"));
    assert.equal(d.events.at(-1).result.termination, "cancelled");
    const e = start();
    await until(() => e.events.some((x) => x.event === "queued"));
    const exit = once(a, "exit");
    a.kill("SIGKILL");
    await exit;
    await until(() => e.events.some((x) => x.event === "executing"));
    for (const p of [b, c, e]) p.send("cancel");
    await until(() =>
      [b, c, e].every((p) => p.events.some((x) => x.event === "settled")),
    );
    const { stdout } = await promisify(execFile)("/usr/bin/python3", [
      fileURLToPath(new URL("../worker/native_slot.py", import.meta.url)),
      root,
      "3",
      "--snapshot",
    ]);
    assert.equal(JSON.parse(stdout).running, 0);
  },
);

test("archived unfinished operations preserve unknown history without showing an active queue", async () => {
  const run = {
    id: "r",
    engine: "team-v1",
    status: "cancelled",
    tasks: [],
    targets: [],
    submissions: [],
    proofReceiptIndex: [],
    operations: [
      { id: "a", actorId: "x", status: "running", phase: "queued" },
      { id: "b", actorId: "y", status: "unknown" },
    ],
  };
  const view = await publicTeamRun(
    run,
    () => {
      throw Error("No archive read needed");
    },
    { compact: true },
  );
  assert.equal(view.executionMetrics.queuedOperations, 0);
  assert.equal(view.executionMetrics.unknownOperations, 1);
  assert.equal(run.operations[0].status, "running");
});
