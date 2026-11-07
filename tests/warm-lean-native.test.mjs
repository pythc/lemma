import test from "node:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { WarmLeanPool } from "../server/lean-warm.mjs";
import { sandboxProfile } from "../server/lean.mjs";
import { nativeHostSnapshot } from "../server/resources/native-host.mjs";
const root = await realpath(".tools/lean-4.35.0-darwin_aarch64"),
  env = {
    runtime: { toolRoot: root, binary: path.join(root, "bin/lean") },
    library: { searchPaths: [] },
  };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test("warm exact document versions distinguish invalid code and retain no certificate claim", async (t) => {
  const pool = new WarmLeanPool();
  t.after(() => pool.close());
  const good = await pool.run(
    "import Lean\nexample : True := by trivial\n",
    env,
    sandboxProfile,
  );
  const bad = await pool.run(
    "import Lean\nexample : False := by trivial\n",
    env,
    sandboxProfile,
  );
  const repaired = await pool.run(
    "import Lean\nexample : True := by trivial\n",
    env,
    sandboxProfile,
  );
  assert.equal(good.exitCode, 0);
  assert.equal(bad.exitCode, 1);
  assert.equal(repaired.exitCode, 0);
  assert.equal(repaired.workerEpoch, good.workerEpoch);
  assert.equal(repaired.documentVersion, 3);
  assert.equal(repaired.scope, "diagnostic_only_not_a_certificate");
  await sleep(550);
  assert.equal((await nativeHostSnapshot()).running, 0);
});
test("three actual warm computations occupy host slots and cancellation drains all groups", async (t) => {
  const pool = new WarmLeanPool();
  t.after(() => pool.close());
  const controller = new AbortController();
  const work = [0, 1, 2].map((i) =>
    pool.run(
      `import Lean\n#eval IO.sleep 10000\n#check ${i}\n`,
      env,
      sandboxProfile,
      { signal: controller.signal },
    ),
  );
  const outcomes = Promise.allSettled(work);
  let peak = 0;
  for (let i = 0; i < 80; i++) {
    peak = Math.max(peak, (await nativeHostSnapshot()).running || 0);
    if (peak === 3) break;
    await sleep(100);
  }
  assert.equal(peak, 3);
  controller.abort(Error("controlled cancellation"));
  const settled = await outcomes;
  assert.ok(settled.every((r) => r.status === "rejected"));
  await sleep(550);
  assert.equal((await nativeHostSnapshot()).running, 0);
  assert.equal(pool.clients.length, 0);
});

test("supervisor SIGKILL invalidates the warm context and reaps its owned native group", async (t) => {
  const pool = new WarmLeanPool();
  t.after(() => pool.close());
  const work = pool.run(
    "import Lean\n#eval IO.sleep 10000\n",
    env,
    sandboxProfile,
  );
  const outcome = work.then(
    () => null,
    (e) => e,
  );
  let client;
  for (let i = 0; i < 100; i++) {
    client = pool.clients[0];
    if (client?.nativePid) break;
    await sleep(30);
  }
  assert.ok(client?.nativePid);
  client.child.kill("SIGKILL");
  const error = await outcome;
  assert.match(error.message, /exited/);
  await sleep(550);
  assert.equal((await nativeHostSnapshot()).running, 0);
  assert.equal(pool.clients.length, 0);
  const next = await pool.run(
    "import Lean\nexample : True := by trivial\n",
    env,
    sandboxProfile,
  );
  assert.notEqual(next.workerEpoch, client.epoch);
  assert.equal(next.exitCode, 0);
});
