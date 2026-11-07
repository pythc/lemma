import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TeamRuntime } from "../server/team/runtime.mjs";
import { TeamResources } from "../server/resources/team-resources.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { ResourcePool } from "../server/resource-pool.mjs";
import { executionContext } from "../server/execution-context.mjs";
import { nativePolicy } from "../server/resources/native-policy.mjs";
import { TeamPublicViews, publicTeamRun } from "../server/team/public-view.mjs";
import { boardView, readBoardObject } from "../server/team/board.mjs";
import { evidenceView, selectEvidence } from "../server/team/evidence-view.mjs";
import { evaluationInventory } from "../server/team/evaluation-report.mjs";
const gate = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { resolve, promise };
};
const until = async (fn) => {
  for (let i = 0; i < 400; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("test condition not met");
};

test("acceptance infrastructure failure wakes the main while another worker is live; unknown request is never replayed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-health-"));
  const store = new EvidenceStore(root);
  let runtime,
    mainCalls = 0,
    acceptanceCalls = 0,
    workerActive = false,
    resumedWhileWorkerActive = false;
  const hold = gate();
  const executor = {
    run: async (ctx) => {
      const session = runtime.sessions.get(ctx.token),
        run = runtime.runs.get(session.runId),
        actor = run.tasks.find((a) => a.id === session.actorId);
      const call = async (name, args = {}) => {
        const response = await fetch(ctx.endpoint + "/call", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ctx.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name, arguments: args }),
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error);
        return result;
      };
      if (actor.role === "main") {
        if (++mainCalls === 1) {
          const task = await call("create_task", {
            title: "Independent task",
            goal: "Hold controlled work",
            criteria: "Fixture only",
          });
          await call("submit_task", {
            summary: "Interim report",
            resultKind: "report",
            artifactIds: [],
            targetIds: [],
            limitations: ["No proof"],
            afterAcceptance: "continue",
          });
        } else {
          resumedWhileWorkerActive = workerActive;
          assert.equal(run.submissions[0].status, "unresolved");
          assert.ok(
            actor.feedback.some((f) => f.category === "coordination_needed"),
          );
          await call("yield_work", {
            taskIds: run.tasks
              .filter((a) => a.role === "task")
              .map((a) => a.id),
          });
        }
      } else if (actor.role === "task") {
        workerActive = true;
        await Promise.race([
          hold.promise,
          new Promise((r) =>
            ctx.signal.addEventListener("abort", r, { once: true }),
          ),
        ]);
        workerActive = false;
      } else {
        acceptanceCalls++;
        throw Error("Known infrastructure error with unknown final output");
      }
      return { model: "controlled-fixture", reasoningEffort: "high" };
    },
  };
  runtime = new TeamRuntime({
    store,
    executor,
    resources: new TeamResources({ concurrency: 3, maxTurns: 12 }),
    mathTools: { run: async () => ({}) },
    extract: async () => ({
      paperSha256: sha256("fixture"),
      pages: [{ index: 0, text: "Not a paper proof" }],
      pageCount: 1,
    }),
  });
  await runtime.init();
  t.after(async () => {
    await runtime.close();
    hold.resolve();
    await rm(root, { recursive: true, force: true });
  });
  const run = await runtime.start({ pdfBase64: "fixture" });
  await until(() => mainCalls === 2);
  assert.equal(resumedWhileWorkerActive, true);
  assert.equal(acceptanceCalls, 1);
  const live = runtime.runs.get(run.id);
  assert.equal(live.status, "running");
  const failed = live.turns.find((turn) => turn.status === "unknown");
  assert.ok(failed?.artifact);
  assert.equal(live.submissions.length, 1);
});

test("host admission has independent memory bounds, cancellable FIFO queue and distinct queue/start events", async () => {
  assert.equal(
    nativePolicy({ memoryBytes: 48 * 1024 ** 3, cpus: 18 }).concurrency,
    3,
  );
  assert.equal(
    nativePolicy({ memoryBytes: 8 * 1024 ** 3, cpus: 2 }).concurrency,
    1,
  );
  assert.throws(
    () => nativePolicy({ memoryBytes: 32 * 1024 ** 3, cpus: 4, override: "8" }),
    /host capacity/,
  );
  const pool = new ResourcePool(2, { name: "lean" }),
    events = [],
    hold = gate(),
    controller = new AbortController();
  const work = (id, signal) =>
    executionContext.run(
      {
        onToolQueued: () => events.push(`${id}:queued`),
        onToolStarted: () => events.push(`${id}:executing`),
      },
      () =>
        pool.run(
          async () => {
            await hold.promise;
            return id;
          },
          { signal },
        ),
    );
  const a = work("a"),
    b = work("b"),
    c = work("c", controller.signal);
  await until(() => pool.running === 2 && pool.queue.length === 1);
  assert.deepEqual(
    events.filter((s) => s.endsWith(":executing")),
    ["a:executing", "b:executing"],
  );
  controller.abort(Error("fixture cancellation"));
  await assert.rejects(c, /fixture cancellation/);
  hold.resolve();
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  assert.deepEqual(pool.snapshot(), { limit: 2, running: 0, queued: 0 });
});

test("live public reads use compact indexes without opening archives, retain actual accepted receipt and revoke stale acceptance", async () => {
  const run = {
    id: "r",
    engine: "team-v1",
    receipts: Array(20000).fill("huge"),
    targets: [
      {
        id: "t",
        contract: {
          targetHash: "exact",
          leanTarget: "hidden large source",
          pageIndex: 3,
          quote: "Exact source bytes",
        },
      },
    ],
    tasks: [],
    submissions: [
      { status: "pass", targetIds: ["t"], replayIds: ["accepted"] },
    ],
    proofReceiptIndex: [
      {
        artifactId: "accepted",
        kind: "team:lean",
        runId: "r",
        actorId: "a",
        targetId: "t",
        targetHash: "exact",
        mode: "proof",
        status: "verified",
      },
    ],
  };
  const views = new TeamPublicViews(() => {
    throw Error("Must not scan full archive");
  });
  const before = JSON.stringify(run);
  const result = await views.read(run);
  assert.equal(result.machineChecks[0].independentlyAccepted, true);
  assert.equal(result.receipts, undefined);
  assert.equal(result.targets[0].contract.leanTarget, undefined);
  assert.equal(result.targets[0].contract.pageIndex, 3);
  assert.equal(result.targets[0].contract.quote, "Exact source bytes");
  assert.equal(JSON.stringify(run), before);
  run.submissions[0].superseded = true;
  assert.equal(
    (await views.read(run)).machineChecks[0].independentlyAccepted,
    false,
  );
});

test("historical projection returns immediately, indexes once and exposes unavailable evidence honestly", async () => {
  const hold = gate();
  let reads = 0;
  const run = {
    id: "history",
    engine: "team-v1",
    receipts: ["a", "b"],
    targets: [],
    tasks: [],
    submissions: [],
  };
  const views = new TeamPublicViews(async () => {
    reads++;
    await hold.promise;
    return { kind: "team:draft", payload: {} };
  });
  assert.equal((await views.read(run)).proofIndexStatus, "building");
  assert.equal((await views.read(run)).proofIndexStatus, "building");
  assert.equal(reads, 1);
  hold.resolve();
  await views.cache.get(run.id).work;
  assert.equal((await views.read(run)).proofIndexStatus, "ready");
  assert.equal(reads, 2);
  const broken = new TeamPublicViews(async () => {
    throw Error("corrupt evidence");
  });
  await broken.read(run);
  await broken.cache.get(run.id).work;
  assert.equal((await broken.read(run)).proofIndexStatus, "unavailable");
});

test("exact object handles and paginated evidence errors point to recoverable content without guessing identity", () => {
  const run = {
    revision: 1,
    tasks: [{ id: randomUUID(), title: "A" }],
    objectives: [],
  };
  const view = boardView(run, run.tasks[0], { section: "tasks" });
  const args = view.tasks[0].read.arguments;
  assert.equal(readBoardObject(run, args).value.title, "A");
  assert.equal(
    readBoardObject(run, { ...args, kind: "task" }).value.title,
    "A",
  );
  const artifact = {
    id: sha256("artifact"),
    payload: { first: [1, 2], second: "text" },
  };
  const page = selectEvidence(artifact, {
    path: ["payload"],
    offset: 1,
    limit: 1,
  });
  assert.equal(page.entries[0].key, "second");
  assert.equal(
    selectEvidence(artifact, page.entries[0].read.arguments),
    "text",
  );
  assert.throws(
    () => selectEvidence(artifact, { path: ["payload", "wrong"] }),
    (e) =>
      e.navigation.availableKeys.includes("first") &&
      e.navigation.arguments.path.join() === "payload",
  );
});

test("evaluation inventory retains proof categories without retaining huge raw proof or dependency strings", async () => {
  const output = await evaluationInventory(
    (async function* () {
      yield {
        id: "p",
        kind: "team:lean",
        payload: {
          result: {
            targetId: "t",
            proof: "x".repeat(1000000),
            result: {
              status: "verified",
              targetHash: "h",
              dependencies: { constants: "x".repeat(1000000) },
            },
          },
        },
      };
      yield { id: "reuse", kind: "team:lean_reuse", payload: { result: {} } };
    })(),
  );
  assert.equal(output.length, 2);
  assert.equal(output[0].payload.result.result.status, "verified");
  assert.ok(JSON.stringify(output).length < 1000);
});

test("wide and paginated evidence stays bounded and every omitted item remains addressable", () => {
  const huge = Object.fromEntries(
    Array.from({ length: 120 }, (_, i) => [String(i), "x".repeat(100000)]),
  );
  const artifact = {
    id: "a".repeat(64),
    payload: { huge, list: Array(200).fill(huge) },
  };
  assert.ok(
    JSON.stringify(evidenceView(huge, artifact.id, ["payload", "huge"]))
      .length <= 64000,
  );
  const page = selectEvidence(artifact, {
    path: ["payload", "list"],
    offset: 0,
    limit: 1000,
  });
  assert.ok(JSON.stringify(page).length < 80000);
  assert.equal(page.nextOffset, 100);
  assert.equal(page.value[0]._view.artifactId, artifact.id);
  assert.deepEqual(page.value[0]._view.omitted[0].path.slice(0, 3), [
    "payload",
    "list",
    "0",
  ]);
  assert.throws(() => selectEvidence(artifact, { path: "payload" }), /array/);
  assert.throws(() => selectEvidence(artifact, { offset: -1 }), /nonnegative/);
});

test("delivery replay resolves reuse to its original native receipt once and preserves categories", async () => {
  const artifacts = {
    reuse: {
      kind: "team:lean_reuse",
      payload: { runId: "r", result: { originalProofReceipt: "proof" } },
    },
    proof: {
      kind: "team:lean",
      payload: {
        runId: "r",
        result: {
          mode: "proof",
          contract: { targetHash: "h" },
          proof: "unchanged",
        },
      },
    },
  };
  let calls = 0;
  const streamed = [];
  const receiver = {
    load: async () => ({
      id: "r",
      submissions: [{ status: "pass", replayIds: ["reuse", "proof", "reuse"] }],
    }),
    getArtifact: async (_, id) => artifacts[id],
    math: {
      checker: async (contract, proof) => {
        calls++;
        assert.equal(proof, "unchanged");
        return { status: "verified", targetHash: contract.targetHash };
      },
    },
    store: { put: async () => "fresh" },
  };
  const result = await TeamRuntime.prototype.replay.call(receiver, "r", {
    onResult: (x) => streamed.push(x),
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.results, streamed);
  assert.deepEqual(
    streamed.map((x) => x.nativeCheckExecuted),
    [false, true],
  );
  artifacts.proof.payload.runId = "other";
  await assert.rejects(
    TeamRuntime.prototype.replay.call(receiver, "r"),
    /this run/,
  );
});
