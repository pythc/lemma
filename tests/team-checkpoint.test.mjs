import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { TeamRuntime } from "../server/team/runtime.mjs";
import { forkCheckpoint } from "../server/team/checkpoint.mjs";
import { createApp } from "../server/index.mjs";
import { PDFDocument } from "pdf-lib";

const policy = { concurrency: 4, maxTurns: 4096, maxRunMs: 172800000 };
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "team-checkpoint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const parent = new EvidenceStore(path.join(dir, "parent"));
  await parent.init();
  const document = await PDFDocument.create();
  document.addPage().drawText("Controlled checkpoint fixture");
  const pdf = Buffer.from(await document.save());
  const source = {
    paperSha256: sha256(pdf),
    pdfBase64: pdf.toString("base64"),
    pages: [{ index: 0, text: "Controlled checkpoint fixture" }],
    pageCount: 1,
  };
  const sourceArtifact = await parent.put("paper_source", source);
  const id = randomUUID(),
    actorId = randomUUID();
  const run = {
    id,
    engine: "team-v1",
    protocolVersion: 6,
    ownerPid: process.pid,
    model: {
      provider: "codex-cli",
      model: "gpt-6-sol",
      reasoningEffort: "high",
    },
    sourceArtifact,
    paperSha256: source.paperSha256,
    status: "interrupted",
    revision: 4,
    resourcePolicy: policy,
    account: { turns: 7, startedAt: Date.now() - 60000 },
    tasks: [
      {
        id: actorId,
        role: "main",
        version: 1,
        status: "failed",
        notes: ["public checkpoint"],
        feedback: [],
        artifacts: [],
        waitingFor: [],
        dependsOn: [],
      },
      { id: randomUUID(), role: "task", status: "completed" },
      { id: randomUUID(), role: "task", status: "unresolved" },
    ],
    targets: [{ id: "target", contract: { targetHash: "unchanged" } }],
    objectives: [
      {
        id: "goal",
        kind: "lemma",
        title: "Controlled checkpoint",
        status: "proved",
        version: 2,
        dependencies: [],
        evidenceIds: [],
        history: [],
        attempts: [],
        sourceSpans: [],
        required: true,
      },
    ],
    operations: [],
    submissions: [],
    turns: [
      { id: randomUUID(), actorId, status: "unknown", error: "power loss" },
    ],
    receipts: [],
    executionIndex: [],
    proofReceiptIndex: [],
    messages: [],
    progressReports: [],
    conclusion: { wholePaperVerified: false },
    root: null,
  };
  async function seal() {
    const payload = { runId: id };
    for (const key of [
      "status",
      "model",
      "tasks",
      "targets",
      "objectives",
      "operations",
      "submissions",
      "turns",
      "resourcePolicy",
      "conclusion",
    ])
      payload[key] = run[key];
    run.root = await parent.put("team:report", payload, [
      sourceArtifact,
      ...run.receipts,
    ]);
    await parent.saveRun(run);
    return run.root;
  }
  await seal();
  const destinationRoot = path.join(dir, "child"),
    claimRoot = path.join(dir, "claims");
  const fork = () =>
    forkCheckpoint({
      sourceRoot: parent.root,
      destinationRoot,
      runId: id,
      paperSha256: source.paperSha256,
      claimRoot,
    });
  return { dir, parent, run, source, seal, destinationRoot, claimRoot, fork };
}

test("explicit continuation preserves proof checkpoints, unknown turns and budget, and only queues the coordinator", async (t) => {
  const f = await fixture(t),
    original = await readFile(
      path.join(f.parent.root, "runs", `${f.run.id}.json`),
    );
  const copied = await f.fork();
  const child = new EvidenceStore(f.destinationRoot),
    pumped = [];
  const runtime = new TeamRuntime({
    store: child,
    executor: {},
    resources: { policy },
    mathTools: {},
  });
  runtime.pump = (id) => pumped.push(id);
  const resumed = await runtime.resume(f.run.id, {
    expectedRoot: copied.parentRoot,
    authorization: "controlled user-authorized continuation",
  });
  assert.equal(resumed.status, "running");
  assert.equal(resumed.root, null);
  assert.deepEqual(resumed.objectives, f.run.objectives);
  assert.deepEqual(resumed.targets, f.run.targets);
  assert.deepEqual(resumed.turns, f.run.turns);
  assert.deepEqual(resumed.account, f.run.account);
  assert.deepEqual(
    resumed.tasks.map((x) => x.status),
    ["queued", "completed", "unresolved"],
  );
  assert.equal(resumed.tasks[0].version, 2);
  assert.equal(resumed.continuations[0].parentRoot, f.run.root);
  assert.equal(resumed.continuations[0].unknownRequestsReissued, false);
  assert.deepEqual(pumped, [f.run.id]);
  assert.deepEqual(
    await readFile(path.join(f.parent.root, "runs", `${f.run.id}.json`)),
    original,
  );
  await assert.rejects(
    runtime.resume(f.run.id, {
      expectedRoot: copied.parentRoot,
      authorization: "again",
    }),
    /already active/,
  );
});

test("foreign PDF, stale snapshot and active work cannot be imported", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    forkCheckpoint({
      sourceRoot: f.parent.root,
      destinationRoot: f.destinationRoot,
      runId: f.run.id,
      paperSha256: sha256("other"),
      claimRoot: f.claimRoot,
    }),
    /PDF bytes/,
  );
  f.run.objectives[0].status = "open";
  await f.parent.saveRun(f.run);
  await assert.rejects(f.fork(), /changed after sealing/);
  f.run.operations.push({ id: "unfinished", status: "running" });
  await f.seal();
  await assert.rejects(f.fork(), /unsettled/);
});

test("a sealed root gets only one successor claim, preventing duplicate model dispatch", async (t) => {
  const f = await fixture(t);
  await f.fork();
  await assert.rejects(
    forkCheckpoint({
      sourceRoot: f.parent.root,
      destinationRoot: path.join(f.dir, "duplicate"),
      runId: f.run.id,
      paperSha256: f.source.paperSha256,
      claimRoot: f.claimRoot,
    }),
    /already has a continuation claim/,
  );
});

test("missing authorization, changed budget and unknown protocol fail before dispatch", async (t) => {
  const f = await fixture(t);
  await f.fork();
  const runtime = new TeamRuntime({
    store: new EvidenceStore(f.destinationRoot),
    executor: {},
    resources: { policy: { ...policy, maxTurns: 9999 } },
    mathTools: {},
  });
  runtime.pump = () => assert.fail("must not dispatch");
  await assert.rejects(
    runtime.resume(f.run.id, { expectedRoot: f.run.root }),
    /authorization/,
  );
  await assert.rejects(
    runtime.resume(f.run.id, {
      expectedRoot: f.run.root,
      authorization: "user",
    }),
    /preserve the shared budget/,
  );
  f.run.protocolVersion = 8;
  await f.parent.saveRun(f.run);
  await assert.rejects(
    forkCheckpoint({
      sourceRoot: f.parent.root,
      destinationRoot: path.join(f.dir, "future"),
      runId: f.run.id,
      paperSha256: f.source.paperSha256,
      claimRoot: f.claimRoot,
    }),
    /protocol/,
  );
});

test("application HTTP reader and tool bridge expose the same continued checkpoint without dispatching old tasks", async (t) => {
  const f = await fixture(t);
  await f.fork();
  let app, resolveObserved;
  const observed = new Promise((resolve) => {
    resolveObserved = resolve;
  });
  const calls = [];
  app = await createApp({
    dataRoot: f.destinationRoot,
    teamOptions: {
      executor: {
        async run(ctx) {
          const session = app.team.sessions.get(ctx.token);
          calls.push(session.actorId);
          const response = await fetch(ctx.endpoint + "/call", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${ctx.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: "read_board",
              arguments: { section: "objectives" },
            }),
          });
          const board = await response.json();
          resolveObserved({ ok: response.ok, board });
          await new Promise((resolve, reject) => {
            if (ctx.signal.aborted) return reject(Error("cancelled"));
            ctx.signal.addEventListener(
              "abort",
              () => reject(Error("cancelled")),
              { once: true },
            );
          });
        },
      },
    },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await app.team.close();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  });
  const resumed = await app.team.resume(f.run.id, {
    expectedRoot: f.run.root,
    authorization: "controlled explicit user request",
  });
  const seen = await Promise.race([
    observed,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("tool bridge timeout")), 5000).unref(),
    ),
  ]);
  assert.equal(seen.ok, true);
  assert.equal(seen.board.objectives[0].status, "proved");
  assert.deepEqual(calls, [f.run.tasks[0].id]);
  const url = `http://127.0.0.1:${app.server.address().port}/api/reviews/${resumed.id}`;
  const viewResponse = await fetch(url);
  const view = await viewResponse.json();
  assert.equal(viewResponse.ok, true, JSON.stringify(view));
  assert.equal(view.status, "running");
  const paper = await (await fetch(url + "/source")).json();
  assert.equal(paper.paperSha256, f.source.paperSha256);
  assert.equal(paper.pageCount, 1);
  await app.team.cancel(f.run.id);
});
