import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { TeamRuntime } from "../server/team/runtime.mjs";
import { TeamResources } from "../server/resources/team-resources.mjs";
import { EvidenceStore } from "../server/evidence.mjs";
test("process death restores newer committed projection and known receipt without launching a model", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "projection-crash-"));
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  });
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("./helpers/team-projection-crash.mjs", import.meta.url),
      ),
      root,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "",
    err = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (err += b));
  await new Promise((r) => child.once("close", r));
  assert.ok(out.trim(), err);
  const ids = JSON.parse(out.trim());
  const raw = JSON.parse(
    await readFile(path.join(root, "runs", ids.runId + ".json")),
  );
  assert.equal(raw.operations.length, 0);
  let calls = 0;
  runtime = new TeamRuntime({
    store: new EvidenceStore(root),
    resources: new TeamResources(),
    executor: {
      run: () => {
        calls++;
      },
    },
    mathTools: {},
  });
  await runtime.init();
  const recovered = await runtime.load(ids.runId);
  assert.equal(recovered.status, "interrupted");
  assert.ok(recovered.root);
  assert.equal(recovered.operations.length, 1);
  assert.equal(recovered.operations[0].status, "completed");
  assert.equal(calls, 0);
  assert.equal(
    (await runtime.operations.get(ids.runId, ids.operationId)).result.value,
    "known result",
  );
});
