import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { receivedLibraries } from "../server/execution-libraries.mjs";
test("only this stage's actual reachable installation receipts can select external dependencies", async () => {
  const dir = await mkdtemp(
      path.join(os.tmpdir(), "lemma-received-libraries-"),
    ),
    store = new EvidenceStore(dir);
  await store.init();
  try {
    const id = sha256("library fixture"),
      tool = await store.put("harness:tool", {
        runId: "own",
        name: "install_library",
        value: { id, modules: ["Fixture.Module"] },
      });
    const other = await store.put("harness:tool", {
      runId: "foreign",
      name: "install_library",
      value: { id: sha256("foreign"), modules: ["Foreign.Module"] },
    });
    const root = await store.put("harness:report", { runId: "own" }, [
      tool,
      other,
    ]);
    const record = {
      source: "deepagents-js",
      harnessRunId: "own",
      harnessRoot: root,
    };
    assert.equal((await receivedLibraries(store, record, [id]))[0].id, id);
    await assert.rejects(receivedLibraries(store, record, [sha256("foreign")]));
    await assert.rejects(
      receivedLibraries(store, { ...record, harnessRunId: "other" }, [id]),
    );
    await assert.rejects(
      receivedLibraries(store, { source: "model_opinion" }, [id]),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
