import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LemmaProjects } from "../server/lemma-projects.mjs";
import { createContract } from "../server/contracts.mjs";
import {
  freshProofSession,
  assertProofSession,
  sameProofSession,
} from "../server/proof-autonomy.mjs";
import { EvidenceStore, sha256, digest } from "../server/evidence.mjs";
const c = createContract(
  {
    text: "fixture",
    artifact: sha256("s"),
    paperSha256: sha256("p"),
    pageIndex: 0,
  },
  {
    label: "fixture",
    quote: "fixture",
    statement: "fixture",
    assumptions: [],
    leanTarget: "True ∧ True",
  },
);
const plan = () => ({
  parts: [
    { name: "First", target: "True", purpose: "fixture fact", dependsOn: [] },
    {
      name: "Second",
      target: "True",
      purpose: "fixture conditional fact",
      dependsOn: ["First"],
    },
  ],
  assembly: "by intro h1 h2; exact ⟨h1,h2⟩",
});
const receipt = (c, p, o = {}) => ({
  targetHash: c.targetHash,
  mode: "proof",
  status: p === "bad" ? "not_verified" : "verified",
  exitCode: p === "bad" ? 1 : 0,
  axioms: [],
  stdout: p === "bad" ? "fixture compiler diagnostic" : "",
  dependencies: {
    complete: true,
    direct: [],
    edges: [],
    binderUse: Array(o.requiredBinders || 0).fill(true),
  },
});
test("lemma projects never assume missing helpers and preserve failed attempts", async () => {
  const seen = [],
    artifacts = [];
  const p = new LemmaProjects({
    contract: c,
    checker: async (c, p, o) => {
      seen.push({ c, p });
      return receipt(c, p, o);
    },
    persist: async (kind, payload) => {
      artifacts.push({ kind, payload });
      return digest({ kind, payload });
    },
  });
  const { projectId } = await p.plan(plan());
  assert.deepEqual((await p.assemble(projectId)).missing, ["First", "Second"]);
  assert.equal((await p.check(projectId, "Second", "bad")).accepted, false);
  assert.equal((await p.check(projectId, "Second", "bad")).repeated, true);
  await p.check(projectId, "First", "by trivial");
  assert.deepEqual((await p.assemble(projectId)).missing, ["Second"]);
  const conditional = await p.check(projectId, "Second", "by intro _; trivial");
  assert.match(conditional.contract.leanTarget, /∀ \(ProofPart_First/);
  const result = await p.assemble(projectId);
  assert.equal(result.accepted, true);
  assert.equal(seen.at(-1).c.targetHash, c.targetHash);
  assert.match(seen.at(-1).p, /have ProofPart_First/);
  assert.equal(
    artifacts.filter((a) => a.kind === "proof:lemma_check").length,
    3,
  );
});
test("lemma project validation rejects circular plans, root duplicates and supplied proof answers", async () => {
  const p = new LemmaProjects({
    contract: c,
    checker: receipt,
    persist: async () => sha256("a"),
  });
  const cycle = plan();
  cycle.parts[0].dependsOn = ["Second"];
  await assert.rejects(p.plan(cycle), /Cyclic/);
  const duplicate = plan();
  duplicate.parts[0].target = c.leanTarget;
  await assert.rejects(p.plan(duplicate), /repeat/);
  const seeded = plan();
  seeded.parts[0].proof = "by trivial";
  await assert.rejects(p.plan(seeded), /check_lemma/);
  await assert.rejects(
    p.plan(plan(), { projectId: "invented", name: "First" }),
    /Unknown/,
  );
});
test("fresh sessions reject old graphs and proof seeds, allowing only their own continuation", () => {
  const autonomy = freshProofSession();
  for (const input of [
    { seedGraph: {} },
    { theoremCandidate: {} },
    { resume: {} },
    { repairFrom: { autonomy: freshProofSession() } },
  ])
    assert.throws(() => assertProofSession(autonomy, input));
  assert.doesNotThrow(() =>
    assertProofSession(autonomy, { resume: { autonomy } }),
  );
  assert.equal(sameProofSession({ branch: {} }, autonomy), false);
  assert.equal(
    sameProofSession(
      { branch: { autonomySession: autonomy.sessionId } },
      autonomy,
    ),
    true,
  );
});

test("changing only a project's connection does not lose freshly rechecked helper proofs", async () => {
  let checks = 0;
  const p = new LemmaProjects({
    contract: c,
    checker: async (c, p, o) => {
      checks++;
      return receipt(c, p, o);
    },
    persist: async (k, v) => digest({ k, v }),
  });
  const first = await p.plan(plan());
  await p.check(first.projectId, "First", "by trivial");
  const revised = plan();
  revised.assembly = "by intro a b; constructor <;> trivial";
  const second = await p.plan(revised),
    before = checks;
  const rechecked = await p.check(second.projectId, "First", "by trivial");
  assert.equal(rechecked.accepted, true);
  assert.equal(checks, before + 1);
  assert.deepEqual((await p.assemble(second.projectId)).missing, ["Second"]);
});

test("fresh fallback lookup excludes historical cases before reading their proof bytes", async () => {
  const { retrieveCases } = await import("../server/knowledge.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-fresh-cases-")),
    store = new EvidenceStore(dir);
  await store.init();
  try {
    const old = freshProofSession(),
      current = freshProofSession();
    await store.saveRun({
      id: old.sessionId,
      status: "completed",
      contract: c,
      root: sha256("prior certificate"),
      autonomy: old,
    });
    let reads = 0;
    store.bundle = async () => {
      reads++;
      throw Error("must not import");
    };
    assert.deepEqual(await retrieveCases(store, c, { autonomy: current }), []);
    assert.equal(reads, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovery ownership prevents parallel translation and library repairs of one claim while other claims remain independent", async () => {
  const { activeFormalization } = await import("../server/autonomy-schema.mjs");
  const r = {
    tasks: [
      {
        id: "old",
        claimId: "A",
        kind: "formalize",
        childRunId: "old-child",
        childStatus: "awaiting_confirmation",
        childFinal: false,
      },
      { id: "repair", claimId: "A", kind: "recover_domain", status: "queued" },
      { id: "other", claimId: "B", kind: "inspect_proof", status: "running" },
    ],
  };
  assert.equal(
    activeFormalization(r, "A", { excludeChildId: "old-child" }).id,
    "repair",
  );
  assert.equal(activeFormalization(r, "B"), undefined);
  r.tasks[1].childRunId = "new-child";
  r.tasks[1].childStatus = "running";
  assert.equal(
    activeFormalization(r, "A", { excludeChildId: "old-child" }).id,
    "repair",
  );
  r.tasks[1].childFinal = true;
  assert.equal(
    activeFormalization(r, "A", { excludeChildId: "old-child" }),
    undefined,
  );
});
