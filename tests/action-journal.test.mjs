import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ActionJournal } from "../server/team/action-journal.mjs";
const command = (runId = randomUUID()) => ({
  runId,
  actorId: "actor",
  requestId: randomUUID(),
  fingerprint: "f",
  logicalKey: "k",
  coalesce: true,
  operation: {
    id: randomUUID(),
    actorId: "actor",
    version: 1,
    name: "check_lean",
    fingerprint: "f",
    logicalKey: "k",
  },
});
async function temp(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "journal-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}
test("exclusive store owner prevents another live runtime from claiming any work", async (t) => {
  const root = await temp(t),
    a = new ActionJournal(root),
    b = new ActionJournal(root);
  t.after(() => a.close());
  t.after(() => b.close());
  await a.call("health");
  await assert.rejects(b.call("health"), /live owner/);
  assert.equal((await a.call("claim", command())).created, true);
});
test("caller and transport identities reconnect, input or actor conflicts fail before execution", async (t) => {
  const a = new ActionJournal(await temp(t));
  t.after(() => a.close());
  const args = { ...command(), transportId: randomUUID() };
  const claim = await a.call("claim", args);
  assert.equal(
    (await a.call("get", { runId: args.runId, id: args.transportId })).id,
    claim.action.id,
  );
  await assert.rejects(
    a.call("claim", { ...args, actorId: "foreign" }),
    /different input or actor/,
  );
});
test("crash after dispatch intent leaves unknown, including explicit new request; no automatic replay", async (t) => {
  const root = await temp(t),
    args = command(),
    script = path.join(root, "crash.mjs");
  await writeFile(
    script,
    `import {ActionJournal} from ${JSON.stringify(new URL("../server/team/action-journal.mjs", import.meta.url).href)};const j=new ActionJournal(${JSON.stringify(root)});const a=await j.call('claim',${JSON.stringify(args)});await j.call('update',{runId:${JSON.stringify(args.runId)},id:a.action.id,patch:{status:'dispatching',executionDispatched:true}});process.stdout.write('committed\\n');process.kill(process.pid,'SIGKILL');`,
  );
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  await new Promise((r) => child.once("close", r));
  assert.match(output, /committed/);
  const a = new ActionJournal(root);
  t.after(() => a.close());
  const original = await a.call("get", {
    runId: args.runId,
    id: args.requestId,
  });
  assert.equal(original.status, "unknown");
  const again = await a.call("claim", {
    ...args,
    requestId: randomUUID(),
    forceNew: true,
    operation: { ...args.operation, id: randomUUID() },
  });
  assert.equal(again.created, false);
  assert.equal(again.action.status, "unknown");
  assert.equal(again.action.id, original.id);
});

test("alias conflicts and actor-version changes cannot redirect an acknowledged action", async (t) => {
  const j = new ActionJournal(await temp(t));
  t.after(() => j.close());
  const a = command(),
    b = { ...command(a.runId), logicalKey: "second" };
  const first = await j.call("claim", a);
  await j.call("claim", b);
  await assert.rejects(
    j.call("claim", { ...a, transportId: b.requestId }),
    /another action/,
  );
  await assert.rejects(
    j.call("claim", { ...a, logicalKey: "new-version" }),
    /different input or actor version/,
  );
  assert.equal(
    (await j.call("get", { runId: a.runId, id: a.requestId })).id,
    first.action.id,
  );
});
test("received terminal event repairs a stale projection without redispatch and survives segment import", async (t) => {
  const root = await temp(t),
    j = new ActionJournal(root);
  t.after(() => j.close());
  const a = { ...command(), transportId: randomUUID() };
  const first = await j.call("claim", a);
  await j.call("update", {
    runId: a.runId,
    id: first.action.id,
    patch: { status: "completed", receivedOutcome: { value: "acknowledged" } },
  });
  const repaired = await j.call("reconcile", {
    runId: a.runId,
    operations: [{ id: first.action.id, status: "dispatching" }],
  });
  assert.equal(repaired[0].status, "completed");
  const events = await j.call("events", { runId: a.runId });
  const imported = new ActionJournal(await temp(t));
  t.after(() => imported.close());
  await imported.call("importEvents", { runId: a.runId, events });
  assert.equal(
    (await imported.call("get", { runId: a.runId, id: a.transportId }))
      .receivedOutcome.value,
    "acknowledged",
  );
});
