import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvidenceStore, sha256, digest } from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";
import { freshProofSession } from "../server/proof-autonomy.mjs";
import { ProofMemory } from "../server/proof-memory.mjs";
import { forkAutonomousSource } from "../scripts/fork-autonomous-source.mjs";

async function fixture(dir, foreign = false) {
  const store = new EvidenceStore(path.join(dir, "source"));
  await store.init();
  const sourceArtifact = await store.put("explicit_checkpoint_fixture", {
    text: "fixture",
  });
  const contract = createContract(
    {
      text: "fixture",
      paperSha256: sha256("fixture"),
      pageIndex: 0,
      artifact: sourceArtifact,
    },
    {
      label: "fixture",
      quote: "fixture",
      statement: "fixture",
      assumptions: [],
      leanTarget: "True",
    },
  );
  const autonomy = freshProofSession();
  const memory = await new ProofMemory(store).remember({
    contract,
    proof: "by trivial",
    scope: sha256("scope"),
    check: { status: "not_verified", targetHash: contract.targetHash },
    branch: {
      autonomySession: foreign
        ? freshProofSession().sessionId
        : autonomy.sessionId,
    },
  });
  const detail = await store.put("harness:model", { fixture: true });
  const harnessRoot = await store.put("harness:report", { fixture: true }, [
    detail,
  ]);
  const graph = { steps: [] },
    review = { checks: [] };
  const graphArtifact = await store.put("task:R06_GRAPH", {
    graph,
    model: { source: "deepagents-js", harnessRoot },
  });
  const reviewArtifact = await store.put("task:R06_ALIGN", { review });
  const contractArtifact = await store.put("contract", contract, [
    sourceArtifact,
  ]);
  const context = { pages: [{ pageIndex: 0, text: "fixture" }] };
  const contextArtifact = await store.put("context", context, [sourceArtifact]);
  const payload = {
    contract,
    targetHash: contract.targetHash,
    paperSha256: contract.paperSha256,
    sourceArtifact,
    contractArtifact,
    contextArtifact,
    context,
    autonomy,
    graph,
    graphArtifact,
    review,
    reviewArtifact,
    startedAt: "2026-10-20T00:00:00Z",
    endedAt: "2026-10-20T00:01:00Z",
    summary: { status: "partial" },
  };
  const root = await store.put("original_proof_report", payload, [
    sourceArtifact,
    contractArtifact,
    contextArtifact,
    graphArtifact,
    reviewArtifact,
    memory,
  ]);
  return { store, root, contract, memory, harnessRoot, detail, payload };
}
test("checkpoint fork preserves exact Agent output, repairs embedded receipt reachability and restores same-session candidate indexes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-checkpoint-"));
  try {
    const f = await fixture(dir),
      before = digest(await f.store.get(f.root));
    const out = await forkAutonomousSource(
      f.store.root,
      f.root,
      path.join(dir, "copy"),
    );
    assert.equal(out.suppliedMathematicalEdits, 0);
    assert.equal(out.restoredMemoryIndexes, 1);
    const copied = new EvidenceStore(out.store),
      run = await copied.getRun(out.runId);
    assert.equal(run.contract.targetHash, f.contract.targetHash);
    assert.equal(run.originalProofRoute.root, f.root);
    assert.equal(run.autonomy.sessionId, f.payload.autonomy.sessionId);
    assert.equal(digest(await f.store.get(f.root)), before);
    assert(
      (await copied.bundle(run.root)).artifacts.some((a) => a.id === f.detail),
    );
    assert.equal(
      (await new ProofMemory(copied).recall(sha256("scope"))).length,
      1,
    );
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(out.store, "proof-memory", f.memory + ".json"),
          "utf8",
        ),
      ).artifact,
      f.memory,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("checkpoint fork refuses foreign-session proof memory instead of relabeling it as autonomous work", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "lemma-checkpoint-foreign-"),
  );
  try {
    const f = await fixture(dir, true),
      dest = path.join(dir, "copy");
    await assert.rejects(
      forkAutonomousSource(f.store.root, f.root, dest),
      /another session/,
    );
    await assert.rejects(access(dest));
    assert.equal((await f.store.get(f.root)).id, f.root);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
