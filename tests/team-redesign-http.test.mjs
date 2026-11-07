import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/index.mjs";
import { sha256 } from "../server/evidence.mjs";
import { budgetUsedMs } from "../server/resources/team-resources.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "redesign-http-"));
  let calls = 0;
  const app = await createApp({
    dataRoot: root,
    configProvider: async () => null,
    teamOptions: {
      executor: {},
      extract: async () => ({
        paperSha256: sha256("generic"),
        pdfBase64: Buffer.from("generic").toString("base64"),
        pageCount: 1,
        pages: [{ index: 0, text: "Generic engineering fixture" }],
      }),
      mathTools: {
        run: async (_, __, { signal }) => {
          calls++;
          await new Promise((resolve) =>
            signal.addEventListener("abort", () => setTimeout(resolve, 350), {
              once: true,
            }),
          );
          throw Error("controlled drain");
        },
      },
    },
  });
  app.team.pump = () => {};
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.team.close();
    await app.harness.close();
    await app.adaptive.close();
    await new Promise((r) => app.server.close(r));
    await rm(root, { force: true, recursive: true });
  });
  const saved = await app.team.start({ pdfBase64: "fixture" }),
    run = app.team.runs.get(saved.id),
    actor = run.tasks[0];
  actor.status = "running";
  return {
    app,
    root,
    run,
    actor,
    calls: () => calls,
    base: `http://127.0.0.1:${app.server.address().port}`,
    session: {
      runId: run.id,
      actorId: actor.id,
      signal: app.team.active.get(run.id).controller.signal,
      pending: new Set(),
    },
  };
}
test("real pause API closes admission before draining, then explicit resume retains active budget and unknown history", async (t) => {
  const f = await fixture(t);
  await f.app.team.operations.start(f.session, {
    operationId: randomUUID(),
    name: "lean_draft",
    arguments: { code: "-- controlled" },
  });
  while (!f.calls()) await sleep(5);
  const before = Date.now(),
    response = await fetch(`${f.base}/api/reviews/${f.run.id}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "HTTP pause acceptance" }),
    });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, "pausing");
  assert.ok(Date.now() - before < 1000);
  await assert.rejects(
    f.app.team.operations.start(f.session, {
      operationId: randomUUID(),
      name: "lean_draft",
      arguments: { code: "-- after" },
    }),
    /not running/,
  );
  await f.app.team.pauseJobs.get(f.run.id);
  const paused = await f.app.team.load(f.run.id);
  assert.equal(paused.status, "paused");
  assert.ok(paused.root);
  assert.equal(f.app.team.operations.jobs.size, 0);
  assert.equal(f.calls(), 1);
  const used = budgetUsedMs(paused.account),
    turns = paused.account.turns;
  await sleep(120);
  const resumed = await fetch(`${f.base}/api/reviews/${f.run.id}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRoot: paused.root }),
  });
  assert.equal(resumed.status, 202, await resumed.text());
  const run = await f.app.team.load(f.run.id);
  assert.equal(run.account.turns, turns);
  assert.ok(run.account.pausedMs - (paused.account.pausedMs || 0) >= 120);
  const resumedAt =
    paused.account.pausedAt +
    run.account.pausedMs -
    (paused.account.pausedMs || 0);
  assert.equal(budgetUsedMs(run.account, resumedAt), used);
  assert.equal(run.operations[0].status, "cancelled");
  assert.equal(f.calls(), 1);
});
test("pagination pins creation boundary while statuses update; read-only reader rejects all mutations without opening a writer", async (t) => {
  const f = await fixture(t);
  await f.app.team.edit(f.run.id, (r) => {
    for (let i = 0; i < 70; i++)
      r.operations.push({
        id: randomUUID(),
        actorId: f.actor.id,
        name: "engineering_fixture",
        status: "completed",
        startedAt: new Date().toISOString(),
      });
  });
  const first = await (
    await fetch(
      `${f.base}/api/reviews/${f.run.id}/operations?actor=${f.actor.id}&limit=25`,
    )
  ).json();
  assert.equal(first.items.length, 25);
  assert.equal(first.bound, 70);
  await f.app.team.edit(f.run.id, (r) =>
    r.operations.push({
      id: randomUUID(),
      actorId: f.actor.id,
      name: "new",
      status: "unknown",
    }),
  );
  const second = await (
    await fetch(
      `${f.base}/api/reviews/${f.run.id}/operations?actor=${f.actor.id}&limit=25&bound=${first.bound}&before=${first.nextBefore}`,
    )
  ).json();
  assert.equal(second.items.length, 25);
  assert.equal(second.bound, 70);
  assert.equal(
    new Set([...first.items, ...second.items].map((o) => o.id)).size,
    50,
  );
  await f.app.team.pause(f.run.id);
  const raw = await readFile(path.join(f.root, "runs", f.run.id + ".json"));
  const names = await readdir(f.root);
  const reader = await createApp({
    dataRoot: f.root,
    readOnly: true,
    configProvider: async () => null,
  });
  await new Promise((r) => reader.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reader.server.address().port}`;
  try {
    const publicRun = await (
      await fetch(`${url}/api/reviews/${f.run.id}`)
    ).json();
    assert.equal(publicRun.readOnly, true);
    for (const action of ["resume", "cancel", "pause", "replay"])
      assert.equal(
        (
          await fetch(`${url}/api/reviews/${f.run.id}/${action}`, {
            method: "POST",
            body: "{}",
          })
        ).status,
        403,
      );
    assert.equal(reader.team.operations.journal.worker, null);
    assert.deepEqual(await readdir(f.root), names);
    assert.deepEqual(
      await readFile(path.join(f.root, "runs", f.run.id + ".json")),
      raw,
    );
  } finally {
    await reader.team.close();
    await new Promise((r) => reader.server.close(r));
  }
});
