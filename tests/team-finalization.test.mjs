import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EvidenceStore } from "../server/evidence.mjs";
import { finalizeTeamPaper } from "../server/team/finalization.mjs";
async function fixture(t, checker) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "finalize-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new EvidenceStore(path.join(dir, "store"));
  await store.init();
  const id = randomUUID(),
    proof = await store.put("team:lean", {
      runId: id,
      result: {
        contract: {},
        proof: "engineering fixture",
        mode: "proof",
        result: { status: "verified", targetHash: "fixture" },
      },
    });
  const root = await store.put("team:report", { runId: id }, [proof]);
  const run = {
    id,
    root,
    status: "completed",
    operations: [],
    submissions: [{ status: "pass", replayIds: [proof] }],
    objectives: [],
    model: {},
    conclusion: { wholePaperVerified: false },
  };
  return {
    store,
    out: path.join(dir, "out"),
    runId: id,
    team: { load: async () => run, math: { checker } },
  };
}
test("delivery retry reuses persisted replay result and does not execute twice", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return { status: "verified", targetHash: "fixture" };
  });
  assert.equal((await finalizeTeamPaper(f)).status, "complete");
  assert.equal((await finalizeTeamPaper(f)).status, "complete");
  assert.equal(calls, 1);
  const report = JSON.parse(
    await readFile(path.join(f.out, "result-report.json")),
  );
  assert.equal(report.wholePaperVerified, false);
});
test("lost replay acknowledgement stays unknown and report remains readable", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    throw Error("controlled response loss");
  });
  assert.equal((await finalizeTeamPaper(f)).status, "incomplete");
  assert.equal((await finalizeTeamPaper(f)).status, "incomplete");
  assert.equal(calls, 1);
  assert.match(
    await readFile(path.join(f.out, "result-report.md"), "utf8"),
    /incomplete/,
  );
});

test("pure byte export repairs a missing bundle without repeating replay", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return { status: "verified" };
  });
  await finalizeTeamPaper(f);
  await rm(path.join(f.out, "bundle.json"));
  assert.equal((await finalizeTeamPaper(f)).status, "complete");
  assert.equal(calls, 1);
  const bundle = JSON.parse(await readFile(path.join(f.out, "bundle.json")));
  assert.ok(bundle);
});
test("bounded inventory failure does not suppress raw byte export or known replay", async (t) => {
  const f = await fixture(t, async () => ({ status: "verified" }));
  const rawGet = f.store.get.bind(f.store);
  const run = await f.team.load();
  // Canonical but malformed inventory payload: raw bytes remain exportable.
  const bad = await f.store.put("team:search", null);
  run.root = await f.store.put("team:report", { runId: run.id }, [
    run.root,
    bad,
  ]);
  const done = await finalizeTeamPaper(f);
  assert.equal(done.status, "incomplete");
  assert.equal(done.inventory, "failed");
  assert.equal(done.export, "complete");
  assert.equal(done.replay, "complete");
});
test("invalid replay references leave a usable report and never dispatch", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return { status: "verified" };
  });
  const run = await f.team.load();
  run.submissions[0].replayIds = [run.root];
  const done = await finalizeTeamPaper(f);
  assert.equal(done.status, "incomplete");
  assert.equal(calls, 0);
  assert.match(
    await readFile(path.join(f.out, "replay.jsonl"), "utf8"),
    /invalid_candidate/,
  );
});
