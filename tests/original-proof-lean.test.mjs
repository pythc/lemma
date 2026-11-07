import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createContract } from "../server/contracts.mjs";
import { sha256, EvidenceStore, digest } from "../server/evidence.mjs";
import { checkProof } from "../server/lean.mjs";
import { auditDependencies } from "../server/lean-dependencies.mjs";
import {
  OriginalProofEngine,
  replayOriginalProof,
} from "../server/original-proof.mjs";
const retainedDirectory = async (prefix) => {
  const base = path.resolve(
    process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/author-route-native",
  );
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, prefix));
};
const make = (target) =>
  createContract(
    {
      text: "Use the identity. Then use it again.",
      pageIndex: 0,
      paperSha256: sha256("real Lean fixture"),
      artifact: sha256("fixture source"),
    },
    {
      label: "fixture",
      quote: "Use the identity.",
      statement: "controlled fixture",
      assumptions: [],
      leanTarget: target,
    },
  );
test(
  "discarded constructor fields cannot fabricate source premise use",
  { timeout: 180000 },
  async () => {
    const c = make("∀ (h : 1 = 1), True");
    const r = await checkProof(
      c,
      "by intro h; exact (And.intro True.intro h).1",
      { dependencyAudit: true, requiredBinders: 1 },
    );
    assert.equal(r.status, "verified", r.stdout);
    assert.deepEqual(r.dependencies.binderUse, [false]);
  },
);
test(
  "real elaborated dependency closure detects a theorem hidden behind an alias",
  { timeout: 180000 },
  async () => {
    const c = make("∀ a b c : Nat, a + (b + c) = b + (a + c)");
    const r = await checkProof(
      c,
      "by intro a b c; exact Nat.add_left_comm a b c",
      { dependencyAudit: true },
    );
    assert.equal(r.status, "verified", r.stdout);
    assert.equal(r.dependencies.complete, true);
    const audit = auditDependencies(r, {
      forbiddenDeclarations: ["Nat.add_comm"],
    });
    assert.equal(audit.status, "route_violation");
    assert.ok(audit.hits.includes("Nat.add_comm"));
  },
);
test(
  "real Lean distinguishes a used source premise from an ignored one",
  { timeout: 180000 },
  async () => {
    const c = make("∀ (h : ∀ n : Nat, n + 0 = n), ∀ n : Nat, (n + 0) + 0 = n");
    const a = await checkProof(
      c,
      "by intro h n; exact (h (n + 0)).trans (h n)",
      { dependencyAudit: true, requiredBinders: 1 },
    );
    assert.equal(a.status, "verified", a.stdout);
    assert.equal(auditDependencies(a, {}, 1).status, "passed");
    const b = await checkProof(c, "by intro h n; rfl", {
      dependencyAudit: true,
      requiredBinders: 1,
    });
    assert.equal(b.status, "verified", b.stdout);
    assert.equal(auditDependencies(b, {}, 1).status, "unresolved");
  },
);
test(
  "dead let bindings and ignored lambda arguments do not fabricate source dependency use",
  { timeout: 180000 },
  async () => {
    const contract = make(
      "∀ (h : ∀ n : Nat, n + 0 = n), ∀ n : Nat, (n + 0) + 0 = n",
    );
    for (const proof of [
      "by intro h n; let _ := h; rfl",
      "by intro h n; exact (fun (_ : ∀ k : Nat, k + 0 = k) => (rfl : (n+0)+0=n)) h",
    ]) {
      const check = await checkProof(contract, proof, {
        dependencyAudit: true,
        requiredBinders: 1,
      });
      assert.equal(check.status, "verified", check.stdout);
      assert.deepEqual(check.dependencies.binderUse, [false]);
      assert.equal(auditDependencies(check, {}, 1).status, "unresolved");
    }
    const live = await checkProof(
      contract,
      "by intro h n; let use := h; exact (use (n+0)).trans (use n)",
      { dependencyAudit: true, requiredBinders: 1 },
    );
    assert.equal(live.status, "verified", live.stdout);
    assert.deepEqual(live.dependencies.binderUse, [true]);
    assert.equal(auditDependencies(live, {}, 1).status, "passed");
  },
);

test(
  "author route is checked locally, assembled and independently replayed by real Lean",
  { timeout: 360000 },
  async () => {
    const dir = await retainedDirectory("lemma-route-real-");
    const store = new EvidenceStore(dir);
    await store.init();
    try {
      const c = make("(∀ n : Nat, n + 0 = n) ∧ (∀ n : Nat, (n + 0) + 0 = n)");
      const context = {
        pages: [{ pageIndex: 0, text: "Use the identity. Then use it again." }],
        supplements: [],
      };
      const sourceArtifact = await store.put("task:R02", {
        paperSha256: c.paperSha256,
        text: "Use the identity. Then use it again.",
        pages: [{ index: 0, text: "Use the identity. Then use it again." }],
      });
      c.sourceArtifact = sourceArtifact;
      delete c.targetHash;
      c.targetHash = digest(c);
      const contractArtifact = await store.put("contract_fixture", c, [
        sourceArtifact,
      ]);
      const contextArtifact = await store.put("context_fixture", context, [
        sourceArtifact,
      ]);
      const graph = {
        steps: [
          {
            name: "Zero",
            title: "identity",
            target: "∀ n : Nat, n + 0 = n",
            kind: "explicit",
            dependsOn: [],
            anchors: [{ pageIndex: 0, quote: "Use the identity." }],
            explanation: "identity",
            proof: "by intro n; rfl",
          },
          {
            name: "Twice",
            title: "second application",
            target: "∀ n : Nat, (n + 0) + 0 = n",
            kind: "omitted",
            dependsOn: ["Zero"],
            anchors: [{ pageIndex: 0, quote: "Then use it again." }],
            explanation: "repeat",
            proof: "by intro h n; exact (h (n + 0)).trans (h n)",
          },
        ],
        assembly: "by intro h1 h2; exact ⟨h1,h2⟩",
      };
      const e = new OriginalProofEngine({
        store,
        limits: { maxPlans: 1, maxAttempts: 1 },
        model: async (_c, r) => ({
          parsed: ["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role)
            ? { status: "faithful", explanation: "controlled source route" }
            : ["R06_INTERFACES", "R06_INTERFACE_REPAIR"].includes(r.role)
              ? { graph: r.input.graph, changes: [], interfaces: [] }
              : r.role === "R06_GRAPH"
                ? graph
                : r.role === "R06_FORMALIZE"
                  ? {
                      steps: [
                        {
                          name: "Twice",
                          target: graph.steps[1].target,
                          explanation: "same second application",
                        },
                      ],
                    }
                  : {
                      coverage: "complete",
                      missingSteps: [],
                      checks: r.input.graph.steps.map((s) => ({
                        name: s.name,
                        status: "faithful",
                        anchors: s.anchors,
                        explanation: "controlled fixture",
                      })),
                      summary: "fixture",
                    },
          record: { fixture: true },
        }),
      });
      const r = await e.review({
        contract: c,
        context,
        sourceArtifact,
        contractArtifact,
        contextArtifact,
        config: { model: "fixture" },
      });
      assert.equal(
        r.summary.status,
        "verified_with_completion",
        JSON.stringify(r.steps.map((s) => [s.name, s.status, s.feedback])),
      );
      const replay = await replayOriginalProof(
        await store.bundle(r.root),
        r.root,
      );
      assert.equal(replay.reproduced, true);
      const missing = structuredClone(r.graph);
      missing.steps[1].target = null;
      const graphArtifact = await store.put(
        "original:R06_GRAPH",
        { graph: missing },
        [r.root],
      );
      const recovered = await e.review({
        contract: c,
        context,
        sourceArtifact,
        contractArtifact,
        contextArtifact,
        config: { model: "fixture" },
        resume: { ...r, graph: missing, graphArtifact },
        goalRecoveryOnly: true,
      });
      assert.equal(recovered.summary.status, "verified_with_completion");
      assert.equal(recovered.steps[1].check.status, "verified");
      assert.equal(recovered.assembly.check.status, "verified");
      assert.equal(
        (
          await replayOriginalProof(
            await store.bundle(recovered.root),
            recovered.root,
          )
        ).reproduced,
        true,
      );
      const earlierModel = e.model;
      e.model = async (config, request) =>
        request.role === "R06_CONNECTION_AUDIT"
          ? {
              parsed: {
                status: "route_change",
                explanation:
                  "controlled route rejection; theorem still checked independently",
              },
              record: { fixture: true },
            }
          : earlierModel(config, request);
      const changedConnection = {
        ...graph,
        assembly: "by intro a b; constructor; exact a; exact b",
      };
      const independent = await e.review({
        contract: c,
        context,
        sourceArtifact,
        contractArtifact,
        contextArtifact,
        config: { model: "fixture" },
        seedGraph: changedConnection,
        repairFrom: recovered,
      });
      assert.equal(independent.summary.status, "partial");
      assert.equal(independent.assembly.status, "unverified");
      assert.equal(independent.independentTheorem.status, "verified");
      const independentReplay = await replayOriginalProof(
        await store.bundle(independent.root),
        independent.root,
      );
      assert.equal(independentReplay.theorem.reproduced, true);
      assert.equal(independentReplay.allStepsVerified, false);
    } finally {
      // Retain the exact store on success and failure for independent audit.
    }
  },
);

test(
  "real Lean refutes a faulty step even though the final theorem is true",
  { timeout: 180000 },
  async () => {
    const wrong = make("∀ n : Nat, n + 1 = n");
    const refutation = await checkProof(
      wrong,
      "by intro h; exact Nat.succ_ne_zero 0 (h 0)",
      { mode: "counterexample", dependencyAudit: true },
    );
    assert.equal(refutation.status, "verified", refutation.stdout);
    assert.equal(refutation.mode, "counterexample");
    const downstream = make(
      "∀ h : (∀ n : Nat, n + 1 = n), ∀ n : Nat, n + 0 = n",
    );
    const conditional = await checkProof(
      downstream,
      "by intro h n; exact False.elim (Nat.succ_ne_zero 0 (h 0))",
      { dependencyAudit: true, requiredBinders: 1 },
    );
    assert.equal(conditional.status, "verified", conditional.stdout);
    assert.equal(auditDependencies(conditional, {}, 1).status, "passed");
    const trueRoot = await checkProof(
      make("∀ n : Nat, n + 0 = n"),
      "by intro n; rfl",
    );
    assert.equal(trueRoot.status, "verified");
    // Route closure separately requires the predecessor to be proved, so the
    // refuted first step prevents a route pass despite this conditional proof.
  },
);

test(
  "actual Lean work reports queued and started separately",
  { timeout: 120000 },
  async () => {
    const { executionContext } =
      await import("../server/execution-context.mjs");
    const events = [];
    const check = await executionContext.run(
      {
        onToolQueued: async (resource) => events.push(["queued", resource]),
        onToolStarted: async (resource) => events.push(["started", resource]),
      },
      () => checkProof(make("True"), "by trivial"),
    );
    assert.equal(check.status, "verified");
    assert.deepEqual(
      events
        .filter(([, resource]) => resource === "lean")
        .map(([state]) => state),
      ["queued", "started"],
    );
    assert.deepEqual(
      events
        .filter(([, resource]) => resource === "lean-library")
        .map(([state]) => state),
      ["queued", "started"],
    );
  },
);

test(
  "received proof text is freshly checked on revised goals and cannot inherit a prior positive verdict",
  { timeout: 180000 },
  async () => {
    const { candidatesForSourceStep } =
      await import("../server/source-candidates.mjs");
    const proof = "by intro n; rfl";
    const old = make("∀ n : Nat, n + 0 = n");
    const first = await checkProof(old, proof, { dependencyAudit: true });
    assert.equal(first.status, "verified");
    const anchors = [{ pageIndex: 0, quote: "Use the identity." }],
      step = { name: "Identity", anchors };
    const candidates = [
      {
        name: "Identity",
        anchors,
        contract: old,
        artifact: sha256("received fixture"),
        value: {
          mode: "proof",
          proof,
          route: "original",
          explanation: "fixture",
        },
        check: first,
      },
    ];
    let failedCase = null;
    for (const [target, expected] of [
      ["∀ n : Nat, n+0=n", true],
      ["∀ n : Nat, n + 1 = n", false],
    ]) {
      const current = make(target),
        [received] = candidatesForSourceStep(candidates, step, current);
      assert.equal(received.check.status, "pending");
      assert.equal(received.contract.targetHash, current.targetHash);
      assert.notEqual(current.targetHash, old.targetHash);
      const check = await checkProof(received.contract, received.value.proof, {
        dependencyAudit: true,
      });
      assert.equal(check.status === "verified", expected, check.stdout);
      assert.equal(check.targetHash, current.targetHash);
      if (!expected) failedCase = { contract: current, check };
    }
    const rescued = candidatesForSourceStep(
      [{ ...candidates[0], ...failedCase }],
      step,
      old,
    )[0];
    assert.equal(rescued.check.status, "pending");
    assert.equal(
      (
        await checkProof(rescued.contract, rescued.value.proof, {
          dependencyAudit: true,
        })
      ).status,
      "verified",
    );
    assert.equal(
      candidatesForSourceStep(candidates, step, {
        ...old,
        sourceArtifact: sha256("different PDF source"),
      }).length,
      0,
    );
  },
);
