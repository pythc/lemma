import test from "node:test";
import assert from "node:assert/strict";
import { createContract } from "../server/contracts.mjs";
import { sha256, digest } from "../server/evidence.mjs";
import { ProvingEngine } from "../server/proving-engine.mjs";
import {
  validateDecomposition,
  composeDecomposition,
  obligationContract,
  proveDecomposition,
} from "../server/proof-decomposition.mjs";
import { evidenceDisplay } from "../shared/evidence-display.mjs";
export const root = createContract(
  {
    text: "fixture",
    paperSha256: sha256("fixture"),
    pageIndex: 0,
    artifact: sha256("source"),
  },
  {
    label: "fixture",
    quote: "fixture",
    statement: "execution fixture",
    assumptions: [],
    leanTarget: "(∀ n : Nat, n + 0 = n) ∧ (∀ n : Nat, (n + 0) + 0 = n)",
  },
);
export const plan = () => ({
  parts: [
    {
      name: "Zero",
      target: "∀ n : Nat, n + 0 = n",
      purpose: "first identity",
      dependsOn: [],
      proof: "by intro n; rfl",
    },
    {
      name: "Twice",
      target: "∀ n : Nat, (n + 0) + 0 = n",
      purpose: "compose the first identity",
      dependsOn: ["Zero"],
      proof:
        "by intro ProofPart_Zero n; exact (ProofPart_Zero (n + 0)).trans (ProofPart_Zero n)",
    },
  ],
  assembly:
    "by intro ProofPart_Zero ProofPart_Twice; exact ⟨ProofPart_Zero, ProofPart_Twice⟩",
});
const accepted = (c, mode = "proof") => ({
  status: "verified",
  targetHash: c.targetHash,
  mode,
  exitCode: 0,
  axioms: [],
});
test("decomposition rejects cycles, unknown dependencies, root repetition and injected commands", () => {
  for (const mutate of [
    (p) => p.parts[0].dependsOn.push("Twice"),
    (p) => p.parts[0].dependsOn.push("Missing"),
    (p) => (p.parts[0].target = root.leanTarget),
    (p) => (p.assembly = "by sorry"),
    (p) => (p.parts[0].name = "bad.name"),
  ]) {
    const p = plan();
    mutate(p);
    assert.throws(() => validateDecomposition(p, root));
  }
  const p = validateDecomposition(plan(), root);
  assert.throws(() => composeDecomposition(p, new Map()), /Unproved/);
  const c = obligationContract(root, "Twice", p.parts[1].target, [p.parts[0]]);
  assert.notEqual(c.targetHash, root.targetHash);
  assert.equal(c.proofObligation.rootTargetHash, root.targetHash);
  assert.deepEqual(c.imports, root.imports);
});
test("selected decomposition evidence shows mathematical purposes without execution metadata", () => {
  const value = evidenceDisplay({
    parsed: plan(),
    record: { request: { secret: "must not be shown" } },
  });
  assert.equal(value.lists[0][0], "辅助命题方案");
  assert.equal(value.lists[0][1].length, 2);
  assert.ok(!JSON.stringify(value).includes("secret"));
});
test("shared project counts actual requests and checks helpers without promoting them to the root", async () => {
  let calls = 0,
    rootChecks = 0;
  const original = digest(root);
  const engine = new ProvingEngine({
    knowledge: async () => ({ entries: [] }),
    capabilities: async () => ({ ready: false }),
    specialistAvailable: async () => ({ ready: false }),
    checker: async (c) => {
      if (c.targetHash === root.targetHash) rootChecks++;
      return accepted(c);
    },
    model: async (_c, r) => {
      calls++;
      return {
        parsed:
          r.role === "R09_DECOMPOSE"
            ? plan()
            : { unavailable: "needs smaller steps" },
        record: { provider: "fixture" },
      };
    },
  });
  const result = await engine.prove(root, {
    config: { model: "fixture" },
    budget: { maxModelCalls: 6, maxTacticSteps: 0, maxDecompositionPlans: 1 },
  });
  assert.equal(result.report.stopReason, "verified");
  assert.equal(rootChecks, 1);
  assert.equal(calls, 2);
  assert.equal(result.report.modelCalls, 2);
  assert.equal(result.report.decomposition.helpers.length, 2);
  assert.ok(result.candidate.proof.includes("have ProofPart_Zero"));
  assert.equal(digest(root), original);
});
test("a conditional connection is never enough when one helper is false", async () => {
  const p = {
    parts: [
      {
        name: "Impossible",
        target: "False",
        purpose: "deliberately false fixture",
        dependsOn: [],
        proof: "by trivial",
      },
    ],
    assembly:
      "by intro ProofPart_Impossible; exact False.elim ProofPart_Impossible",
  };
  let rootChecks = 0;
  const engine = new ProvingEngine({
    knowledge: async () => ({ entries: [] }),
    capabilities: async () => ({ ready: false }),
    specialistAvailable: async () => ({ ready: false }),
    checker: async (c) => {
      if (c.targetHash === root.targetHash) rootChecks++;
      return c.leanTarget === "False"
        ? {
            ...accepted(c),
            status: "not_verified",
            exitCode: 1,
            stdout: "unsolved goals",
          }
        : accepted(c);
    },
    model: async (_c, r) => ({
      parsed:
        r.role === "R09_DECOMPOSE"
          ? p
          : { unavailable: "fixture has no proof" },
      record: { provider: "fixture" },
    }),
  });
  const result = await engine.prove(root, {
    config: { model: "fixture" },
    budget: {
      maxModelCalls: 5,
      maxHelperModelCalls: 1,
      maxTacticSteps: 0,
      maxDecompositionPlans: 1,
    },
  });
  assert.notEqual(result.report.stopReason, "verified");
  assert.equal(rootChecks, 0);
  assert.equal(result.check, null);
  assert.equal(
    result.report.decomposition.plans[0].connection.check.status,
    "verified",
  );
  assert.equal(result.report.decomposition.helpers[0].status, "unresolved");
});
test("decomposition transport uncertainty stops all later model dispatch", async () => {
  let calls = 0;
  const engine = new ProvingEngine({
    knowledge: async () => ({ entries: [] }),
    capabilities: async () => ({ ready: false }),
    specialistAvailable: async () => ({ ready: false }),
    model: async (_c, r) => {
      calls++;
      if (r.role === "R09_DECOMPOSE")
        throw Object.assign(Error("lost response"), {
          modelRecord: { error: { code: "model_transport_error" } },
        });
      return { parsed: { unavailable: "fixture" }, record: {} };
    },
  });
  const result = await engine.prove(root, {
    config: { model: "fixture" },
    budget: { maxModelCalls: 8, maxTacticSteps: 0 },
  });
  assert.equal(result.report.stopReason, "external_outcome_unknown");
  assert.equal(result.report.decomposition.status, "external_outcome_unknown");
  assert.equal(calls, 2);
});
test("request and aggregate input limits are reported separately before dispatch", async () => {
  for (const [budget, constraint] of [
    [{ maxRequestCharacters: 1 }, "per_request_input"],
    [{ maxInputCharacters: 1 }, "total_input"],
  ]) {
    let calls = 0;
    const engine = new ProvingEngine({
      knowledge: async () => ({ entries: [] }),
      capabilities: async () => ({ ready: false }),
      specialistAvailable: async () => ({ ready: false }),
      model: async () => {
        calls++;
        throw Error("not allowed");
      },
    });
    const result = await engine.prove(root, {
      config: { model: "fixture" },
      budget: { ...budget, maxTacticSteps: 0 },
    });
    assert.equal(calls, 0);
    assert.equal(result.report.budgetStop.constraint, constraint);
  }
});
test("whole-proof repair receives the replayed partial tactic journal and goals", async () => {
  let generations = 0,
    observed = false;
  const sessionFactory = () => ({
    closed: false,
    initialState: 0,
    journal: [],
    goals: ["⊢ root"],
    async create() {
      return { status: "ready" };
    },
    async close() {
      this.closed = true;
    },
    checkpoint() {
      return {
        checkpointHash: digest(this.journal),
        journal: [...this.journal],
        goals: [...this.goals],
      };
    },
    async resume(c) {
      this.journal = [...c.journal];
      this.goals = [...c.goals];
      return { status: "ready" };
    },
    async rollback() {},
    async runSearch() {
      return { completed: false };
    },
    async queryPremises() {
      return { status: "resolved", entries: [] };
    },
    async inspectGoal() {
      return { state: 0, goals: this.goals };
    },
    async applyTactic(t) {
      this.journal.push(t);
      this.goals = ["n : Nat ⊢ reduced goal"];
      return { status: "advanced", goals: this.goals, completed: false };
    },
  });
  const engine = new ProvingEngine({
    sessionFactory,
    knowledge: async () => ({ entries: [] }),
    capabilities: async () => ({ ready: true }),
    specialistAvailable: async () => ({ ready: false }),
    checker: async (c) => accepted(c),
    model: async (_c, r) => {
      if (r.role === "R09_TACTIC")
        return { parsed: { tactics: ["intro n"] }, record: {} };
      generations++;
      if (generations === 1)
        return { parsed: { unavailable: "needs progress" }, record: {} };
      observed =
        r.input.partialProgress.journal.includes("intro n") &&
        r.input.partialProgress.goals[0].includes("reduced");
      return { parsed: { proof: "by trivial", mode: "proof" }, record: {} };
    },
  });
  const result = await engine.prove(root, {
    config: { model: "fixture" },
    budget: { maxModelCalls: 3, maxDecompositionPlans: 0 },
  });
  assert.equal(result.report.stopReason, "verified");
  assert.equal(observed, true);
});
test("resumed helper proofs are rechecked, not trusted from stored status", async () => {
  let helperChecks = 0;
  const make = (p) =>
    new ProvingEngine({
      knowledge: async () => ({ entries: [] }),
      capabilities: async () => ({ ready: false }),
      specialistAvailable: async () => ({ ready: false }),
      checker: async (c) => {
        if (c.proofObligation?.name !== "Connection" && c.proofObligation)
          helperChecks++;
        return accepted(c);
      },
      model: async (_c, r) => ({
        parsed: r.role === "R09_DECOMPOSE" ? p : { unavailable: "fixture" },
        record: {},
      }),
    });
  const first = await make(plan()).prove(root, {
    config: { model: "fixture" },
    budget: { maxModelCalls: 6, maxTacticSteps: 0, maxDecompositionPlans: 1 },
  });
  const p = plan();
  for (const part of p.parts) delete part.proof;
  const second = await make(p).prove(root, {
    config: { model: "fixture" },
    initialDecomposition: first.report.decomposition,
    budget: { maxModelCalls: 6, maxTacticSteps: 0, maxDecompositionPlans: 1 },
  });
  assert.equal(second.report.stopReason, "verified");
  assert.equal(helperChecks, 4);
});
test("a difficult helper can decompose recursively while sharing the root request budget", async () => {
  let calls = 0;
  const engine = new ProvingEngine({
    knowledge: async () => ({ entries: [] }),
    capabilities: async () => ({ ready: false }),
    specialistAvailable: async () => ({ ready: false }),
    checker: async (c) => accepted(c),
    model: async (_c, r) => {
      calls++;
      if (r.role !== "R09_DECOMPOSE")
        return {
          parsed: { unavailable: "needs an internal lemma" },
          record: {},
        };
      if (r.input.root.targetHash === root.targetHash) {
        const p = plan();
        delete p.parts[0].proof;
        return { parsed: p, record: {} };
      }
      return {
        parsed: {
          parts: [
            {
              name: "Reflexive",
              target: "∀ n : Nat, n = n",
              purpose: "atomic identity",
              dependsOn: [],
              proof: "by intro n; rfl",
            },
          ],
          assembly: "by intro ProofPart_Reflexive n; rfl",
        },
        record: {},
      };
    },
  });
  const result = await engine.prove(root, {
    config: { model: "fixture" },
    budget: {
      maxModelCalls: 10,
      maxTacticSteps: 0,
      maxDecompositionPlans: 1,
      maxDecompositionDepth: 2,
      maxHelperModelCalls: 8,
    },
  });
  assert.equal(result.report.stopReason, "verified");
  assert.equal(calls, 4);
  assert.equal(result.report.modelCalls, calls);
  assert.equal(
    result.report.decomposition.helpers[0].report.decomposition.helpers[0]
      .status,
    "verified",
  );
});
test("explicit output truncation can switch to a smaller proof strategy without replaying the request", async () => {
  const roles = [];
  const engine = new ProvingEngine({
    knowledge: async () => ({ entries: [] }),
    capabilities: async () => ({ ready: false }),
    specialistAvailable: async () => ({ ready: false }),
    checker: async (c) => accepted(c),
    model: async (_c, r) => {
      roles.push(r.role);
      if (r.role === "R09")
        throw Object.assign(Error("complete response hit output cap"), {
          modelRecord: {
            finishReason: "length",
            error: { code: "model_incomplete" },
          },
        });
      return { parsed: plan(), record: {} };
    },
  });
  const result = await engine.prove(root, {
    config: { model: "fixture" },
    budget: { maxModelCalls: 6, maxTacticSteps: 0 },
  });
  assert.equal(result.report.stopReason, "verified");
  assert.deepEqual(roles, ["R09", "R09_DECOMPOSE"]);
});
test("helper output exhaustion is included in the next decomposition's concrete feedback", async () => {
  let sawReason = false;
  const p = {
    parts: [
      {
        name: "Impossible",
        target: "False",
        purpose: "negative fixture",
        dependsOn: [],
        proof: "by trivial",
      },
    ],
    assembly:
      "by intro ProofPart_Impossible; exact False.elim ProofPart_Impossible",
  };
  const engine = new ProvingEngine({
    knowledge: async () => ({ entries: [] }),
    capabilities: async () => ({ ready: false }),
    specialistAvailable: async () => ({ ready: false }),
    checker: async (c) =>
      c.leanTarget === "False"
        ? {
            ...accepted(c),
            status: "not_verified",
            exitCode: 1,
            stdout: "unsolved goals",
          }
        : accepted(c),
    model: async (_c, r) => {
      if (r.role === "R09_DECOMPOSE") {
        if (r.input.failure?.stopReason) {
          sawReason = r.input.failure.stopReason === "model_output_budget";
          return {
            parsed: { unavailable: "fixture stop after observed feedback" },
            record: {},
          };
        }
        return { parsed: p, record: {} };
      }
      if (r.input.contract.proofObligation?.name === "Impossible")
        throw Object.assign(Error("length"), {
          modelRecord: {
            finishReason: "length",
            error: { code: "model_incomplete" },
          },
        });
      return { parsed: { unavailable: "fixture" }, record: {} };
    },
  });
  const result = await engine.prove(root, {
    config: { model: "fixture" },
    budget: {
      maxModelCalls: 7,
      maxTacticSteps: 0,
      maxDecompositionPlans: 2,
      maxDecompositionDepth: 1,
    },
  });
  assert.equal(sawReason, true);
  assert.notEqual(result.report.stopReason, "verified");
});
test("unknown outcomes nested in a saved helper cannot be resumed silently", async () => {
  let calls = 0;
  const engine = new ProvingEngine({
    model: async () => {
      calls++;
      throw Error("not allowed");
    },
  });
  await assert.rejects(
    engine.prove(root, {
      initialDecomposition: {
        rootTargetHash: root.targetHash,
        status: "unresolved",
        helpers: [{ report: { stopReason: "external_outcome_unknown" } }],
      },
    }),
    /unknown-outcome/,
  );
  assert.equal(calls, 0);
});

test("plan repair retains a rejected candidate and nested progress but requires a fresh helper check", async () => {
  const p = plan();
  delete p.parts[0].proof;
  let attempts = 0;
  const nested = {
    status: "unresolved",
    helpers: [{ name: "Inner", status: "verified" }],
  };
  const project = await proveDecomposition({
    root,
    context: {},
    premises: [],
    failure: null,
    budget: {
      maxDecompositionPlans: 2,
      maxHelperParts: 4,
      maxDecompositionDepth: 2,
      maxHelperModelCalls: 4,
      maxCandidates: 4,
    },
    signal: new AbortController().signal,
    model: async () => ({ parsed: p }),
    checker: async (c) => accepted(c),
    step: async (_kind, _title, action) => action(),
    remaining: () => 10000,
    reserve: async () => true,
    available: () => ({
      config: {},
      modelCalls: 4,
      completionTokens: 10000,
      inputCharacters: 10000,
      tacticSteps: 0,
    }),
    childProve: async (c, options) => {
      if (c.proofObligation.name === "Zero") {
        attempts++;
        if (attempts === 1)
          return {
            candidate: { proof: "by intro n; exact Nat.add_zero n" },
            check: { ...accepted(c), status: "not_verified", exitCode: 1 },
            report: { stopReason: "search_exhausted", decomposition: nested },
          };
        assert.equal(
          options.initialCandidate.proof,
          "by intro n; exact Nat.add_zero n",
        );
        assert.equal(options.initialDecomposition, nested);
      }
      return {
        candidate: options.initialCandidate,
        check: accepted(c),
        report: { stopReason: "verified" },
      };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(project.report.helpers[0].status, "unresolved");
  assert.equal(
    project.report.helpers[0].candidate.proof,
    "by intro n; exact Nat.add_zero n",
  );
  assert.equal(project.report.status, "assembled_candidate");
  assert.ok(project.proof.includes("ProofPart_Zero"));
});
