import test from "node:test";
import assert from "node:assert/strict";
import {
  ProvingEngine,
  validateProvingBudget,
} from "../server/proving-engine.mjs";
import { extractSpecialistProof } from "../server/specialist-model.mjs";
import { createContract } from "../server/contracts.mjs";
import { sha256 } from "../server/evidence.mjs";
import {
  missingDeclarationQueries,
  mergePremises,
} from "../server/proving-retrieval.mjs";
import { diagnose } from "../server/repair.mjs";

test("compiler lookup recognizes missing fields and never turns diagnostic text into code", () => {
  const diagnostic = diagnose({
    status: "not_verified",
    stdout:
      "Invalid field `tendsto_subseq`: The environment does not contain `Function.tendsto_subseq`",
  });
  assert.equal(diagnostic.category, "unknown_declaration");
  assert.deepEqual(missingDeclarationQueries(diagnostic), [
    "tendsto_subseq",
    "Function.tendsto_subseq",
  ]);
  assert.deepEqual(
    missingDeclarationQueries({
      category: "unknown_declaration",
      message: "Unknown identifier `𝓝`\nUnknown constant `foo;run_cmd`",
    }),
    [],
  );
});

test("diagnostic premises are preferred without duplicate or fabricated signatures", () => {
  const preferred = { name: "A.theorem", signature: "current" };
  assert.deepEqual(
    mergePremises(
      [{ name: "A.theorem", signature: "old" }, { name: "b" }],
      [preferred],
      1,
    ),
    [preferred],
  );
});
const contract = createContract(
  {
    paperSha256: sha256("test"),
    text: "one equals one",
    pageIndex: 0,
    artifact: sha256("source"),
  },
  {
    label: "fixture",
    quote: "one equals one",
    statement: "one equals one",
    assumptions: [],
    leanTarget: "1 = (1 : Nat)",
  },
  "std-v1",
);
test("specialist output cannot change target or append declarations", () => {
  assert.equal(
    extractSpecialistProof(
      "```lean4\ntheorem lemma_candidate : (1 = (1 : Nat)) := by rfl\n```",
      contract.leanTarget,
    ),
    "by rfl",
  );
  for (const content of [
    "```lean4\ntheorem lemma_candidate : (True) := by trivial\n```",
    "```lean4\ntheorem lemma_candidate : (1 = (1 : Nat)) := by sorry\n```",
    "```lean4\ntheorem lemma_candidate : (1 = (1 : Nat)) := by rfl\naxiom wrong : False\n```",
  ])
    assert.throws(() => extractSpecialistProof(content, contract.leanTarget));
});
test("proving budgets reject invalid and unbounded values", () => {
  for (const b of [
    { maxElapsedMs: Infinity },
    { maxModelCalls: 1000 },
    { maxTacticSteps: -1 },
    { perStepMs: 0 },
  ])
    assert.throws(() => validateProvingBudget(b));
});
const setup = (checker) =>
  new ProvingEngine({
    checker,
    capabilities: async () => ({ ready: false }),
    knowledge: async () => ({ entries: [] }),
    specialistAvailable: async () => ({ ready: true }),
    specialist: async (c) => ({
      proof: "by rfl",
      mode: "proof",
      targetHash: c.targetHash,
      route: "independent",
    }),
  });
test("specialist success is a candidate until independent checker accepts", async () => {
  let checks = 0;
  const r = await setup(async (c, p, o) => {
    checks++;
    return {
      status: "not_verified",
      targetHash: c.targetHash,
      mode: o.mode,
      reason: "actual kernel rejection",
    };
  }).prove(contract, { budget: { maxModelCalls: 1 } });
  assert.equal(checks, 1);
  assert.notEqual(r.report.stopReason, "verified");
  assert.equal(r.check.status, "not_verified");
});
test("accepted candidate records the immutable target and independent route", async () => {
  const r = await setup(async (c, p, o) => ({
    status: "verified",
    targetHash: c.targetHash,
    mode: o.mode,
  })).prove(contract, { budget: { maxModelCalls: 1 } });
  assert.equal(r.report.stopReason, "verified");
  assert.equal(r.report.targetHash, contract.targetHash);
  assert.equal(r.report.originalProofCoverage, "not_established");
  assert.equal(r.report.modelCalls, 1);
});

test("existing auxiliary proof is independently checked before any search or model call", async () => {
  const engine = setup(async (c, _proof, o) => ({
    status: "verified",
    targetHash: c.targetHash,
    mode: o.mode,
  }));
  engine.capabilities = async () => {
    throw Error("search not needed");
  };
  const result = await engine.prove(contract, {
    initialCandidate: { proof: "by rfl", mode: "proof" },
  });
  assert.equal(result.report.stopReason, "verified");
  assert.equal(result.report.modelCalls, 0);
  assert.equal(result.report.attempts.length, 1);
});
test("model budget is reserved before invocation and shared parent refusal stops calls", async () => {
  let calls = 0;
  const p = setup(async () => {
    throw Error("must not check");
  });
  p.specialist = async () => {
    calls++;
  };
  const r = await p.prove(contract, {
    budget: { maxModelCalls: 1 },
    reserveModel: async () => {
      throw Error("parent exhausted");
    },
  });
  assert.equal(calls, 0);
  assert.equal(r.report.stopReason, "execution_error");
});
test("zero model and tactic budgets execute neither model nor search", async () => {
  let calls = 0;
  const p = setup(async () => {
    calls++;
  });
  p.capabilities = async () => ({ ready: true });
  p.sessionFactory = () => {
    calls++;
    throw Error("unexpected");
  };
  const r = await p.prove(contract, {
    budget: { maxModelCalls: 0, maxTacticSteps: 0 },
  });
  assert.equal(calls, 0);
  assert.equal(r.report.modelCalls, 0);
  assert.equal(r.report.tacticSteps, 0);
});
test("mismatched checker identity cannot escape as a verified result", async () => {
  const r = await setup(async () => ({
    status: "verified",
    targetHash: sha256("wrong"),
    mode: "proof",
  })).prove(contract, { budget: { maxModelCalls: 1 } });
  assert.equal(r.check.status, "tool_unavailable");
  assert.notEqual(r.report.stopReason, "verified");
});

test("unavailable verification environment stops generation rather than treating it as a proof error", async () => {
  const result = await setup(async (c, proof, o) => ({
    status: "tool_unavailable",
    targetHash: c.targetHash,
    mode: o.mode,
    reason: "trusted environment unavailable",
  })).prove(contract);
  assert.equal(result.report.modelCalls, 1);
  assert.equal(result.report.stopReason, "environment");
});
test("counterexample direction is frozen throughout generation and checking", async () => {
  const p = setup(async (c, proof, o) => ({
    status: "verified",
    targetHash: c.targetHash,
    mode: o.mode,
  }));
  p.specialist = async (c, o) => {
    assert.equal(o.mode, "counterexample");
    return { proof: "by rfl", mode: o.mode };
  };
  const r = await p.prove(contract, {
    mode: "counterexample",
    budget: { maxModelCalls: 1 },
  });
  assert.equal(r.report.mode, "counterexample");
  assert.equal(r.check.mode, "counterexample");
});
test("configured model output cap cannot exceed the per-call proving budget", async () => {
  const p = setup(async (c, proof, o) => ({
    status: "verified",
    targetHash: c.targetHash,
    mode: o.mode,
  }));
  p.specialistAvailable = async () => ({ ready: false });
  p.model = async (config, request) => {
    assert.equal(config.maxOutputTokens, 128);
    assert.equal(request.maxTokens, 128);
    return {
      parsed: { proof: "by rfl", mode: "proof" },
      record: { fixture: true },
    };
  };
  const r = await p.prove(contract, {
    config: { model: "fixture", maxOutputTokens: 262144 },
    budget: { maxModelCalls: 1, perCallCompletionTokens: 128 },
  });
  assert.equal(r.report.stopReason, "verified");
});

test("unknown remote outcomes stop the proving loop without a repair request", async () => {
  let calls = 0;
  const p = setup(async () => {
    throw Error("must not check");
  });
  p.specialistAvailable = async () => ({ ready: false });
  p.model = async () => {
    calls++;
    const error = Error("connection lost after sending");
    error.modelRecord = { error: { code: "model_transport_error" } };
    throw error;
  };
  const result = await p.prove(contract, { config: { model: "fixture" } });
  assert.equal(calls, 1);
  assert.equal(result.report.stopReason, "external_outcome_unknown");
  assert.equal(result.check, null);
});

test("explicit output truncation is a known budget failure, not an unknown request", async () => {
  const p = setup(async () => {
    throw Error("must not check");
  });
  p.specialistAvailable = async () => ({ ready: false });
  p.model = async () => {
    const error = Error("truncated");
    error.modelRecord = {
      finishReason: "length",
      error: { code: "model_incomplete" },
    };
    throw error;
  };
  const result = await p.prove(contract, {
    config: { model: "fixture" },
    budget: { maxDecompositionPlans: 0 },
  });
  assert.equal(result.report.modelCalls, 1);
  assert.equal(result.report.stopReason, "model_output_budget");
});

test("configured model is tried before the optional local specialist", async () => {
  let specialistCalls = 0;
  const p = setup(async (c, proof, o) => ({
    status: "verified",
    targetHash: c.targetHash,
    mode: o.mode,
  }));
  p.specialist = async () => {
    specialistCalls++;
    throw Error("not needed");
  };
  p.model = async () => ({
    parsed: { proof: "by rfl", mode: "proof" },
    record: {},
  });
  const result = await p.prove(contract, { config: { model: "fixture" } });
  assert.equal(specialistCalls, 0);
  assert.equal(result.report.stopReason, "verified");
});

test("search feature switch retains the legacy route without touching archived runs", async () => {
  const { createApp } = await import("../server/index.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "lemma-search-switch-"));
  const app = await createApp({
    dataRoot: directory,
    configProvider: async () => null,
    provingOptions: { enabled: false },
  });
  try {
    assert.equal(app.pipeline.prover, null);
  } finally {
    await app.adaptive.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent claims release live sessions and resume checkpoints before tactic repair", async () => {
  let active = 0,
    peak = 0;
  const makeEngine = () => {
    const sessions = [];
    const p = setup(async (c, proof, o) => ({
      status: "verified",
      targetHash: c.targetHash,
      mode: o.mode,
    }));
    p.capabilities = async () => ({ ready: true });
    p.specialistAvailable = async () => ({ ready: false });
    p.sessionFactory = () => {
      const s = {
        closed: false,
        initialState: 0,
        async create() {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 2));
          return { status: "ready" };
        },
        async close() {
          if (!this.closed) active--;
          this.closed = true;
        },
        checkpoint() {
          return { checkpointHash: "test-checkpoint" };
        },
        async resume(cp) {
          assert.equal(cp.checkpointHash, "test-checkpoint");
          return { status: "ready" };
        },
        async queryPremises() {
          return { entries: [] };
        },
        async runSearch() {
          return { completed: false };
        },
        async rollback() {},
        async inspectGoal() {
          return { state: 0, goals: ["⊢ 1 = 1"] };
        },
        async applyTactic() {
          return { completed: true };
        },
        exportCandidate() {
          return { proof: "by rfl", mode: "proof" };
        },
      };
      sessions.push(s);
      return s;
    };
    p.model = async (_config, request) => {
      if (request.role === "R09") {
        assert.ok(
          sessions.every((s) => s.closed),
          "idle REPL must be closed during whole-file generation",
        );
        return { parsed: { unavailable: "use tactic repair" }, record: {} };
      }
      return { parsed: { tactics: ["rfl"] }, record: {} };
    };
    return p;
  };
  const results = await Promise.all(
    [makeEngine(), makeEngine()].map((p) =>
      p.prove(contract, {
        config: { model: "fixture" },
        budget: { maxModelCalls: 2 },
      }),
    ),
  );
  assert.equal(peak, 1);
  assert.equal(active, 0);
  for (const r of results) {
    assert.equal(r.report.stopReason, "verified");
    assert.equal(r.report.resumptions, 1);
    assert.equal(r.report.restarts, 0);
  }
});

test("missing declarations trigger bounded live and pinned-source lookup without changing the target", async () => {
  const original = JSON.stringify(contract);
  let lookedUp = false,
    repaired = false;
  const p = setup(async (c, proof, o) => ({
    status: proof.includes("Missing") ? "not_verified" : "verified",
    stdout: "Unknown constant `Fake.Missing`",
    targetHash: c.targetHash,
    mode: o.mode,
  }));
  p.capabilities = async () => ({ ready: true });
  p.specialistAvailable = async () => ({ ready: false });
  p.sourceSearch = async (queries) => {
    assert.deepEqual(queries, ["Fake.Missing", "Missing"]);
    return {
      matches: [
        { module: "Mathlib.New.Module", snippet: "theorem Missing : True" },
      ],
    };
  };
  p.sessionFactory = () => ({
    closed: false,
    initialState: 0,
    environmentHash: "fixed",
    async create() {
      return { status: "ready" };
    },
    async close() {
      this.closed = true;
    },
    checkpoint() {
      return { checkpointHash: "checkpoint" };
    },
    async resume() {
      return { status: "ready" };
    },
    async rollback() {},
    async runSearch() {
      return { completed: false };
    },
    async queryPremises(queries) {
      if (queries.includes("Fake.Missing")) lookedUp = true;
      return {
        status: "resolved",
        entries: [{ name: "Nat.add_zero", signature: "∀ n : Nat, n + 0 = n" }],
      };
    },
    async inspectGoal() {
      return { state: 0, goals: ["⊢ 1 = 1"] };
    },
    async applyTactic() {
      repaired = true;
      return { completed: true };
    },
    exportCandidate() {
      return { proof: "by rfl", mode: "proof" };
    },
  });
  p.model = async (_config, request) => {
    if (request.role === "R09")
      return {
        parsed: { mode: "proof", proof: "by exact Fake.Missing" },
        record: {},
      };
    assert.equal(lookedUp, true);
    assert.equal(
      request.input.declarationLookup.sourceCandidates[0]
        .availableInCurrentEnvironment,
      "not_established",
    );
    return { parsed: { tactics: ["rfl"] }, record: {} };
  };
  const result = await p.prove(contract, {
    config: { model: "fixture" },
    budget: { maxModelCalls: 2 },
  });
  assert.equal(repaired, true);
  assert.equal(result.report.stopReason, "verified");
  assert.equal(
    result.report.environmentSuggestions[0].matches[0].requiresNewContract,
    true,
  );
  assert.equal(JSON.stringify(contract), original);
});

test("a confirmed missing import yields to domain recovery before spending a large generation budget", async () => {
  let generations = 0,
    specialists = 0;
  const p = setup(async (c, _proof, o) => ({
    status: "not_verified",
    stdout: "Unknown constant `IsCompact.tendsto_subseq`",
    targetHash: c.targetHash,
    mode: o.mode,
  }));
  p.capabilities = async () => ({ ready: true });
  p.specialistAvailable = async () => ({ ready: true });
  p.specialist = async () => {
    specialists++;
    throw Error("must recover imports first");
  };
  p.model = async () => {
    generations++;
    return {
      parsed: { mode: "proof", proof: "by exact IsCompact.tendsto_subseq" },
      record: {},
    };
  };
  p.sourceSearch = async () => ({
    matches: [
      {
        name: "IsCompact.tendsto_subseq",
        module: "Mathlib.Topology.Sequences",
        snippet: "theorem IsCompact.tendsto_subseq",
      },
    ],
  });
  p.sessionFactory = () => ({
    closed: false,
    initialState: 0,
    environmentHash: "fixed",
    create: async () => ({ status: "ready" }),
    resume: async () => ({ status: "ready" }),
    async close() {
      this.closed = true;
    },
    checkpoint: () => ({ checkpointHash: "fixed" }),
    runSearch: async () => ({ completed: false }),
    rollback: async () => {},
    queryPremises: async () => ({ status: "resolved", entries: [] }),
  });
  const result = await p.prove(contract, {
    config: { model: "fixture" },
    budget: { maxModelCalls: 256, maxDecompositionPlans: 0 },
  });
  assert.equal(result.report.stopReason, "environment_extension_required");
  assert.equal(generations, 1);
  assert.equal(specialists, 0);
  assert.equal(
    result.report.environmentSuggestions[0].matches[0].module,
    "Mathlib.Topology.Sequences",
  );
  assert.deepEqual(contract.imports, ["Std"]);
});
