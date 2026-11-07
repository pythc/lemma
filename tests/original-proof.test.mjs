import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OriginalProofEngine,
  validateRoute,
  validateRouteReview,
  routeSummary,
  replayOriginalProof,
  scheduleSourceSteps,
} from "../server/original-proof.mjs";
import { auditDependencies } from "../server/lean-dependencies.mjs";
import {
  sourceTheoremCandidate,
  rebindTheoremText,
  sameTheoremScope,
} from "../server/source-theorem.mjs";
import {
  OriginalProofService,
  inheritedUnknownPolicyTasks,
} from "../server/original-proof-service.mjs";
import { MATHLIB_COMMIT } from "../shared/library-profiles.mjs";
import { createContract } from "../server/contracts.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import {
  applySourceGoalRecovery,
  sameSourcePassage,
} from "../server/source-goal-recovery.mjs";
const text = "First use the zero identity. Then apply the identity twice.";
const context = { pages: [{ pageIndex: 0, text }], supplements: [] };
const contract = createContract(
  { text, paperSha256: sha256(text), pageIndex: 0, artifact: sha256("source") },
  {
    label: "fixture",
    quote: text,
    statement: "fixture",
    assumptions: [],
    leanTarget: "(∀ n : Nat, n + 0 = n) ∧ (∀ n : Nat, (n + 0) + 0 = n)",
  },
);
const raw = () => ({
  steps: [
    {
      name: "Zero",
      title: "加零",
      kind: "explicit",
      anchors: [{ pageIndex: 0, quote: "First use the zero identity." }],
      target: "∀ n : Nat, n + 0 = n",
      dependsOn: [],
      explanation: "第一步",
    },
    {
      name: "Twice",
      title: "再应用一次",
      kind: "omitted",
      anchors: [{ pageIndex: 0, quote: "Then apply the identity twice." }],
      target: "∀ n : Nat, (n + 0) + 0 = n",
      dependsOn: ["Zero"],
      explanation: "补全第二次应用",
    },
  ],
  assembly: "by intro h1 h2; exact ⟨h1,h2⟩",
  policy: {},
  methodClaims: [],
  limitations: [],
});
const alignment = (g) => ({
  coverage: "complete",
  missingSteps: [],
  checks: g.steps.map((s) => ({
    name: s.name,
    status: "faithful",
    explanation: "来源对应",
    anchors: s.anchors,
  })),
  policyAdditions: {},
  summary: "受控测试",
});
const goodCheck = async (c, p, o = {}) => ({
  status: "verified",
  targetHash: c.targetHash,
  mode: o.mode || "proof",
  exitCode: 0,
  axioms: [],
  dependencies: {
    complete: true,
    direct: [],
    edges: [],
    binderUse: Array(o.requiredBinders || 0).fill(true),
  },
});
test("invalid native interfaces are repaired and realigned before any local proof request", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-blueprint-repair-"));
  const store = new EvidenceStore(dir);
  await store.init();
  let repairs = 0;
  const broken = raw();
  broken.steps[0].target = "UnknownProposition";
  const calls = [];
  const engine = new OriginalProofEngine({
    store,
    proofWorkspace: true,
    checker: async (c, p, o) =>
      c.leanTarget.includes("UnknownProposition")
        ? {
            targetHash: c.targetHash,
            status: "not_verified",
            mode: "proof",
            exitCode: 1,
            axioms: [],
            stdout: "unknown identifier UnknownProposition",
          }
        : goodCheck(c, p, o),
    model: async (_cfg, r) => {
      calls.push(r.role);
      let parsed;
      if (r.role === "R06_GRAPH") parsed = broken;
      else if (r.role === "R06_INTERFACES") parsed = { graph: r.input.graph };
      else if (r.role === "R06_BLUEPRINT_REPAIR") {
        repairs++;
        assert.equal(r.input.nativeFeedback.signatureChecks[0].name, "Zero");
        assert.match(
          r.input.nativeFeedback.signatureChecks[0].diagnostic.stdout,
          /UnknownProposition/,
        );
        parsed = {
          graph: raw(),
          changes: [
            { name: "Zero", reason: "fix identifier preserving source" },
          ],
        };
      } else if (r.role === "R06_ALIGN") parsed = alignment(r.input.graph);
      else if (r.role === "R06_STEP")
        parsed = {
          mode: "proof",
          route: "completion",
          proof: "by trivial",
          explanation: "explicit control-flow fixture",
        };
      else
        parsed = {
          status: "faithful",
          explanation: "explicit control-flow fixture",
        };
      return { parsed, record: { fixture: true } };
    },
  });
  try {
    const r = await engine.review({
      contract,
      context,
      sourceArtifact: contract.sourceArtifact,
      contractArtifact: sha256("contract"),
      contextArtifact: sha256("context"),
      config: { model: "fixture" },
    });
    assert.equal(repairs, 1);
    assert.equal(r.blueprint.preflight.status, "well_typed");
    assert.equal(r.blueprint.connection.status, "connected_conditionally");
    assert.ok(
      calls.indexOf("R06_BLUEPRINT_REPAIR") < calls.indexOf("R06_STEP"),
    );
    assert.equal(calls.filter((x) => x === "R06_ALIGN").length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test(
  "source successors start when their own dependencies finish, without waiting for a slow sibling",
  { timeout: 2000 },
  async () => {
    const seen = [];
    let childStarted;
    const child = new Promise((resolve) => {
      childStarted = resolve;
    });
    await scheduleSourceSteps(
      [
        { name: "Slow", dependsOn: [] },
        { name: "Fast", dependsOn: [] },
        { name: "Child", dependsOn: ["Fast"] },
      ],
      async (s) => {
        if (s.name === "Slow") await child;
        if (s.name === "Child") {
          assert.ok(seen.includes("Fast"));
          assert.ok(!seen.includes("Slow"));
          childStarted();
        }
        seen.push(s.name);
      },
      async (_s, e) => {
        throw e;
      },
    );
    assert.deepEqual(seen, ["Fast", "Child", "Slow"]);
    await assert.rejects(
      scheduleSourceSteps(
        [{ name: "A", dependsOn: ["B"] }],
        async () => {},
        async () => {},
      ),
      /dependency cycle/,
    );
    const recovered = [];
    await scheduleSourceSteps(
      [
        { name: "A", dependsOn: [] },
        { name: "B", dependsOn: ["A"] },
      ],
      async (s) => {
        if (s.name === "A") throw Error("local failure");
        recovered.push(s.name);
      },
      async (s) => {
        recovered.push(s.name);
      },
    );
    assert.deepEqual(recovered, ["A", "B"]);
    let starts = 0;
    await assert.rejects(
      scheduleSourceSteps(
        [
          { name: "Bad", dependsOn: [] },
          { name: "Good", dependsOn: [] },
        ],
        async (s) => {
          starts++;
          if (s.name === "Bad") throw Error("failure");
          await Promise.resolve();
        },
        async () => {
          throw Error("persistence failed");
        },
      ),
      /persistence failed/,
    );
    assert.equal(starts, 2, "fatal failures are not silently rescheduled");
    await assert.rejects(
      scheduleSourceSteps(
        [{ name: "A", dependsOn: [] }],
        async () => {
          throw Error("local");
        },
        async () => {
          throw null;
        },
      ),
      /without a reason/,
    );
  },
);
test("source graph rejects invented anchors, cycles, duplicate names and unchecked source kinds", () => {
  for (const mutate of [
    (g) => (g.steps[0].anchors[0].quote = "invented"),
    (g) => (g.steps[0].dependsOn = ["Twice"]),
    (g) => (g.steps[1].name = "Zero"),
    (g) => (g.steps[0].kind = "independent"),
    (g) => (g.steps[0].target = "by sorry"),
  ]) {
    const g = raw();
    mutate(g);
    assert.throws(() => validateRoute(g, contract, context));
  }
});
test("missing-target patches preserve source identities and reject edits to existing goals", () => {
  const graph = raw();
  graph.steps[1].target = null;
  const before = structuredClone(graph);
  const patch = {
    name: "Twice",
    target: raw().steps[1].target,
    explanation: "same omitted inference",
  };
  const fixed = applySourceGoalRecovery(graph, { steps: [patch] });
  assert.equal(fixed.graph.steps[1].target, patch.target);
  assert.equal(fixed.graph.steps[1].explanation, patch.explanation);
  assert.deepEqual(graph, before);
  assert.deepEqual(fixed.graph.steps[1].anchors, before.steps[1].anchors);
  for (const steps of [
    [{ ...patch, name: "Zero" }],
    [patch, patch],
    [{ ...patch, dependsOn: [] }],
    [{ ...patch, target: "True := by sorry" }],
  ])
    assert.throws(() => applySourceGoalRecovery(graph, { steps }));
  const reference = {
    ...graph,
    steps: graph.steps.map((s) => ({ ...s, kind: "reference" })),
  };
  assert.throws(() => applySourceGoalRecovery(reference, { steps: [patch] }));
  assert.equal(
    sameSourcePassage(
      [{ pageIndex: 0, quote: "same   text" }],
      [{ pageIndex: 0, quote: "same text" }],
    ),
    true,
  );
  assert.equal(
    sameSourcePassage(
      [{ pageIndex: 1, quote: "same text" }],
      [{ pageIndex: 0, quote: "same text" }],
    ),
    false,
  );
  const clause =
    "This is a sufficiently long original clause used as a source anchor.";
  const a = {
    pageIndex: 0,
    quote: clause,
    start: 100,
    sourceTextHash: sha256("page"),
  };
  const b = { ...a, quote: clause + " The sentence continues here." };
  assert.equal(sameSourcePassage([a], [b]), true);
  assert.equal(
    sameSourcePassage([a], [{ ...b, sourceTextHash: sha256("other page") }]),
    false,
  );
  assert.equal(sameSourcePassage([a], [{ ...b, start: 1000 }]), false);
});
test("incomplete semantic review cannot establish route coverage", () => {
  const g = validateRoute(raw(), contract, context);
  const r = alignment(g);
  r.checks.pop();
  assert.throws(() => validateRouteReview(r, g, context));
  const q = validateRouteReview(alignment(g), g, context);
  assert.equal(
    routeSummary(g, q, [], { status: "verified" }).status,
    "partial",
  );
  q.missingSteps = ["unmapped source derivation"];
  assert.equal(
    routeSummary(g, q, [{ status: "passed" }, { status: "completed" }], {
      status: "verified",
    }).status,
    "partial",
  );
});
test("a suspected mathematical gap is archived separately from source fidelity", () => {
  const graph = validateRoute(raw(), contract, context);
  const assessment = {
    ...alignment(graph),
    mathematicalConcerns: ["Zero: a suspected gap remains for Lean to assess"],
  };
  const review = validateRouteReview(assessment, graph, context);
  assert.deepEqual(
    review.mathematicalConcerns,
    assessment.mathematicalConcerns,
  );
  assert.ok(review.checks.every((c) => c.status === "faithful"));
});
test("dependency audit catches transitive aliases, unused source dependencies and forbidden axioms", () => {
  const c = {
    axioms: ["Classical.choice"],
    dependencies: {
      complete: true,
      edges: [
        ["Alias", ["BW"]],
        ["BW", []],
      ],
      binderUse: [false],
    },
  };
  assert.equal(
    auditDependencies(c, { forbiddenDeclarations: ["BW"] }).status,
    "route_violation",
  );
  assert.equal(auditDependencies(c, {}, 1).status, "unresolved");
  assert.equal(
    auditDependencies(c, { forbiddenAxioms: ["Classical.choice"] }).status,
    "route_violation",
  );
  assert.equal(
    auditDependencies({ ...c, dependencies: { complete: false } }, {}).status,
    "unresolved",
  );
});
async function harness(action, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-original-"));
  const store = new EvidenceStore(dir);
  await store.init();
  const sourceArtifact = await store.put("task:R02", {
    text,
    paperSha256: contract.paperSha256,
    pageIndex: 0,
    pages: [{ index: 0, text }],
  });
  const localContract = { ...contract, sourceArtifact };
  delete localContract.targetHash;
  const { digest } = await import("../server/evidence.mjs");
  localContract.targetHash = digest(localContract);
  const contractArtifact = await store.put("task:R05", localContract, [
    sourceArtifact,
  ]);
  const contextArtifact = await store.put("task:R02C", context, [
    sourceArtifact,
  ]);
  const calls = [];
  const model = async (_c, r) => {
    calls.push(r.role);
    return {
      parsed: ["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role)
        ? { status: "faithful", explanation: "受控路线复核" }
        : r.role === "R06_GRAPH"
          ? raw()
          : r.role === "R06_ALIGN"
            ? alignment(r.input.graph)
            : {
                mode: "proof",
                route:
                  r.input.step.kind === "omitted" ? "completion" : "original",
                proof: "by trivial",
                explanation: "受控候选",
              },
      record: { fixture: true },
    };
  };
  try {
    const engine = new OriginalProofEngine({
      store,
      model,
      checker: goodCheck,
      limits: { maxPlans: 1, maxAttempts: 1 },
      ...overrides,
      model: overrides.model
        ? async (...args) => {
            calls.push(args[1].role);
            return overrides.model(...args);
          }
        : model,
    });
    await action(
      engine,
      {
        contract: localContract,
        context,
        sourceArtifact,
        contractArtifact,
        contextArtifact,
        config: { model: "fixture" },
      },
      store,
      calls,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("local checks, missing derivation and final assembly remain distinct; evidence replays", async () =>
  harness(async (e, input, store) => {
    const r = await e.review(input);
    assert.deepEqual(
      r.steps.map((s) => s.status),
      ["passed", "completed"],
    );
    assert.equal(r.summary.status, "verified_with_completion");
    const b = await store.bundle(r.root);
    const replay = await replayOriginalProof(b, r.root, goodCheck);
    assert.equal(replay.reproduced, true);
    assert.equal(replay.allStepsVerified, true);
  }));
test("a true final theorem does not hide a bad source step or vacuous downstream implication", async () =>
  harness(
    async (e, input) => {
      const r = await e.review(input);
      assert.equal(r.steps[0].status, "refuted");
      assert.equal(r.steps[1].status, "conditional");
      assert.equal(r.summary.status, "has_problem");
      assert.equal(r.assembly.status, "unverified");
    },
    {
      model: async (_c, r) => ({
        parsed: ["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role)
          ? { status: "faithful", explanation: "受控路线复核" }
          : r.role === "R06_GRAPH"
            ? raw()
            : r.role === "R06_ALIGN"
              ? alignment(r.input.graph)
              : {
                  mode:
                    r.input.step.name === "Zero" ? "counterexample" : "proof",
                  route: "original",
                  proof: "by trivial",
                  explanation: "故障对照",
                },
        record: { fixture: true },
      }),
    },
  ));
test("an accepted theorem certificate is retained separately when the original connection changes route", async () => {
  await harness(
    async (engine, input, store) => {
      const result = await engine.review(input);
      assert.equal(result.summary.status, "partial");
      assert.equal(result.assembly.status, "unverified");
      assert.equal(result.independentTheorem.status, "verified");
      assert.equal(
        result.independentTheorem.contract.leanTarget,
        input.contract.leanTarget,
      );
      const replay = await replayOriginalProof(
        await store.bundle(result.root),
        result.root,
        goodCheck,
      );
      assert.equal(replay.theorem.reproduced, true);
      assert.equal(replay.allStepsVerified, false);
      assert.equal(replay.reproduced, true);
      assert.equal(
        sourceTheoremCandidate(result, {
          ...input.contract,
          leanTarget: "False",
        }),
        null,
      );
    },
    {
      model: async (_config, r) => ({
        parsed:
          r.role === "R06_GRAPH"
            ? raw()
            : r.role === "R06_ALIGN"
              ? alignment(r.input.graph)
              : r.role === "R06_CONNECTION_AUDIT"
                ? {
                    status: "route_change",
                    explanation: "controlled rejection of source route only",
                  }
                : r.role === "R06_ROUTE_AUDIT"
                  ? { status: "faithful", explanation: "fixture" }
                  : {
                      mode: "proof",
                      route: "original",
                      proof: "by fixture",
                      explanation: "fixture",
                    },
        record: { fixture: true },
      }),
    },
  );
});
test("an existing exact theorem is freshly checked even when source steps remain unaligned", async () => {
  await harness(
    async (engine, input, store) => {
      const proofArtifact = await store.put(
        "task:R09",
        { mode: "proof", proof: "by fixture" },
        [input.contractArtifact],
      );
      const result = await engine.review({
        ...input,
        theoremCandidate: {
          contract: input.contract,
          proof: "by fixture",
          inputs: [proofArtifact],
        },
      });
      assert.equal(result.summary.status, "partial");
      assert.equal(result.independentTheorem.status, "verified");
      assert.equal(
        result.independentTheorem.check.targetHash,
        input.contract.targetHash,
      );
      const evidence = await store.get(result.independentTheorem.artifact);
      assert.ok(evidence.inputs.includes(proofArtifact));
      const wrong = await engine.review({
        ...input,
        theoremCandidate: {
          contract: { ...input.contract, targetHash: sha256("other") },
          proof: "by fixture",
          inputs: [proofArtifact],
        },
      });
      assert.equal(wrong.independentTheorem, undefined);
    },
    {
      model: async (_config, request) => {
        const g = request.role === "R06_GRAPH" ? raw() : request.input.graph;
        const q = alignment(g);
        q.coverage = "incomplete";
        q.checks = q.checks.map((c) => ({ ...c, status: "concern" }));
        return {
          parsed: request.role === "R06_GRAPH" ? g : q,
          record: { fixture: true },
        };
      },
    },
  );
});
test("received theorem text can add modules but cannot import old definitions or helpers", async () => {
  await harness(async (_engine, input, store) => {
    const artifact = await store.put("task:R09", { proof: "by fixture" }, [
      input.contractArtifact,
    ]);
    const prior = {
      paperSha256: input.contract.paperSha256,
      contract: {
        ...input.contract,
        domainContext: {
          revision: MATHLIB_COMMIT,
          modules: [
            {
              name: "Mathlib.Topology.Sequences",
              file: "Mathlib/Topology/Sequences.lean",
              sourceSha256: sha256("fixture"),
            },
          ],
          definitions: [{ name: "OldMeaning" }],
          lemmas: [{ name: "OldHelper" }],
        },
      },
    };
    const root = { ...input, paperSha256: input.contract.paperSha256 };
    const candidate = await rebindTheoremText(
      store,
      root,
      prior,
      await store.get(artifact),
    );
    assert.ok(sameTheoremScope(candidate.contract, input.contract));
    assert.equal(candidate.rootTargetHash, input.contract.targetHash);
    assert.notEqual(candidate.contract.targetHash, input.contract.targetHash);
    assert.deepEqual(candidate.contract.domainContext.definitions, []);
    assert.deepEqual(candidate.contract.domainContext.lemmas, []);
    assert.equal(candidate.contract.domainContext.modules.length, 1);
    assert.equal(
      await rebindTheoremText(
        store,
        root,
        { ...prior, paperSha256: sha256("other paper") },
        await store.get(artifact),
      ),
      null,
    );
  });
});
test("theorem-only continuation preserves the frozen source report and freshly checks related received text", async () => {
  await harness(
    async (engine, input, store) => {
      const report = await engine.review(input);
      const base = {
        ...input,
        id: "11111111-2222-4333-8444-555555555555",
        engine: "original-proof-v1",
        status: "completed",
        paperSha256: input.contract.paperSha256,
        originalProofRoute: report,
        root: report.root,
        reviewRunId: "22222222-2222-4333-8444-555555555555",
        conclusion: { theorem: "unknown", wholePaperVerified: false },
        tasks: [],
      };
      await store.saveRun(base);
      const proof = await store.put("task:R09", { proof: "by fixture" }, [
        input.contractArtifact,
      ]);
      const priorBody = { ...input.contract, label: "older label" };
      delete priorBody.targetHash;
      const { digest } = await import("../server/evidence.mjs");
      const priorContract = { ...priorBody, targetHash: digest(priorBody) };
      await store.saveRun({
        id: "33333333-2222-4333-8444-555555555555",
        paperSha256: base.paperSha256,
        contract: priorContract,
        proofArtifact: proof,
        check: await goodCheck(priorContract, "by fixture"),
      });
      let checks = 0;
      const service = new OriginalProofService({
        store,
        getConfig: () => {
          throw Error("No model should be called");
        },
        checker: async (...args) => {
          checks++;
          return goodCheck(...args);
        },
      });
      const next = await service.recheckKnownTheorem(base.id);
      assert.equal(checks, 1);
      assert.equal(next.certificateOnly, true);
      assert.notEqual(next.root, base.root);
      assert.equal(next.originalProofRoute.graphArtifact, report.graphArtifact);
      assert.deepEqual(next.originalProofRoute.summary, report.summary);
      assert.equal(next.conclusion.theorem, "formalized_proved");
      assert.equal((await store.getRun(base.id)).root, base.root);
      const replay = await replayOriginalProof(
        await store.bundle(next.root),
        next.root,
        goodCheck,
      );
      assert.equal(replay.reproduced, true);
      assert.equal(replay.allStepsVerified, false);
    },
    {
      model: async (_c, r) => {
        const g = r.role === "R06_GRAPH" ? raw() : r.input.graph;
        const a = alignment(g);
        a.checks = a.checks.map((s) => ({ ...s, status: "concern" }));
        return {
          parsed: r.role === "R06_GRAPH" ? g : a,
          record: { fixture: true },
        };
      },
    },
  );
});
test("a failed composed theorem cannot hide an existing exact theorem; both checks are archived", async () => {
  await harness(
    async (engine, input, store) => {
      const proof = "by received_existing_theorem";
      const artifact = await store.put("task:R09", { proof }, [
        input.contractArtifact,
      ]);
      const result = await engine.review({
        ...input,
        theoremCandidate: {
          contract: input.contract,
          proof,
          inputs: [artifact],
        },
      });
      assert.equal(result.summary.status, "partial");
      assert.equal(result.independentTheorem.status, "verified");
      assert.equal(result.independentTheorem.proof, proof);
      assert.equal(result.theoremCheckArtifacts.length, 2);
      const root = await store.get(result.root);
      const checks = await Promise.all(
        result.theoremCheckArtifacts.map((id) => store.get(id)),
      );
      assert.deepEqual(
        checks.map((a) => a.payload.status),
        ["unverified", "verified"],
      );
      assert.ok(
        result.theoremCheckArtifacts.every((id) => root.inputs.includes(id)),
      );
      assert.equal(
        (
          await replayOriginalProof(
            await store.bundle(result.root),
            result.root,
            goodCheck,
          )
        ).reproduced,
        true,
      );
    },
    {
      checker: async (c, p, o) => ({
        ...(await goodCheck(c, p, o)),
        status:
          c.leanTarget === contract.leanTarget &&
          p !== "by received_existing_theorem"
            ? "failed"
            : "verified",
      }),
      model: async (_config, r) => ({
        parsed:
          r.role === "R06_GRAPH"
            ? raw()
            : r.role === "R06_ALIGN"
              ? alignment(r.input.graph)
              : r.role === "R06_CONNECTION_AUDIT"
                ? { status: "route_change", explanation: "fixture" }
                : r.role === "R06_ROUTE_AUDIT"
                  ? { status: "faithful", explanation: "fixture" }
                  : {
                      mode: "proof",
                      route: "original",
                      proof: "by fixture",
                      explanation: "fixture",
                    },
        record: { fixture: true },
      }),
    },
  );
});
test("a missing source connection returns compact assembly evidence to bounded graph replanning", async () => {
  let graphs = 0;
  await harness(
    async (engine, input) => {
      engine.limits.maxPlans = 2;
      const result = await engine.review(input);
      assert.equal(graphs, 2);
      assert.equal(result.generation, 1);
      assert.equal(result.summary.status, "verified_with_completion");
    },
    {
      model: async (_config, request) => {
        let parsed;
        if (request.role === "R06_GRAPH") {
          graphs++;
          if (graphs === 2)
            assert.equal(
              request.input.previousError.assembly.routeAssessment.status,
              "route_change",
            );
          parsed = raw();
          if (graphs === 2) parsed.assembly = "by intro a b; exact ⟨a, b⟩";
        } else if (request.role === "R06_ALIGN")
          parsed = alignment(request.input.graph);
        else if (request.role === "R06_CONNECTION_AUDIT")
          parsed = {
            status: graphs === 1 ? "route_change" : "faithful",
            explanation: "fixture",
          };
        else if (request.role === "R06_ROUTE_AUDIT")
          parsed = { status: "faithful", explanation: "fixture" };
        else
          parsed = {
            mode: "proof",
            route: "original",
            proof: "by fixture",
            explanation: "fixture",
          };
        return { parsed, record: { fixture: true } };
      },
    },
  );
});

test("a mismatched checker direction cannot be promoted to a counterexample", async () => {
  await harness(
    async (engine, input) => {
      const result = await engine.review(input);
      assert.ok(result.steps.every((s) => s.status === "unverified"));
      assert.equal(result.assembly.status, "unverified");
    },
    {
      checker: async (c, p, options) => ({
        ...(await goodCheck(c, p, options)),
        mode: "proof",
      }),
      model: async (_config, r) => ({
        parsed:
          r.role === "R06_GRAPH"
            ? raw()
            : r.role === "R06_ALIGN"
              ? alignment(r.input.graph)
              : {
                  mode: "counterexample",
                  route: "original",
                  proof: "by fixture",
                  explanation: "fixture",
                },
        record: { fixture: true },
      }),
    },
  );
});

test("independent replacement never counts as author-route success", async () =>
  harness(
    async (e, input) => {
      const r = await e.review(input);
      assert.equal(r.steps[0].status, "alternative_only");
      assert.equal(r.summary.status, "partial");
      assert.equal(r.assembly.status, "unverified");
    },
    {
      model: async (_c, r) => ({
        parsed: ["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role)
          ? { status: "route_change", explanation: "受控替代路线复核" }
          : r.role === "R06_GRAPH"
            ? raw()
            : r.role === "R06_ALIGN"
              ? alignment(r.input.graph)
              : {
                  mode: "proof",
                  route: "independent",
                  proof: "by trivial",
                  explanation: "另一条证明",
                },
        record: { fixture: true },
      }),
    },
  ));
test("known mathematical gap remains unverified, does not become a false-theorem conclusion", async () =>
  harness(
    async (e, input) => {
      const r = await e.review(input);
      assert.equal(r.summary.status, "partial");
      assert.equal(r.steps[0].status, "unverified");
    },
    {
      checker: async (c) => ({
        status: "not_verified",
        targetHash: c.targetHash,
        exitCode: 1,
        axioms: [],
        stdout: "unsolved goals",
      }),
      model: async (_c, r) => ({
        parsed: ["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role)
          ? { status: "faithful", explanation: "受控路线复核" }
          : r.role === "R06_GRAPH"
            ? raw()
            : r.role === "R06_ALIGN"
              ? alignment(r.input.graph)
              : r.role === "R06_DIAGNOSE"
                ? {
                    kind: "mathematical_gap",
                    explanation: "尚缺推导",
                    queries: [],
                    modules: [],
                  }
                : {
                    mode: "proof",
                    route: "original",
                    proof: "by trivial",
                    explanation: "尝试",
                  },
        record: { fixture: true },
      }),
    },
  ));

test("Latin PDF hyphenation repair returns exact original text and does not normalize math signs", async () => {
  const { originalAnchors } = await import("../server/original-anchors.mjs");
  const c = {
    pages: [
      {
        pageIndex: 0,
        text: "The preliminary theo- rem establishes boundedness. Formula: x ≤ y.",
      },
    ],
    supplements: [],
  };
  const [a] = originalAnchors(
    { pageIndex: 0, quote: "The preliminary theorem establishes boundedness." },
    c,
  );
  assert.ok(a.quote.includes("theo- rem"));
  assert.throws(() =>
    originalAnchors({ pageIndex: 0, quote: "Formula: x < y." }, c),
  );
});
test("assembly can use earlier steps transitively, but cannot discard an entire source branch", async () => {
  const { auditAssemblyDependencies } =
    await import("../server/lean-dependencies.mjs");
  const steps = [
    { name: "A", dependsOn: [] },
    { name: "B", dependsOn: ["A"] },
  ];
  const check = {
    axioms: [],
    dependencies: { complete: true, edges: [], binderUse: [false, true] },
  };
  assert.equal(auditAssemblyDependencies(check, {}, steps).status, "passed");
  assert.equal(
    auditAssemblyDependencies(check, {}, [
      ...steps,
      { name: "C", dependsOn: [] },
    ]).status,
    "unresolved",
  );
});

test("dependency evidence never consumes the model diagnostic input budget", async () =>
  harness(
    async (e, input, _store, calls) => {
      const r = await e.review(input);
      assert.equal(r.summary.status, "partial");
      assert.ok(calls.includes("R06_DIAGNOSE"));
    },
    {
      limits: { maxPlans: 1, maxAttempts: 1, maxRequestCharacters: 18000 },
      checker: async (c) => ({
        status: "not_verified",
        targetHash: c.targetHash,
        mode: "proof",
        exitCode: 1,
        axioms: [],
        stdout: "type mismatch\nLEMMA_DEPENDENCIES:" + "x".repeat(2000000),
        stderr: "",
        failureKind: "proof_rejected",
      }),
      model: async (_c, r) => ({
        parsed:
          r.role === "R06_GRAPH"
            ? raw()
            : r.role === "R06_ALIGN"
              ? alignment(r.input.graph)
              : r.role === "R06_DIAGNOSE"
                ? {
                    kind: "mathematical_gap",
                    explanation: "未完成",
                    queries: [],
                    modules: [],
                  }
                : {
                    mode: "proof",
                    route: "original",
                    proof: "by trivial",
                    explanation: "candidate",
                  },
        record: { fixture: true },
      }),
    },
  ));

test("restart never replays a queued or unknown model request", async () => {
  const { OriginalProofService } =
    await import("../server/original-proof-service.mjs");
  const { randomUUID } = await import("node:crypto");
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-original-restart-"));
  const store = new EvidenceStore(dir);
  await store.init();
  const id = randomUUID();
  await store.saveRun({
    id,
    engine: "original-proof-v1",
    status: "running",
    tasks: [
      { id: "queued", status: "queued" },
      { id: "sent", status: "running", modelStartedAt: "2026-10-19T00:00:00Z" },
    ],
  });
  let calls = 0;
  const service = new OriginalProofService({
    store,
    model: async () => {
      calls++;
      throw Error("must not replay");
    },
  });
  try {
    await service.init();
    const r = await store.getRun(id);
    assert.equal(r.status, "interrupted");
    assert.equal(calls, 0);
    assert.ok(r.tasks.every((t) => t.status === "interrupted"));
    assert.equal(r.tasks[1].externalOutcome, "unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a local step may consume a declared ancestor through a checked predecessor", async () => {
  const { auditScopedDependencies } =
    await import("../server/lean-dependencies.mjs");
  const a = { name: "A", dependsOn: [] },
    b = { name: "B", dependsOn: ["A"] };
  const c = {
    axioms: [],
    dependencies: { complete: true, edges: [], binderUse: [false, true] },
  };
  assert.equal(auditScopedDependencies(c, {}, [a, b], [a, b]).status, "passed");
  assert.equal(
    auditScopedDependencies(c, {}, [a, b], [a, { ...b, dependsOn: [] }]).status,
    "unresolved",
  );
});

test("missing targets are recovered, independently aligned and checked without new local proof requests", async () => {
  let recovery = false;
  await harness(
    async (engine, input, store, calls) => {
      const first = await engine.review(input);
      const missing = structuredClone(first.graph);
      missing.steps[1].target = null;
      const artifact = await store.put(
        "original:R06_GRAPH",
        { graph: missing },
        [first.root],
      );
      const resume = { ...first, graph: missing, graphArtifact: artifact };
      recovery = true;
      const n = calls.length;
      const result = await engine.review({
        ...input,
        resume,
        goalRecoveryOnly: true,
      });
      assert.equal(result.strategy, "missing_targets_received_candidates");
      assert.equal(result.summary.status, "verified_with_completion");
      assert.equal(
        missing.steps[1].target,
        null,
        "old graph remains immutable",
      );
      assert.ok(calls.slice(n).includes("R06_FORMALIZE"));
      assert.ok(calls.slice(n).includes("R06_ALIGN"));
      assert.ok(
        !calls
          .slice(n)
          .some((role) =>
            ["R06_STEP", "R06_REPAIR", "R06_GRAPH"].includes(role),
          ),
      );
      assert.equal(
        (
          await replayOriginalProof(
            await store.bundle(result.root),
            result.root,
            goodCheck,
          )
        ).reproduced,
        true,
      );
      await assert.rejects(
        engine.review({ ...input, goalRecoveryOnly: true }),
        /existing graph/,
      );
      await assert.rejects(
        engine.review({
          ...input,
          resume,
          goalRecoveryOnly: true,
          verificationOnly: true,
        }),
        /distinct mode/,
      );
    },
    {
      model: async (_config, r) => {
        let parsed;
        if (r.role === "R06_FORMALIZE") {
          assert.ok(recovery);
          assert.equal(r.input.historicalGoalHints.length > 0, true);
          parsed = {
            steps: [
              {
                name: "Twice",
                target: raw().steps[1].target,
                explanation: "原文省略第二次应用，但待验证的等式不变",
              },
            ],
          };
        } else if (r.role === "R06_GRAPH") parsed = raw();
        else if (r.role === "R06_ALIGN") parsed = alignment(r.input.graph);
        else if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role))
          parsed = { status: "faithful", explanation: "fixture" };
        else
          parsed = {
            mode: "proof",
            proof: "by fixture",
            route: "original",
            explanation: "fixture",
          };
        return { parsed, record: { fixture: true } };
      },
    },
  );
});

test("a malformed target recovery is archived without rewriting other targets or inventing proof success", async () => {
  await harness(
    async (engine, input, store, calls) => {
      const missing = raw();
      missing.steps[1].target = null;
      const artifact = await store.put(
        "original:R06_GRAPH",
        { graph: validateRoute(missing, input.contract, input.context) },
        [input.sourceArtifact],
      );
      const result = await engine.review({
        ...input,
        resume: {
          targetHash: input.contract.targetHash,
          graph: missing,
          graphArtifact: artifact,
        },
        goalRecoveryOnly: true,
      });
      assert.equal(result.graph.steps[0].target, raw().steps[0].target);
      assert.equal(result.graph.steps[1].target, null);
      assert.equal(result.summary.status, "partial");
      assert.ok(
        !calls.some((role) => ["R06_STEP", "R06_REPAIR"].includes(role)),
      );
      const bundle = await store.bundle(result.root);
      assert.ok(
        bundle.artifacts.some(
          (a) => a.kind === "original:goal_recovery_failure",
        ),
      );
    },
    {
      model: async (_config, r) => ({
        parsed:
          r.role === "R06_FORMALIZE"
            ? {
                steps: [
                  { name: "Zero", target: "True", explanation: "bad edit" },
                ],
              }
            : alignment(r.input.graph),
        record: { fixture: true },
      }),
    },
  );
});

test("invalid semantic output in a fixed audit retries alignment without regenerating targets", async () => {
  let phase = "first",
    alignments = 0;
  await harness(
    async (engine, input) => {
      const first = await engine.review(input);
      phase = "audit";
      engine.limits.maxPlans = 2;
      const audit = await engine.review({
        ...input,
        resume: { ...first, sourceAlignmentPolicyVersion: 0 },
        verificationOnly: true,
      });
      assert.equal(alignments, 2);
      assert.equal(audit.graphArtifact, first.graphArtifact);
      assert.deepEqual(audit.graph, first.graph);
      assert.equal(audit.summary.status, "verified_with_completion");
      await assert.rejects(
        engine.review({
          ...input,
          resume: { ...first, targetHash: sha256("other target") },
          verificationOnly: true,
        }),
        /same fixed target/,
      );
    },
    {
      model: async (_config, request) => {
        let parsed;
        if (request.role === "R06_GRAPH") {
          assert.equal(phase, "first", "fixed audit may not generate a graph");
          parsed = raw();
        } else if (request.role === "R06_ALIGN") {
          if (phase === "audit" && ++alignments === 1)
            parsed = { ...alignment(request.input.graph), checks: [] };
          else parsed = alignment(request.input.graph);
        } else if (
          ["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(request.role)
        )
          parsed = { status: "faithful", explanation: "fixture" };
        else
          parsed = {
            mode: "proof",
            route: "original",
            proof: "by fixture",
            explanation: "fixture",
          };
        return { parsed, record: { fixture: true } };
      },
    },
  );
});

test("fixed-candidate recheck runs fresh kernel checks without regenerating graph or proofs", async () => {
  let checks = 0;
  await harness(
    async (e, input, _store, calls) => {
      const first = await e.review(input);
      const before = checks,
        n = calls.length;
      const next = await e.review({
        ...input,
        resume: first,
        verificationOnly: true,
      });
      assert.equal(next.strategy, "received_candidates_recheck");
      assert.equal(next.summary.status, "verified_with_completion");
      assert.equal(
        checks - before,
        4,
        "both local proofs, connection and final root checked again",
      );
      assert.deepEqual(
        calls.slice(n),
        [],
        "unchanged independent route judgments may be reused",
      );
    },
    {
      checker: async (...args) => {
        checks++;
        return goodCheck(...args);
      },
    },
  );
});

test("candidate self-label cannot reject a faithful author-route proof; audit decides", async () => {
  await harness(
    async (e, input) => {
      const r = await e.review(input);
      assert.equal(r.steps[0].claimedRoute, "independent");
      assert.equal(r.steps[0].route, "original");
      assert.equal(r.steps[0].status, "passed");
    },
    {
      model: async (_c, r) => ({
        parsed:
          r.role === "R06_GRAPH"
            ? raw()
            : r.role === "R06_ALIGN"
              ? alignment(r.input.graph)
              : ["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role)
                ? { status: "faithful", explanation: "source correspondence" }
                : {
                    mode: "proof",
                    route: "independent",
                    proof: "by trivial",
                    explanation: "candidate self-label is untrusted",
                  },
        record: { fixture: true },
      }),
    },
  );
});

test("constructed helper does not mutate source graph identity and its assessment replays", async () => {
  await harness(
    async (e, input, store) => {
      const r = await e.review(input);
      assert.equal(r.steps[0].proof, "by helper");
      assert.equal(r.graph.steps[0].proof, undefined);
      assert.equal(
        (
          await replayOriginalProof(
            await store.bundle(r.root),
            r.root,
            goodCheck,
          )
        ).reproduced,
        true,
      );
    },
    {
      limits: { maxPlans: 1, maxAttempts: 3 },
      checker: async (c, p, o) =>
        p === "by helper"
          ? goodCheck(c, p, o)
          : {
              status: "failed",
              targetHash: c.targetHash,
              exitCode: 1,
              stdout: "missing helper",
              axioms: [],
            },
      prover: {
        prove: async (c) => ({
          candidate: { proof: "by helper" },
          check: await goodCheck(c, "by helper"),
          report: { stopReason: "proved" },
        }),
      },
      model: async (_c, r) => ({
        parsed:
          r.role === "R06_GRAPH"
            ? raw()
            : r.role === "R06_ALIGN"
              ? alignment(r.input.graph)
              : ["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role)
                ? { status: "faithful", explanation: "source correspondence" }
                : r.role === "R06_DIAGNOSE"
                  ? {
                      kind: "lemma",
                      explanation: "construct missing intermediate fact",
                      queries: [],
                      modules: [],
                    }
                  : {
                      mode: "proof",
                      route: "original",
                      proof: "by failing",
                      explanation: "fixture",
                    },
        record: { fixture: true },
      }),
    },
  );
});

test("diagnosed translation is revised as a graph version while independent branches continue", async () => {
  let graphs = 0;
  await harness(
    async (e, input, _store, calls) => {
      const r = await e.review(input);
      assert.equal(graphs, 2);
      assert.equal(r.generation, 1);
      assert.equal(
        calls.filter((r) => ["R06_STEP", "R06_REPAIR"].includes(r)).length,
        4,
        "do not repair proofs against a diagnosed wrong target",
      );
      assert.equal(r.steps.length, 2);
    },
    {
      limits: { maxPlans: 2, maxAttempts: 3 },
      checker: async (c) => ({
        status: "failed",
        exitCode: 1,
        targetHash: c.targetHash,
        axioms: [],
      }),
      model: async (_c, r) => ({
        parsed:
          r.role === "R06_GRAPH"
            ? (graphs++, raw())
            : r.role === "R06_ALIGN"
              ? alignment(r.input.graph)
              : r.role === "R06_DIAGNOSE"
                ? {
                    kind: "translation",
                    targetChangeRequired: true,
                    explanation: "source premise was lost",
                    queries: [],
                    modules: [],
                  }
                : {
                    mode: "proof",
                    route: "original",
                    proof: "by failing",
                    explanation: "fixture",
                  },
        record: { fixture: true },
      }),
    },
  );
});

test("an unknown route-assessor response stays attached to its exact obligation and is not replayed", async () => {
  await harness(
    async (e, input, _store, calls) => {
      const first = await e.review(input);
      assert.ok(
        first.steps.every((s) => s.unknownExternalOutcome && s.contract),
      );
      const n = calls.length;
      const next = await e.review({ ...input, resume: first });
      assert.equal(calls.length, n);
      assert.ok(next.steps.every((s) => s.unknownExternalOutcome));
      const audited = await e.review({
        ...input,
        resume: first,
        verificationOnly: true,
        replayUnknown: false,
      });
      assert.equal(calls.length, n);
      assert.ok(audited.steps.every((s) => s.unknownExternalOutcome));
    },
    {
      model: async (_c, r) => {
        if (r.role === "R06_ROUTE_AUDIT") {
          const e = Error("response outcome unknown");
          e.modelRecord = {
            error: { code: "model_transport_error" },
            resource: { executionStarted: true },
          };
          throw e;
        }
        return {
          parsed:
            r.role === "R06_GRAPH"
              ? raw()
              : r.role === "R06_ALIGN"
                ? alignment(r.input.graph)
                : {
                    mode: "proof",
                    route: "original",
                    proof: "by trivial",
                    explanation: "fixture",
                  },
          record: { fixture: true },
        };
      },
    },
  );
});

test("a prior policy assessment is refreshed before fixed candidates are rechecked", async () => {
  await harness(async (e, input, _store, calls) => {
    const first = await e.review(input);
    const n = calls.length;
    const old = { ...first };
    delete old.proofPolicyVersion;
    const next = await e.review({
      ...input,
      resume: old,
      verificationOnly: true,
    });
    assert.equal(next.summary.status, "verified_with_completion");
    assert.ok(calls.slice(n).includes("R06_ALIGN"));
    assert.ok(!calls.slice(n).includes("R06_GRAPH"));
    assert.ok(!calls.slice(n).includes("R06_STEP"));
  });
});

test("a saved alternative does not hide a later faithful received candidate", async () => {
  await harness(
    async (e, input, store, calls) => {
      const first = await e.review(input);
      assert.equal(first.steps[0].status, "alternative_only");
      const c = {
        name: "Zero",
        contract: first.steps[0].contract,
        value: {
          mode: "proof",
          route: "original",
          proof: "by original",
          explanation: "second received candidate",
        },
      };
      c.artifact = await store.put("original:local_candidate", c, [first.root]);
      c.check = { status: "verified" };
      const n = calls.length;
      const next = await e.review({
        ...input,
        resume: {
          ...first,
          candidateCache: [...(first.candidateCache || []), c],
        },
        verificationOnly: true,
      });
      assert.equal(next.steps[0].status, "passed");
      assert.equal(next.steps[0].proof, "by original");
      assert.equal(next.summary.status, "verified_with_completion");
      assert.ok(
        !calls
          .slice(n)
          .some((r) =>
            ["R06_GRAPH", "R06_STEP", "R06_REPAIR", "R06_DIAGNOSE"].includes(r),
          ),
      );
      assert.equal(
        (
          await replayOriginalProof(
            await store.bundle(next.root),
            next.root,
            goodCheck,
          )
        ).reproduced,
        true,
      );
    },
    {
      model: async (_c, r) => ({
        parsed:
          r.role === "R06_GRAPH"
            ? raw()
            : r.role === "R06_ALIGN"
              ? alignment(r.input.graph)
              : r.role === "R06_ROUTE_AUDIT"
                ? {
                    status:
                      r.input.proof === "by alternative"
                        ? "route_change"
                        : "faithful",
                    explanation: "fixture source route assessment",
                  }
                : r.role === "R06_CONNECTION_AUDIT"
                  ? { status: "faithful", explanation: "fixture connection" }
                  : r.role === "R06_DIAGNOSE"
                    ? {
                        kind: "unknown",
                        explanation: "try other received candidate",
                      }
                    : {
                        mode: "proof",
                        route: "original",
                        proof:
                          r.input.step.name === "Zero"
                            ? "by alternative"
                            : "by original",
                        explanation: "fixture candidate",
                      },
        record: { fixture: true },
      }),
    },
  );
});

test("continuation retries a failed generated route instead of caching it as an irreparable source step", async () => {
  let allowOriginal = false;
  await harness(
    async (e, input) => {
      const first = await e.review(input);
      assert.equal(first.steps[0].status, "route_violation");
      allowOriginal = true;
      const next = await e.review({ ...input, resume: first });
      assert.equal(next.steps[0].status, "passed");
      assert.equal(next.summary.status, "verified_with_completion");
    },
    {
      limits: { maxPlans: 1, maxAttempts: 2 },
      checker: async (c, p, o) => {
        const check = await goodCheck(c, p, o);
        if (p === "by shortcut")
          check.dependencies.edges = [["ForbiddenRoot", []]];
        return check;
      },
      model: async (_c, r) => {
        let parsed;
        if (r.role === "R06_GRAPH") {
          parsed = raw();
          parsed.policy = { forbiddenDeclarations: ["ForbiddenRoot"] };
        } else if (r.role === "R06_ALIGN") parsed = alignment(r.input.graph);
        else if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role))
          parsed = { status: "faithful", explanation: "fixture route" };
        else if (r.role === "R06_DIAGNOSE")
          parsed = { kind: "unknown", explanation: "avoid forbidden shortcut" };
        else {
          const bad = r.input.step.name === "Zero" && !allowOriginal;

          parsed = {
            mode: "proof",
            proof: bad ? "by shortcut" : "by original",
            route: "original",
            explanation: "fixture",
          };
        }
        return { parsed, record: { fixture: true } };
      },
    },
  );
});

test("a changed source policy requires fresh route judgments even when the proof text is cached", async () => {
  let revised = false;
  await harness(
    async (e, input, _store, calls) => {
      const first = await e.review(input);
      revised = true;
      const n = calls.length;
      const next = await e.review({
        ...input,
        repairFrom: first,
        generation: 1,
      });
      assert.equal(next.summary.status, "verified_with_completion");
      assert.equal(
        calls.slice(n).filter((r) => r === "R06_ROUTE_AUDIT").length,
        2,
      );
      assert.ok(
        !calls.slice(n).includes("R06_STEP"),
        "reuse candidate text, not its stale assessment",
      );
    },
    {
      model: async (_c, r) => {
        let parsed;
        if (r.role === "R06_GRAPH") {
          parsed = raw();
          if (revised)
            parsed.policy = { forbiddenDeclarations: ["NewRestriction"] };
        } else if (r.role === "R06_ALIGN") parsed = alignment(r.input.graph);
        else if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role))
          parsed = { status: "faithful", explanation: "fixture route" };
        else
          parsed = {
            mode: "proof",
            route: "original",
            proof: "by original",
            explanation: "fixture",
          };
        return { parsed, record: { fixture: true } };
      },
    },
  );
});

test("proof-script errors do not rewrite a faithful mathematical target", async () => {
  let graphs = 0;
  await harness(
    async (e, input, _store, calls) => {
      const r = await e.review(input);
      assert.equal(graphs, 1);
      assert.ok(calls.includes("R06_REPAIR"));
      assert.equal(r.summary.status, "verified_with_completion");
    },
    {
      limits: { maxPlans: 2, maxAttempts: 2 },
      checker: async (c, p, o) =>
        p === "by syntax_error"
          ? {
              status: "failed",
              targetHash: c.targetHash,
              exitCode: 1,
              axioms: [],
              failureKind: "parse_error",
            }
          : goodCheck(c, p, o),
      model: async (_c, r) => {
        let parsed;
        if (r.role === "R06_GRAPH") {
          graphs++;
          parsed = raw();
        } else if (r.role === "R06_ALIGN") parsed = alignment(r.input.graph);
        else if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role))
          parsed = { status: "faithful", explanation: "fixture route" };
        else if (r.role === "R06_DIAGNOSE")
          parsed = {
            kind: "translation",
            targetChangeRequired: false,
            explanation: "proof-script syntax only",
            queries: [],
            modules: [],
          };
        else
          parsed = {
            mode: "proof",
            route: "original",
            proof: r.role === "R06_STEP" ? "by syntax_error" : "by original",
            explanation: "fixture",
          };
        return { parsed, record: { fixture: true } };
      },
    },
  );
});

test("prior target diagnostics reach a fresh source assessment and invalidate a cached positive mapping", async () => {
  await harness(
    async (e, input, store, calls) => {
      const first = await e.review(input);
      assert.equal(first.steps[0].status, "passed");
      const notes = [
        {
          name: "Zero",
          target: first.graph.steps[0].target,
          diagnosticArtifact: first.steps[0].artifact,
          explanation: "Source-target discrepancy to be independently checked",
        },
      ];
      const artifact = await store.put(
        "original:prior_diagnostics",
        { graphArtifact: first.graphArtifact, notes },
        [first.root],
      );
      const n = calls.length;
      const next = await e.review({
        ...input,
        resume: first,
        verificationOnly: true,
        sourceFeedback: notes,
        sourceFeedbackArtifact: artifact,
      });
      assert.ok(calls.slice(n).includes("R06_ALIGN"));
      assert.equal(next.steps[0].status, "unverified");
      assert.equal(next.summary.status, "partial");
      assert.equal(
        (
          await replayOriginalProof(
            await store.bundle(next.root),
            next.root,
            goodCheck,
          )
        ).reproduced,
        true,
      );
      await assert.rejects(
        () =>
          e.review({
            ...input,
            resume: first,
            verificationOnly: true,
            sourceFeedback: [{ ...notes[0], explanation: "changed" }],
            sourceFeedbackArtifact: artifact,
          }),
        /feedback changed/,
      );
    },
    {
      model: async (_c, r) => {
        let parsed;
        if (r.role === "R06_GRAPH") parsed = raw();
        else if (r.role === "R06_ALIGN") {
          parsed = alignment(r.input.graph);
          if (r.input.priorDiagnostics?.length)
            parsed.checks[0] = {
              ...parsed.checks[0],
              status: "concern",
              explanation: "Prior discrepancy checked against original source",
            };
        } else if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role))
          parsed = { status: "faithful", explanation: "fixture route" };
        else
          parsed = {
            mode: "proof",
            route: "original",
            proof: "by original",
            explanation: "fixture",
          };
        return { parsed, record: { fixture: true } };
      },
    },
  );
});

test("invalid alignment is retried on the same validated graph and preserves prior diagnostics", async () => {
  let continuing = false;
  let alignments = 0;
  await harness(
    async (e, input, store) => {
      const first = await e.review(input);
      const notes = [
        {
          name: "Zero",
          target: first.graph.steps[0].target,
          diagnosticArtifact: first.steps[0].artifact,
          explanation: "Check prior target",
        },
      ];
      const artifact = await store.put(
        "original:prior_diagnostics",
        { graphArtifact: first.graphArtifact, notes },
        [first.root],
      );
      continuing = true;
      const next = await e.review({
        ...input,
        resume: first,
        sourceFeedback: notes,
        sourceFeedbackArtifact: artifact,
      });
      assert.equal(next.graphArtifact, first.graphArtifact);
      assert.equal(
        (
          await replayOriginalProof(
            await store.bundle(next.root),
            next.root,
            goodCheck,
          )
        ).reproduced,
        true,
      );
    },
    {
      limits: { maxPlans: 2 },
      model: async (_c, r) => {
        let parsed;
        if (r.role === "R06_GRAPH") {
          parsed = raw();
        } else if (r.role === "R06_ALIGN") {
          parsed = alignment(r.input.graph);
          if (continuing && alignments++ === 0) parsed.checks = [];
        } else if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role))
          parsed = { status: "faithful", explanation: "fixture route" };
        else
          parsed = {
            mode: "proof",
            route: "original",
            proof: "by original",
            explanation: "fixture",
          };
        return { parsed, record: { fixture: true } };
      },
    },
  );
});

test("source-anchored candidate text survives a target revision and is rechecked without proof regeneration", async () => {
  let revised = false;
  const checked = [];
  await harness(
    async (e, input, store, calls) => {
      const first = await e.review(input);
      const n = calls.length;
      revised = true;
      const next = await e.review({
        ...input,
        repairFrom: first,
        generation: 1,
      });
      assert.equal(next.summary.status, "verified_with_completion");
      assert.notEqual(
        next.steps[0].contract.targetHash,
        first.steps[0].contract.targetHash,
      );
      assert.ok(checked.includes(next.steps[0].contract.targetHash));
      assert.ok(
        !calls.slice(n).some((r) => ["R06_STEP", "R06_REPAIR"].includes(r)),
      );
      assert.equal(
        (
          await replayOriginalProof(
            await store.bundle(next.root),
            next.root,
            goodCheck,
          )
        ).reproduced,
        true,
      );
    },
    {
      checker: async (c, p, o) => {
        checked.push(c.targetHash);
        return goodCheck(c, p, o);
      },
      model: async (_c, r) => {
        let parsed;
        if (r.role === "R06_GRAPH") {
          parsed = raw();
          if (revised) parsed.steps[0].target = "∀ n : Nat, n+0=n";
        } else if (r.role === "R06_ALIGN") parsed = alignment(r.input.graph);
        else if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role))
          parsed = { status: "faithful", explanation: "fixture route" };
        else
          parsed = {
            mode: "proof",
            route: "original",
            proof: "by original",
            explanation: "fixture",
          };
        return { parsed, record: { fixture: true } };
      },
    },
  );
});

test("a failed received script can be rescued after its mistranslated goal is corrected", async () => {
  let revised = false;
  await harness(
    async (e, input, _store, calls) => {
      const first = await e.review(input);
      assert.equal(first.steps[0].status, "unverified");
      revised = true;
      const n = calls.length;
      const next = await e.review({
        ...input,
        repairFrom: first,
        generation: 1,
      });
      assert.equal(next.summary.status, "verified_with_completion");
      assert.ok(
        !calls.slice(n).some((r) => ["R06_STEP", "R06_REPAIR"].includes(r)),
      );
    },
    {
      checker: async (c, p, o) =>
        c.leanTarget.includes("n + 1 = n")
          ? {
              status: "failed",
              mode: "proof",
              targetHash: c.targetHash,
              exitCode: 1,
              axioms: [],
              stdout: "rfl cannot prove this goal",
            }
          : goodCheck(c, p, o),
      model: async (_c, r) => {
        let parsed;
        if (r.role === "R06_GRAPH") {
          parsed = raw();
          if (!revised) parsed.steps[0].target = "∀ n : Nat, n + 1 = n";
        } else if (r.role === "R06_ALIGN") parsed = alignment(r.input.graph);
        else if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role))
          parsed = { status: "faithful", explanation: "fixture route" };
        else if (r.role === "R06_DIAGNOSE")
          parsed = {
            kind: "translation",
            targetChangeRequired: true,
            explanation: "wrong goal, preserve proof text",
          };
        else
          parsed = {
            mode: "proof",
            route: "original",
            proof: "by original",
            explanation: "fixture",
          };
        return { parsed, record: { fixture: true } };
      },
    },
  );
});

test("helper repair receives compact diagnostics even when its dependency audit is unresolved", async () => {
  let observed = 0;
  await harness(
    async (e, input) => {
      const r = await e.review(input);
      assert.equal(r.summary.status, "verified_with_completion");
      assert.ok(observed > 0);
    },
    {
      limits: { maxPlans: 1, maxAttempts: 3, maxRequestCharacters: 18000 },
      checker: async (c, p, o) => {
        const v = await goodCheck(c, p, o);
        if (p !== "by failing" && p !== "by helper") return v;
        if (p === "by helper") {
          v.dependencies.complete = false;
          v.dependencies.edges = [["x".repeat(2000000), []]];
          return v;
        }
        return {
          status: "not_verified",
          targetHash: c.targetHash,
          exitCode: 1,
          axioms: [],
          stdout: "missing helper",
        };
      },
      prover: {
        prove: async (c) => ({
          candidate: { proof: "by helper" },
          check: await goodCheck(c, "by helper"),
          report: { stopReason: "proved" },
        }),
      },
      model: async (_c, r) => {
        let parsed;
        if (r.role === "R06_GRAPH") parsed = raw();
        else if (r.role === "R06_ALIGN") parsed = alignment(r.input.graph);
        else if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role))
          parsed = { status: "faithful", explanation: "fixture route" };
        else if (r.role === "R06_DIAGNOSE")
          parsed = {
            kind: "lemma",
            explanation: "construct intermediate fact",
            queries: [],
            modules: [],
          };
        else {
          const helper = r.input.feedback?.lemmaConstruction;
          if (helper) {
            observed++;
            assert.equal(helper.check.dependencies, undefined);
          }
          parsed = {
            mode: "proof",
            route: "original",
            proof: helper ? "by repaired" : "by failing",
            explanation: "fixture",
          };
        }
        return { parsed, record: { fixture: true } };
      },
    },
  );
});

test("assembly repair receives compiler diagnostics and actual use, not the giant dependency closure", async () => {
  let connectionChecks = 0;
  await harness(
    async (e, input, _store, calls) => {
      const r = await e.review(input);
      assert.equal(r.summary.status, "verified_with_completion");
      assert.ok(calls.includes("R06_ASSEMBLY_REPAIR"));
    },
    {
      limits: { maxPlans: 1, maxAttempts: 2, maxRequestCharacters: 18000 },
      checker: async (c, p, o = {}) => {
        const v = await goodCheck(c, p, o);
        if (o.requiredBinders === 2 && connectionChecks++ === 0) {
          v.dependencies.binderUse = [false, false];
          v.dependencies.edges = [["x".repeat(2000000), []]];
          v.stdout = "LEMMA_DEPENDENCIES:" + "x".repeat(2000000);
        }
        return v;
      },
      model: async (_c, r) => {
        let parsed;
        if (r.role === "R06_GRAPH") parsed = raw();
        else if (r.role === "R06_ALIGN") parsed = alignment(r.input.graph);
        else if (r.role === "R06_ASSEMBLY_REPAIR") {
          assert.ok(r.input.feedback.actualStepGraph.length);
          assert.equal(r.input.feedback.check.dependencies, undefined);
          parsed = { assembly: raw().assembly };
        } else if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role))
          parsed = { status: "faithful", explanation: "fixture route" };
        else
          parsed = {
            mode: "proof",
            route: "original",
            proof: "by original",
            explanation: "fixture",
          };
        return { parsed, record: { fixture: true } };
      },
    },
  );
});

test("failed interface generation and invalid alignment retry their own stage without replacing a valid graph", async () => {
  let interfaces = 0,
    alignments = 0;
  await harness(
    async (e, input, store, calls) => {
      const result = await e.review(input);
      assert.equal(result.assembly.status, "verified");
      assert.equal(calls.filter((r) => r === "R06_GRAPH").length, 1);
      assert.equal(interfaces, 2, "failed proposal cannot be marked prepared");
      assert.equal(
        alignments,
        2,
        "invalid mapping must retry on the prepared graph",
      );
      assert.equal(result.blueprint.preflight.status, "well_typed");
      assert.equal(result.interfacePrepared, result.graphArtifact);
      const prepared = await store.get(result.interfacePrepared);
      assert.equal(prepared.kind, "original:R06_INTERFACES");
    },
    {
      proofWorkspace: true,
      limits: { maxPlans: 4, maxAttempts: 1 },
      model: async (_c, r) => {
        let parsed;
        if (r.role === "R06_GRAPH") parsed = raw();
        else if (r.role === "R06_INTERFACES") {
          interfaces++;
          parsed =
            interfaces === 1
              ? { graph: { steps: [] } }
              : { graph: r.input.graph, changes: [], interfaces: [] };
        } else if (r.role === "R06_ALIGN") {
          alignments++;
          parsed = alignment(r.input.graph);
          if (alignments === 1) parsed.checks = [];
        } else if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role))
          parsed = { status: "faithful", explanation: "controlled fixture" };
        else
          parsed = {
            mode: "proof",
            proof: "by trivial",
            route: "original",
            explanation: "controlled fixture",
          };
        return { parsed, record: { fixture: true } };
      },
    },
  );
});
for (const prefix of ["original", "task"])
  test(`prepared interface continuation accepts the ${prefix} stage adapter and rejects unrelated receipts`, async () => {
    await harness(
      async (engine, input, store, calls) => {
        const runStage = async (role, _title, inputs, execute) => {
          const value = await execute();
          return {
            value,
            artifact: await store.put(`${prefix}:${role}`, value, inputs),
          };
        };
        const first = await engine.review({ ...input, task: runStage });
        assert.equal(first.assembly.status, "verified");
        assert.equal(
          (await store.get(first.interfacePrepared)).kind,
          `${prefix}:R06_INTERFACES`,
        );
        const count = calls.length;
        const resumed = await engine.review({
          ...input,
          resume: first,
          verificationOnly: true,
          task: runStage,
        });
        assert.equal(resumed.assembly.status, "verified");
        assert.equal(
          calls.length,
          count,
          "fixed candidate recheck must not request new answers",
        );
        const unrelated = await store.put(
          "task:R99_UNRELATED",
          { graph: first.graph },
          [first.graphArtifact],
        );
        await assert.rejects(
          engine.review({
            ...input,
            resume: {
              ...first,
              graphArtifact: unrelated,
              interfacePrepared: unrelated,
            },
            verificationOnly: true,
            task: runStage,
          }),
          /Prepared interface checkpoint changed/,
        );
      },
      {
        proofWorkspace: true,
        model: async (_config, request) => ({
          parsed:
            request.role === "R06_GRAPH"
              ? raw()
              : request.role === "R06_INTERFACES"
                ? { graph: request.input.graph, changes: [], interfaces: [] }
                : request.role === "R06_ALIGN"
                  ? alignment(request.input.graph)
                  : ["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(
                        request.role,
                      )
                    ? {
                        status: "faithful",
                        explanation: "explicit controlled fixture",
                      }
                    : {
                        mode: "proof",
                        route: "original",
                        proof: "by trivial",
                        explanation: "explicit controlled fixture",
                      },
          record: { fixture: true },
        }),
      },
    );
  });

test("a source policy repair is an independent scoped Agent receipt, not a proof or a hidden rule deletion", async () =>
  harness(
    async (engine, input, store, calls) => {
      const first = await engine.review(input);
      assert.equal(calls.filter((r) => r === "R06_POLICY_AUDIT").length, 1);
      assert(first.graph.policy.forbiddenFamilies.includes("axiom"));
      assert.deepEqual(first.policy.forbiddenFamilies, ["Forbidden.method"]);
      assert.equal(first.policyNormalization.status, "resolved");
      assert.equal(
        first.policyNormalization.authority,
        "independent_agent_not_kernel_or_human",
      );
      assert.equal(first.assembly.status, "verified");
      const bundle = await store.bundle(first.root);
      assert(
        bundle.artifacts.some(
          (a) => a.id === first.policyNormalization.artifact,
        ),
      );
      assert.equal(
        (await replayOriginalProof(bundle, first.root, goodCheck)).reproduced,
        true,
      );
      const count = calls.length;
      const next = await engine.review({
        ...input,
        resume: first,
        verificationOnly: true,
      });
      assert.equal(calls.length, count);
      assert.equal(next.assembly.status, "verified");
      assert.equal(
        (
          await replayOriginalProof(
            await store.bundle(next.root),
            next.root,
            goodCheck,
          )
        ).reproduced,
        true,
      );
      const root = await store.get(first.root);
      const forged = await store.put(
        "original_proof_report",
        { ...root.payload, policy: { ...first.policy, forbiddenFamilies: [] } },
        root.inputs,
      );
      await assert.rejects(
        replayOriginalProof(await store.bundle(forged), forged, goodCheck),
        /Effective source policy changed/,
      );
    },
    {
      model: async (_c, r) => {
        let parsed;
        if (r.role === "R06_GRAPH")
          parsed = {
            ...raw(),
            policy: { forbiddenFamilies: ["axiom", "Forbidden.method"] },
          };
        else if (r.role === "R06_POLICY_AUDIT")
          parsed = {
            status: "resolved",
            policy: {
              ...r.input.rawPolicy,
              forbiddenFamilies: ["Forbidden.method"],
            },
            resolutions: [
              {
                family: "axiom",
                interpretation: "kernel_rule",
                explanation:
                  "Fixture syntax rule only; no added foundation is accepted.",
              },
            ],
            addedRestrictions: [],
            explanation: "Explicit fixture independent policy review.",
          };
        else if (r.role === "R06_ALIGN") parsed = alignment(r.input.graph);
        else if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role))
          parsed = {
            status: "faithful",
            explanation: "Explicit fixture route review.",
          };
        else
          parsed = {
            mode: "proof",
            route: r.input.step.kind === "omitted" ? "completion" : "original",
            proof: "by trivial",
            explanation:
              "Scripted control-flow fixture, not mathematical evidence.",
          };
        return { parsed, record: { fixture: true } };
      },
      checker: async (c, p, o) => {
        const checked = await goodCheck(c, p, o);
        return {
          ...checked,
          axioms: ["Classical.choice"],
          dependencies: {
            ...checked.dependencies,
            edges: [["Classical.axiomOfChoice", []]],
          },
        };
      },
    },
  ));
test("only policy requests that actually started and lack a known response inherit an unknown dispatch", () => {
  const previous = {
    id: "fixture",
    tasks: [
      {
        id: "started",
        role: "R06_POLICY_AUDIT",
        status: "interrupted",
        modelStartedAt: "fixture",
        output: null,
      },
      {
        id: "queued",
        role: "R06_POLICY_AUDIT",
        status: "interrupted",
        output: null,
      },
      {
        id: "received",
        role: "R06_POLICY_AUDIT",
        status: "succeeded",
        modelStartedAt: "fixture",
        output: "receipt",
      },
      {
        id: "failureUnknown",
        role: "R06_POLICY_AUDIT",
        status: "blocked",
        output: "failureReceipt",
        externalOutcome: "unknown",
      },
      {
        id: "other",
        role: "R06_STEP",
        status: "interrupted",
        modelStartedAt: "fixture",
        output: null,
      },
    ],
  };
  assert.deepEqual(
    inheritedUnknownPolicyTasks(previous).map((t) => t.id),
    ["started", "failureUnknown"],
  );
});

test("a continuation interrupted before route publication preserves its Agent-only session and defaults to no unknown replay", async () =>
  harness(async (_e, input, store) => {
    const { randomUUID } = await import("node:crypto");
    const { freshProofSession } = await import("../server/proof-autonomy.mjs");
    const parent = {
      id: randomUUID(),
      status: "completed",
      contract: input.contract,
      context: input.context,
      sourceArtifact: input.sourceArtifact,
      contractArtifact: input.contractArtifact,
      contextArtifact: input.contextArtifact,
      paperSha256: input.contract.paperSha256,
    };
    const previous = {
      id: randomUUID(),
      engine: "original-proof-v1",
      reviewRunId: parent.id,
      status: "interrupted",
      autonomy: freshProofSession(),
      originalProofRoute: null,
      tasks: [],
      root: null,
    };
    await store.saveRun(parent);
    await store.saveRun(previous);
    const service = new OriginalProofService({
      store,
      getConfig: async () => ({ model: "fixture" }),
    });
    let executed;
    service.execute = async (r) => {
      executed = r;
    };
    const next = await service.start({
      reviewRunId: parent.id,
      continuedFrom: previous.id,
    });
    assert.equal(next.autonomy.sessionId, previous.autonomy.sessionId);
    assert.equal(next.replayUnknown, false);
    assert.equal(executed.autonomy.policy, "fresh_agent_only");
  }));
