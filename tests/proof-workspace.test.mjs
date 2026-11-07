import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvidenceStore, sha256, digest } from "../server/evidence.mjs";
import {
  createContract,
  withExecutionEnvironment,
  withDefaultExecutionEnvironment,
  validateContract,
} from "../server/contracts.mjs";
import {
  ProofMemory,
  proofMemoryScope,
  branchPlan,
} from "../server/proof-memory.mjs";
import { proofBlueprint, checkBlueprint } from "../server/proof-workspace.mjs";
const c = createContract(
  {
    paperSha256: sha256("paper"),
    pageIndex: 0,
    text: "source",
    artifact: sha256("source"),
  },
  {
    label: "test",
    quote: "source",
    statement: "test",
    assumptions: [],
    leanTarget: "1 = 1",
  },
);
const descriptor = {
  id: "lean-4.34.1",
  version: "4.34.1",
  receiptSha256: sha256("receipt"),
  distributionSha256: sha256("tree"),
  librarySha256: digest([]),
  libraryRevision: "lean-4.34.1-std",
};
test("interfaces capture exact consumer targets; preflight never treats a signature as a proved lemma", async () => {
  const b = proofBlueprint(
    {
      steps: [
        {
          name: "A",
          title: "A",
          kind: "explicit",
          anchors: [],
          target: "1=1",
          dependsOn: [],
        },
        {
          name: "B",
          title: "B",
          kind: "omitted",
          anchors: [],
          target: "2=2",
          dependsOn: ["A"],
        },
      ],
    },
    c,
  );
  assert.deepEqual(b.parts[0].consumers, ["B"]);
  assert.match(b.parts[1].contract.leanTarget, /ProofPart_A/);
  const seen = [];
  const r = await checkBlueprint(b, async (t, p) => {
    seen.push({ t, p });
    return {
      status: "verified",
      targetHash: t.targetHash,
      mode: "proof",
      exitCode: 0,
      axioms: [],
    };
  });
  assert.equal(seen.length, 1);
  assert.equal(r.status, "well_typed");
  assert.match(r.scope, /only/);
  assert(
    seen.every(
      (v) =>
        v.t.leanTarget.includes("→ True") &&
        v.p.includes("by intro _; trivial"),
    ),
  );
});
test("proof memory survives restart, isolates changed context, target, policy and toolchain, and detects tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "proof-memory-"));
  try {
    const store = new EvidenceStore(root);
    await store.init();
    const m = new ProofMemory(store);
    const scope = proofMemoryScope(c, {
      context: "source",
      policy: { forbidden: ["Root"] },
    });
    const artifact = await m.remember({
      contract: c,
      proof: "by rfl",
      scope,
      check: {
        targetHash: c.targetHash,
        status: "not_verified",
        failureKind: "proof_rejected",
        stdout: "unknown identifier",
      },
      branch: branchPlan(1, "parent"),
    });
    const fresh = new ProofMemory(store);
    assert.equal((await fresh.recall(scope))[0].lesson.kind, "proof_rejected");
    for (const other of [
      proofMemoryScope(c),
      proofMemoryScope(c, {
        context: "changed",
        policy: { forbidden: ["Root"] },
      }),
      proofMemoryScope(withExecutionEnvironment(c, descriptor), {
        context: "source",
        policy: { forbidden: ["Root"] },
      }),
    ])
      assert.equal((await fresh.recall(other)).length, 0);
    assert.notEqual(branchPlan(0).strategy, branchPlan(1).strategy);
    await writeFile(path.join(root, "artifacts", `${artifact}.json`), "{}");
    await assert.rejects(fresh.recall(scope), /摘要/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("environment changes are new contracts and cannot transplant unregistered paths or change a proposition", () => {
  const n = withExecutionEnvironment(c, descriptor);
  assert.notEqual(n.targetHash, c.targetHash);
  assert.equal(n.leanTarget, c.leanTarget);
  assert.equal(validateContract(n), n);
  assert.equal(withDefaultExecutionEnvironment(n).targetHash, c.targetHash);
  assert.throws(() =>
    withExecutionEnvironment(c, { ...descriptor, path: "/tmp/untrusted" }),
  );
  assert.throws(() => validateContract({ ...n, leanTarget: "False" }));
});

test("repairing unrelated decorative edges cannot conceal a known unused predecessor", async () => {
  const { unresolvedInterfaceLinks } =
    await import("../server/proof-workspace.mjs");
  const graph = {
    steps: [
      { name: "S1", target: "A", dependsOn: [] },
      { name: "S2", target: "B", dependsOn: ["S1"] },
      { name: "S3", target: "C", dependsOn: ["S2"] },
      { name: "S5", target: "D", dependsOn: ["S3"] },
    ],
  };
  const previous = {
    graph,
    steps: [
      { name: "S2", check: { dependencies: { binderUse: [true] } } },
      { name: "S3", check: { dependencies: { binderUse: [false] } } },
    ],
    assembly: { audit: { missingSourceSteps: ["S1", "S2"] } },
  };
  const revised = structuredClone(graph);
  revised.steps[3].dependsOn = [];
  assert.deepEqual(unresolvedInterfaceLinks(revised, previous), ["S1", "S2"]);
  revised.steps[1].target = "StrongerB";
  assert.deepEqual(unresolvedInterfaceLinks(revised, previous), []);
});

test("harness checks competing branches concurrently and persists success and failure separately", async () => {
  const { DeepProofHarness } = await import("../server/deep-harness.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "proof-branches-"));
  const store = new EvidenceStore(root);
  await store.init();
  const source = await store.put("explicit_branch_unit_fixture", {
    text: "source",
  });
  const contract = createContract(
    {
      paperSha256: sha256("source"),
      pageIndex: 0,
      text: "source",
      artifact: source,
    },
    {
      label: "test",
      quote: "source",
      statement: "test",
      assumptions: [],
      leanTarget: "1=1",
    },
  );
  let calls = 0,
    active = 0,
    peak = 0;
  const harness = new DeepProofHarness({
    store,
    checker: async (c, p) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return {
        targetHash: c.targetHash,
        status: p === "by rfl" ? "verified" : "not_verified",
        mode: "proof",
        exitCode: p === "by rfl" ? 0 : 1,
        axioms: [],
        failureKind: p === "by rfl" ? null : "proof_rejected",
      };
    },
    model: async (_cfg, r) => ({
      message:
        ++calls === 1
          ? {
              content: null,
              tool_calls: [
                {
                  id: "branches",
                  function: {
                    name: "check_candidates",
                    arguments: JSON.stringify({
                      candidates: [
                        { label: "direct", proof: "by rfl" },
                        { label: "bad", proof: "by exact missing" },
                      ],
                    }),
                  },
                },
              ],
            }
          : {
              content: JSON.stringify({
                proof: "by rfl",
                mode: "proof",
                route: "original",
              }),
            },
      record: { role: r.role },
    }),
  });
  try {
    const result = await harness.run({
      config: { model: "fixture", maxOutputTokens: 1000 },
      goal: "controlled branching fixture",
      contract,
      inputs: [source],
      maxCalls: 3,
    });
    assert.equal(peak, 2);
    assert.equal(result.check.status, "verified");
    const all = await store.bundle(result.record.harnessRoot);
    const memories = all.artifacts.filter((a) => a.kind === "proof:memory");
    assert.equal(memories.length, 2);
    assert.deepEqual(
      new Set(memories.map((a) => a.payload.check.status)),
      new Set(["verified", "not_verified"]),
    );
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive search cannot silently fall back to the default binary for a sealed alternate contract", async () => {
  const { ProverSession } = await import("../server/prover-session.mjs");
  const session = new ProverSession();
  await assert.rejects(
    session.create(withExecutionEnvironment(c, descriptor)),
    /not sealed/,
  );
});
