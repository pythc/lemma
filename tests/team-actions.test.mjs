import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { TeamRuntime } from "../server/team/runtime.mjs";
import { TeamResources } from "../server/resources/team-resources.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";

async function fixture(
  t,
  work = async () => ({ value: "received diagnostic" }),
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-actions-"));
  let calls = 0;
  const runtime = new TeamRuntime({
    store: new EvidenceStore(root),
    resources: new TeamResources(),
    executor: {},
    mathTools: {
      run: async (...args) => {
        calls++;
        return work(...args);
      },
    },
    extract: async () => ({
      paperSha256: sha256("engineering"),
      pageCount: 1,
      pages: [{ index: 0, text: "Generic engineering fixture" }],
    }),
  });
  runtime.pump = () => {};
  await runtime.init();
  const saved = await runtime.start({ pdfBase64: "engineering" });
  const run = runtime.runs.get(saved.id),
    actor = run.tasks[0];
  actor.status = "running";
  const session = {
    runId: run.id,
    actorId: actor.id,
    signal: runtime.active.get(run.id).controller.signal,
    pending: new Set(),
  };
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const start = (args = {}, id = randomUUID(), extra = {}) =>
    runtime.operations.start(session, {
      operationId: id,
      name: "lean_draft",
      arguments: { code: "-- diagnostic fixture", ...args },
      ...extra,
    });
  const settle = async (id) => {
    await runtime.operations.jobs.get(id);
    return runtime.operations.get(run.id, id);
  };
  return {
    runtime,
    run,
    actor,
    session,
    start,
    settle,
    calls: () => calls,
    root,
  };
}

test("same actor/version and logical check reconnects across a new request UUID while executing", async (t) => {
  const f = await fixture(t, async (name, args, { signal }) => {
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    throw Error("controlled cancellation");
  });
  const first = await f.start(),
    second = await f.start();
  assert.equal(second.operationId, first.operationId);
  for (let i = 0; i < 100 && !f.calls(); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.calls(), 1);
});

test("received unchanged diagnostic is retrieved, explicit fresh intent and changed input still execute", async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  await f.settle(first.operationId);
  const old = await f.start();
  assert.equal(old.operationId, first.operationId);
  assert.equal(old.delivery, "received_result");
  const fresh = await f.start({
    _execution: { mode: "new", reason: "Independent repeated measurement" },
  });
  await f.settle(fresh.operationId);
  assert.notEqual(fresh.operationId, first.operationId);
  const changed = await f.start({ code: "-- changed diagnostic" });
  await f.settle(changed.operationId);
  assert.equal(f.calls(), 3);
  f.actor.version++;
  const version = await f.start();
  await f.settle(version.operationId);
  assert.notEqual(version.operationId, first.operationId);
});

test("unknown original execution is not silently retried by a new UUID", async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  await f.settle(first.operationId);
  const op = f.run.operations[0];
  op.status = "unknown";
  op.artifactId = null;
  const next = await f.start();
  assert.equal(next.operationId, first.operationId);
  assert.equal(next.status, "unknown");
  assert.equal(f.calls(), 1);
});

test("pause drains execution, seals its reason and does not dispatch or erase unknown work", async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  await f.settle(first.operationId);
  const paused = await f.runtime.pause(f.run.id, {
    reason: "Controlled user pause",
  });
  assert.equal(paused.status, "paused");
  assert.ok(paused.root);
  assert.equal(paused.pause.reason, "Controlled user pause");
  assert.equal(f.runtime.operations.jobs.size, 0);
  await assert.rejects(
    f.start({ code: "-- after pause" }),
    /not running|paused/,
  );
  const again = await f.runtime.pause(f.run.id, { reason: "Repeated click" });
  assert.equal(again.root, paused.root);
});

test("lost projection after received-result commit retains a known outcome", async (t) => {
  const f = await fixture(t),
    save = f.runtime.projection.save.bind(f.runtime.projection);
  let failed = false;
  f.runtime.projection.save = async (run) => {
    if (!failed && run.operations.some((o) => o.status === "completed")) {
      failed = true;
      throw Error("controlled projection fault");
    }
    return save(run);
  };
  const op = await f.start();
  const result = await f.settle(op.operationId);
  assert.equal(failed, true);
  assert.equal(result.status, "completed");
  assert.equal(f.calls(), 1);
});
test("transport alias lookup works through HTTP even when response to its admission was lost", async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  await f.settle(first.operationId);
  const transport = randomUUID();
  await f.start({}, transport);
  f.runtime.sessions.set("fixture", f.session);
  const response = await fetch(f.runtime.endpoint + "/operations/get", {
    method: "POST",
    headers: {
      authorization: "Bearer fixture",
      "content-type": "application/json",
    },
    body: JSON.stringify({ operationId: transport }),
  });
  assert.equal(response.status, 200);
  const received = await response.json();
  assert.equal(received.operationId, first.operationId);
  assert.equal(received.status, "completed");
  assert.equal(f.calls(), 1);
});
test("idle public JSON catches the latest committed projection without a later tool call", async (t) => {
  const f = await fixture(t);
  await f.runtime.edit(f.run.id, (r) => {
    r.title = "new public state";
  });
  await new Promise((r) => setTimeout(r, 1200));
  const { readFile } = await import("node:fs/promises");
  const saved = JSON.parse(
    await readFile(path.join(f.root, "runs", f.run.id + ".json"), "utf8"),
  );
  assert.equal(saved.title, "new public state");
  assert.equal(saved.revision, f.run.revision);
});

test("a distinct independent acceptance actor performs its own first check", async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  await f.settle(first.operationId);
  const acceptor = f.runtime.task(
    "acceptance",
    "Independent fixture",
    "Engineering only",
    "Engineering only",
    f.actor.id,
  );
  await f.runtime.edit(f.run.id, (r) => {
    acceptor.status = "running";
    r.tasks.push(acceptor);
  });
  const session = { ...f.session, actorId: acceptor.id, pending: new Set() };
  const op = await f.runtime.operations.start(session, {
    operationId: randomUUID(),
    name: "lean_draft",
    arguments: { code: "-- diagnostic fixture" },
  });
  await f.settle(op.operationId);
  assert.notEqual(op.operationId, first.operationId);
  assert.equal(f.calls(), 2);
  const found = await f.runtime.operations.start(session, {
    operationId: randomUUID(),
    name: "lean_draft",
    arguments: { code: "-- diagnostic fixture" },
  });
  assert.equal(found.operationId, op.operationId);
  assert.equal(f.calls(), 2);
});
