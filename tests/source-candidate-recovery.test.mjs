import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvidenceStore, sha256, digest } from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";
import { obligationContract } from "../server/proof-decomposition.mjs";
import { freshProofSession } from "../server/proof-autonomy.mjs";
import { recoverReceivedSourceCandidates } from "../server/source-candidates.mjs";
async function fixture(action) {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "lemma-received-candidates-"),
  );
  const store = new EvidenceStore(dir);
  await store.init();
  const source = await store.put("explicit_candidate_recovery_fixture", {
    text: "fixture",
  });
  const contract = createContract(
    {
      text: "fixture",
      artifact: source,
      paperSha256: sha256("fixture"),
      pageIndex: 0,
    },
    {
      label: "fixture",
      quote: "fixture",
      statement: "fixture",
      assumptions: [],
      leanTarget: "(∀ n : Nat, n = n) ∧ True",
    },
  );
  const graph = {
    steps: [
      { name: "Fact", target: "∀ n : Nat, n = n", dependsOn: [], anchors: [] },
    ],
  };
  const autonomy = freshProofSession(),
    local = obligationContract(contract, "Fact", graph.steps[0].target, []);
  const memory = async (overrides = {}) =>
    store.put(
      "proof:memory",
      {
        contract: local,
        proof: "by intro n; rfl",
        mode: "proof",
        branch: { autonomySession: autonomy.sessionId },
        check: {
          status: "verified",
          targetHash: local.targetHash,
          mode: "proof",
          exitCode: 0,
          axioms: [],
        },
        audit: { status: "route_violation", hits: ["fixture_old_policy"] },
        ...overrides,
      },
      [source],
    );
  const owner = async (inputs = []) =>
    store.put(
      "original_proof_report",
      {
        contract,
        graph,
        autonomy,
        sourceArtifact: source,
        targetHash: contract.targetHash,
      },
      [source, ...inputs],
    );
  try {
    await action({ store, contract, graph, autonomy, local, memory, owner });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("a native-checked intermediate term survives a changed policy without inheriting route acceptance", async () =>
  fixture(async (o) => {
    const m = await o.memory(),
      root = await o.owner([m]);
    const r = await recoverReceivedSourceCandidates({ ...o, root });
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].artifact, m);
    assert.equal(r.candidates[0].value.proof, "by intro n; rfl");
    assert.equal(r.candidates[0].accepted, undefined);
    assert.match(r.candidates[0].value.explanation, /重新/);
    assert((await o.store.get(r.artifact)).inputs.includes(m));
  }));
test("foreign sessions, different root obligations and unreceived or failed terms remain excluded", async () =>
  fixture(async (o) => {
    const good = await o.memory();
    const foreign = await o.memory({
      branch: { autonomySession: freshProofSession().sessionId },
    });
    const failed = await o.memory({
      check: { status: "not_verified", targetHash: o.local.targetHash },
    });
    const wrong = {
      ...o.local,
      proofObligation: {
        ...o.local.proofObligation,
        rootTargetHash: sha256("other"),
      },
    };
    delete wrong.targetHash;
    wrong.targetHash = digest(wrong);
    const other = await o.memory({
      contract: wrong,
      check: { status: "verified", targetHash: wrong.targetHash },
    });
    const orphan = await o.memory({ proof: "by intro n; exact Eq.refl n" });
    const root = await o.owner([good, foreign, failed, other]);
    const r = await recoverReceivedSourceCandidates({ ...o, root });
    assert.deepEqual(
      r.candidates.map((c) => c.artifact),
      [good],
    );
    assert(!r.candidates.some((c) => c.artifact === orphan));
  }));
test("changed mathematical metadata is not a candidate merely because its displayed proposition is equal", async () =>
  fixture(async (o) => {
    const changed = { ...o.local, statement: "changed metadata" };
    delete changed.targetHash;
    changed.targetHash = digest(changed);
    const m = await o.memory({
      contract: changed,
      check: { status: "verified", targetHash: changed.targetHash },
    });
    const r = await recoverReceivedSourceCandidates({
      ...o,
      root: await o.owner([m]),
    });
    assert.equal(r.candidates.length, 0);
  }));
test("same-session checkpoint forks are checked against the immutable source report, not their mutable wrapper", async () =>
  fixture(async (o) => {
    const m = await o.memory(),
      root = await o.owner([m]);
    const owner = await o.store.get(root);
    const fork = await o.store.put(
      "autonomous_source_checkpoint_origin",
      {
        sourceRoot: root,
        sourceReportSha256: digest(owner.payload),
        autonomy: o.autonomy,
      },
      [root],
    );
    assert.equal(
      (await recoverReceivedSourceCandidates({ ...o, root: fork })).candidates
        .length,
      1,
    );
    const bad = await o.store.put(
      "autonomous_source_checkpoint_origin",
      {
        sourceRoot: root,
        sourceReportSha256: sha256("wrong"),
        autonomy: o.autonomy,
      },
      [root],
    );
    await assert.rejects(
      recoverReceivedSourceCandidates({ ...o, root: bad }),
      /origin changed/,
    );
  }));
test("a source or target version change cannot reinterpret old memory as a fresh proof", async () =>
  fixture(async (o) => {
    const m = await o.memory(),
      root = await o.owner([m]);
    const changed = { ...o.contract, statement: "revised target version" };
    delete changed.targetHash;
    changed.targetHash = digest(changed);
    assert.equal(
      (await recoverReceivedSourceCandidates({ ...o, contract: changed, root }))
        .candidates.length,
      0,
    );
    await assert.rejects(
      recoverReceivedSourceCandidates({
        ...o,
        autonomy: freshProofSession(),
        root,
      }),
      /Agent.source session/,
    );
    assert.equal(
      (await recoverReceivedSourceCandidates({ ...o, autonomy: null, root }))
        .candidates.length,
      0,
    );
  }));

test("a blocked source review may recover received terms without replaying its unknown model request", async () =>
  fixture(async (o) => {
    const m = await o.memory();
    const root = await o.store.put(
      "original_proof_interrupted",
      {
        runId: "fixture",
        paperSha256: o.contract.paperSha256,
        partial: {
          autonomy: o.autonomy,
          targetHash: o.contract.targetHash,
          graph: o.graph,
        },
      },
      [o.contract.sourceArtifact, m],
    );
    assert.equal(
      (await recoverReceivedSourceCandidates({ ...o, root })).candidates.length,
      1,
    );
  }));
test("only a completed worker with an immutable matching owner can restore an omitted intermediate receipt", async () =>
  fixture(async (o) => {
    const { randomUUID } = await import("node:crypto");
    const m = await o.memory(),
      root = await o.owner();
    const id = randomUUID(),
      workerId = randomUUID();
    await o.store.saveRun({
      id,
      engine: "original-proof-v1",
      status: "completed",
      autonomy: o.autonomy,
      contract: o.contract,
      root,
      originalProofRoute: { root },
    });
    const workerRoot = await o.store.put(
      "harness:report",
      { runId: workerId, contract: o.local },
      [m],
    );
    await o.store.saveRun({
      id: workerId,
      engine: "deepagents-v1",
      status: "completed",
      parentReviewId: id,
      contract: o.local,
      root: workerRoot,
    });
    const r = await recoverReceivedSourceCandidates({ ...o, root });
    assert.equal(r.candidates.length, 1);
    assert((await o.store.get(r.artifact)).inputs.includes(workerRoot));
    const forgedOwner = await o.store.getRun(id);
    forgedOwner.autonomy = freshProofSession();
    await o.store.saveRun(forgedOwner);
    assert.equal(
      (await recoverReceivedSourceCandidates({ ...o, root })).candidates.length,
      0,
    );
  }));

test("a success label with an unapproved axiom is not a verified candidate", async () =>
  fixture(async (o) => {
    const m = await o.memory({
      check: {
        status: "verified",
        targetHash: o.local.targetHash,
        mode: "proof",
        exitCode: 0,
        axioms: ["sorryAx"],
      },
    });
    const r = await recoverReceivedSourceCandidates({
      ...o,
      root: await o.owner([m]),
    });
    assert.equal(r.candidates.length, 0);
  }));
