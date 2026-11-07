import test from "node:test";
import { fixtureTargetStructure } from "./source-audit-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { EvidenceStore, digest } from "../server/evidence.mjs";
import {
  validateDomainPlan,
  dependencyContext,
  preserveDomainPlan,
} from "../server/domain-schema.mjs";
import { inspectReviewEvidence } from "../server/review-evidence.mjs";
import { inspectDomainEvidence } from "../server/domain-evidence.mjs";
import { reusableIdentity } from "../server/knowledge.mjs";
import { ProvingEngine } from "../server/proving-engine.mjs";
import { freshProofSession } from "../server/proof-autonomy.mjs";
import { immutableProposal } from "../server/domain-recovery.mjs";
import {
  plan,
  input,
  settled,
  approval,
  fixtureModel,
  quote,
  proposal,
} from "./domain-recovery-helpers.mjs";
const context = { pages: [{ pageIndex: 0, text: quote }], supplements: [] };
test("domain bootstrap cannot replace a selected theorem with another theorem on the same page", () => {
  const source = { text: quote + " Another theorem: zero equals zero." };
  assert.doesNotThrow(() => immutableProposal(proposal, null, source, quote));
  assert.throws(
    () =>
      immutableProposal(
        {
          ...proposal,
          quote: "Another theorem: zero equals zero.",
          leanTarget: "0=0",
        },
        null,
        source,
        quote,
      ),
    /论证范围/,
  );
});
test("supplement versions preserve existing definitions and proven lemma dependencies", () => {
  const prior = plan();
  prior.modules = [];
  const value = preserveDomainPlan(prior, {
    queries: [],
    modules: [],
    definitions: [],
    lemmas: [],
  });
  assert.deepEqual(value.definitions, prior.definitions);
  assert.deepEqual(value.lemmas, prior.lemmas);
  value.definitions[0].value = "fun n => n";
  assert.notEqual(value.definitions[0].value, prior.definitions[0].value);
  assert.throws(() => preserveDomainPlan(prior, value), /不能.*重新定义/);
});
async function harness(action, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-domain-unit-"));
  const p = new ReviewPipeline({
    store: new EvidenceStore(root),
    getConfig: async () => ({ model: "controlled_fixture" }),
    model: fixtureModel,
    targetChecker: async (c) => ({
      status: "well_typed",
      targetHash: c.targetHash,
      targetStructure: fixtureTargetStructure(c),
    }),
    checker: async (c, proof) => ({
      status: proof === "by rfl" ? "not_verified" : "verified",
      targetHash: c.targetHash,
      mode: "proof",
      exitCode: proof === "by rfl" ? 1 : 0,
      axioms: [],
      failureKind: "proof_rejected",
      stdout: proof === "by rfl" ? "unsolved goals" : "",
    }),
    ...overrides,
  });
  try {
    await p.init();
    await action(p);
  } finally {
    for (const c of p.active.values()) c.abort();
    while (p.active.size) await new Promise((r) => setTimeout(r, 10));
    await rm(root, { recursive: true, force: true });
  }
}
test("domain schema rejects fabricated anchors, commands, circular/unknown dependencies and path traversal", () => {
  for (const mutate of [
    (p) => p.modules.push("../../evil"),
    (p) => (p.definitions[0].anchors[0].quote = "invented"),
    (p) => (p.definitions[0].value = "by sorry"),
    (p) => (p.definitions[0].dependsOn = ["ShiftZero"]),
    (p) => p.lemmas[0].dependsOn.push("ShiftTwice"),
    (p) => p.lemmas[0].dependsOn.push("Missing"),
    (p) => (p.leanTarget = "True"),
    (p) => (p.lemmas[0].target = "axiom bad : False"),
  ]) {
    const value = plan();
    mutate(value);
    assert.throws(() => validateDomainPlan(value, context));
  }
  const p = validateDomainPlan(plan(), context);
  assert.deepEqual(
    dependencyContext(p, { dependsOn: ["ShiftZero"] }).lemmas.map(
      (l) => l.name,
    ),
    ["ShiftZero"],
  );
});
test("domain recovery preserves the original autonomous proof session", async () => {
  await harness(async (p) => {
    const previous = await settled(p, (await p.start(await input())).id);
    previous.autonomy = freshProofSession();
    await p.store.saveRun(previous);
    const next = await settled(
      p,
      (await p.recoverDomain(previous.id, { mode: "manual", plan: plan() })).id,
    );
    assert.deepEqual(next.autonomy, previous.autonomy);
    assert.equal(
      (await p.store.getRun(previous.id)).autonomy.sessionId,
      previous.autonomy.sessionId,
    );
  });
});
test("domain completion creates fresh approval, immutable old target and replayable component evidence", async () => {
  await harness(async (p) => {
    const previous = await settled(p, (await p.start(await input())).id);
    const before = digest(previous);
    const r = await settled(
      p,
      (await p.recoverDomain(previous.id, { mode: "manual", plan: plan() })).id,
    );
    assert.equal(r.status, "awaiting_confirmation", r.error);
    assert.equal(r.contract.schemaVersion, "lemma.contract.v4");
    assert.equal(r.contract.leanTarget, previous.contract.leanTarget);
    assert.notEqual(r.contract.targetHash, previous.contract.targetHash);
    assert.equal(r.approval, null);
    assert.equal(digest(await p.store.getRun(previous.id)), before);
    assert.notEqual(
      reusableIdentity(r.contract),
      reusableIdentity(previous.contract),
    );
    assert.ok(
      r.semanticReview.issues.some(
        (i) => i.code === "domain_definition_fidelity",
      ),
    );
    await assert.rejects(
      p.approve(r.id, {
        ...approval(r),
        targetHash: previous.contract.targetHash,
      }),
    );
    await p.approve(r.id, approval(r));
    const done = await settled(p, r.id);
    assert.equal(done.conclusion.theorem, "formalized_proved", done.error);
    const bundle = await p.store.bundle(done.root);
    assert.equal(inspectReviewEvidence(bundle).domainChecks.length, 3);
    assert.equal((await p.replay(bundle, bundle.root)).domainChecks.length, 3);
    const altered = structuredClone(bundle);
    altered.artifacts.find(
      (a) => a.kind === "domain_completion",
    ).payload.context.definitions[0].value = "fun n => n + 1";
    assert.throws(() => inspectReviewEvidence(altered));
  });
});

test("a fourth domain repair remains replayable after the attempt budget is enlarged", async () => {
  let checks = 0,
    repairs = 0;
  const proofs = [
    "by intro n; simpa using (Nat.add_zero n)",
    "by intro n; exact Nat.add_zero n",
    "by intro n; exact rfl",
  ];
  await harness(
    async (p) => {
      const start = await input();
      start.proposal.alignment = [
        "variables",
        "quantifiers",
        "domain",
        "assumptions",
        "conclusion",
        "definitions",
      ].map((category) => ({
        category,
        explanation: "Controlled fixture alignment",
        leanFragment: "n",
        anchors: [{ pageIndex: 0, quote }],
      }));
      const previous = await settled(p, (await p.start(start)).id);
      const recovered = await settled(
        p,
        (await p.recoverDomain(previous.id, { mode: "model", plan: plan() }))
          .id,
      );
      assert.equal(recovered.status, "awaiting_confirmation", recovered.error);
      assert.equal(
        recovered.domainRecovery.components.find((c) => c.name === "ShiftZero")
          .attempts.length,
        4,
      );
      const bundle = await p.store.bundle(recovered.contractArtifact);
      const artifacts = new Map(bundle.artifacts.map((a) => [a.id, a]));
      assert.equal(
        inspectDomainEvidence(
          recovered.contract,
          artifacts,
          recovered.semanticReview,
        ).length,
        3,
      );
    },
    {
      model: async (config, request) =>
        request.role === "RDLP"
          ? {
              parsed: { proof: proofs[repairs++] },
              record: { provider: "controlled_fixture_no_live_model" },
            }
          : fixtureModel(config, request),
      checker: async (c) => {
        const reject =
          c.domainContext &&
          !c.domainContext.lemmas.length &&
          c.leanTarget.includes("LemmaPaper.Shift n = n") &&
          ++checks < 4;
        return {
          status: reject ? "not_verified" : "verified",
          mode: "proof",
          targetHash: c.targetHash,
          exitCode: reject ? 1 : 0,
          axioms: [],
          stdout: reject ? "unsolved goals (controlled fixture)" : "",
        };
      },
    },
  );
});

test("auxiliary lemmas use the shared prover, verified dependencies and an independent final replay", async () => {
  await harness(async (p) => {
    const start = await input();
    start.proposal.alignment = [
      "variables",
      "quantifiers",
      "domain",
      "assumptions",
      "conclusion",
      "definitions",
    ].map((category) => ({
      category,
      explanation: "Fixture alignment",
      leanFragment: "n",
      anchors: [{ pageIndex: 0, quote }],
    }));
    const old = await settled(p, (await p.start(start)).id);
    let generated = 0;
    p.prover = new ProvingEngine({
      checker: p.checker,
      knowledge: async () => ({ entries: [] }),
      capabilities: async () => ({ ready: false }),
      specialistAvailable: async () => ({ ready: false }),
      model: async (_config, request) => {
        generated++;
        if (generated === 2)
          assert.ok(
            request.input.contract.domainContext.lemmas.some(
              (l) => l.name === "ShiftZero",
            ),
          );
        return {
          parsed: { proof: "by intro n; rfl", mode: "proof" },
          record: { provider: "controlled-prover-fixture" },
        };
      },
    });
    const v = plan();
    for (const lemma of v.lemmas) delete lemma.proof;
    const run = await settled(
      p,
      (await p.recoverDomain(old.id, { mode: "model", plan: v })).id,
    );
    assert.equal(run.status, "awaiting_confirmation", run.error);
    assert.equal(generated, 2);
    assert.ok(
      run.domainRecovery.components
        .filter((c) => c.kind === "lemma")
        .every(
          (c) =>
            c.provingSearch.stopReason === "verified" &&
            c.searchArtifact &&
            c.finalArtifact,
        ),
    );
    assert.equal(run.approval, null);
    assert.equal(run.contract.leanTarget, old.contract.leanTarget);
  });
});

test("unknown outcome in the shared auxiliary prover remains blocked without inherited approval", async () => {
  await harness(async (p) => {
    const old = await settled(p, (await p.start(await input())).id);
    p.prover = {
      prove: async (contract) => ({
        candidate: null,
        check: null,
        report: {
          targetHash: contract.targetHash,
          stopReason: "external_outcome_unknown",
        },
      }),
    };
    const run = await settled(
      p,
      (await p.recoverDomain(old.id, { mode: "model", plan: plan() })).id,
    );
    assert.equal(run.status, "blocked");
    assert.equal(run.domainRecovery.externalOutcomeUnknown, true);
    assert.equal(run.approval, null);
    assert.equal(run.contract, null);
  });
});
test("a recovered candidate can pass in a new environment without promoting the unapproved target", async () => {
  await harness(async (p) => {
    const start = await input();
    start.proposal.alignment = [
      "variables",
      "quantifiers",
      "domain",
      "assumptions",
      "conclusion",
      "definitions",
    ].map((category) => ({
      category,
      explanation: "Controlled fixture",
      leanFragment: "n",
      anchors: [{ pageIndex: 0, quote }],
    }));
    const old = await settled(p, (await p.start(start)).id);
    old.proofArtifact = await p.store.put(
      "proof_candidate",
      {
        mode: "proof",
        proof: "by intro n; rfl",
      },
      [old.contractArtifact],
    );
    old.approval = { confirmed: true, targetHash: old.contract.targetHash };
    await p.store.saveRun(old);
    const before = digest(old);
    p.prover = new ProvingEngine({ checker: p.checker });
    const run = await settled(
      p,
      (await p.recoverDomain(old.id, { mode: "model", plan: plan() })).id,
    );
    assert.equal(run.status, "awaiting_confirmation", run.error);
    assert.equal(
      run.domainRecovery.preview.status,
      "candidate_verified_pending_confirmation",
    );
    assert.equal(run.domainRecovery.preview.result.report.modelCalls, 0);
    assert.equal(run.seedProof.origin, "previous_unverified_candidate");
    const previewNode = run.tasks.find((t) => t.role === "RDPC");
    assert.equal(previewNode.agent, "Lean 核验器");
    assert.match(previewNode.reason, /不自动批准/);
    assert.equal(run.approval, null);
    assert.equal(run.check, null);
    assert.equal(run.conclusion, null);
    assert.notEqual(run.contract.targetHash, old.contract.targetHash);
    assert.equal(run.contract.leanTarget, old.contract.leanTarget);
    assert.equal(digest(await p.store.getRun(old.id)), before);
    assert.ok(
      (await p.store.bundle(run.root)).artifacts.some(
        (a) => a.id === run.seedArtifact,
      ),
    );
  });
});
test("received invalid supplement plans are repaired with the exact error while unknown requests are not replayed", async () => {
  for (const unknown of [false, true])
    await harness(async (p) => {
      const start = await input();
      start.proposal.alignment = [
        "variables",
        "quantifiers",
        "domain",
        "assumptions",
        "conclusion",
        "definitions",
      ].map((category) => ({
        category,
        explanation: "Controlled fixture",
        leanFragment: "n",
        anchors: [{ pageIndex: 0, quote }],
      }));
      const old = await settled(p, (await p.start(start)).id);
      let calls = 0;
      p.model = async (config, request) => {
        if (request.role === "RDQ")
          return { parsed: { queries: [] }, record: { provider: "fixture" } };
        if (request.role !== "RDP") return fixtureModel(config, request);
        calls++;
        if (unknown)
          throw Object.assign(Error("external outcome unknown"), {
            modelRecord: { outcome: "unknown" },
          });
        const value = plan();
        if (calls === 1) value.lemmas[0].name = "LemmaPaper.ShiftZero";
        else {
          assert.match(
            request.input.validationFeedback.validationError,
            /短名|大写字母/,
          );
          assert.equal(
            request.input.validationFeedback.invalidPlan.lemmas[0].name,
            "LemmaPaper.ShiftZero",
          );
        }
        return { parsed: value, record: { provider: "fixture" } };
      };
      const run = await settled(
        p,
        (await p.recoverDomain(old.id, { mode: "model" })).id,
      );
      assert.equal(calls, unknown ? 1 : 2);
      assert.equal(
        run.status,
        unknown ? "blocked" : "awaiting_confirmation",
        run.error,
      );
      assert.equal(run.approval, null);
      if (!unknown) {
        const attempts = run.tasks.filter((t) => t.role === "RDP");
        assert.equal(attempts[0].status, "blocked");
        assert.ok(attempts[1].inputs.includes(attempts[0].output));
        const failed = (await p.store.get(attempts[0].output)).payload;
        assert.equal(
          failed.domain.invalidPlan.lemmas[0].name,
          "LemmaPaper.ShiftZero",
        );
      }
    });
});
test("failed helper blocks dependent lemmas and main target; no fabricated verification", async () => {
  await harness(async (p) => {
    const old = await settled(p, (await p.start(await input())).id);
    const v = plan();
    v.lemmas[0].proof = "by rfl";
    const r = await settled(
      p,
      (await p.recoverDomain(old.id, { mode: "manual", plan: v })).id,
    );
    assert.equal(r.status, "blocked");
    assert.equal(r.contract, null);
    assert.equal(r.domainRecovery.components.length, 2);
    assert.equal(r.domainRecovery.components[1].status, "blocked");
    assert.equal(r.pendingObligations[0].type, "proof_step");
    assert.equal(r.tasks.filter((t) => t.role === "R05").length, 0);
    assert.ok(
      (await p.store.bundle(r.root)).artifacts.some(
        (a) => a.kind === "task:RDLC",
      ),
    );
  });
});
test("controlled model repairs helper with compiler feedback and does not change helper target", async () => {
  const calls = [];
  await harness(
    async (p) => {
      const start = await input();
      start.proposal.alignment = [
        "variables",
        "quantifiers",
        "domain",
        "assumptions",
        "conclusion",
        "definitions",
      ].map((category) => ({
        category,
        explanation: "Controlled fixture.",
        leanFragment: "n",
        anchors: [{ pageIndex: 0, quote }],
      }));
      const old = await settled(p, (await p.start(start)).id);
      const v = plan();
      v.lemmas[0].proof = "by rfl";
      v.lemmas = v.lemmas.slice(0, 1);
      const r = await settled(
        p,
        (await p.recoverDomain(old.id, { mode: "model", plan: v })).id,
      );
      assert.equal(r.status, "awaiting_confirmation", r.error);
      assert.equal(r.domainRecovery.components[1].attempts.length, 2);
      assert.match(
        calls.find((c) => c.role === "RDLP").input.previous.diagnostic.message,
        /unsolved goals/,
      );
      assert.equal(
        r.contract.domainContext.lemmas[0].target,
        v.lemmas[0].target,
      );
    },
    {
      model: async (config, req) => {
        calls.push(req);
        return fixtureModel(config, req);
      },
    },
  );
});
test("recovery rejects target replacement and cancellation is not a math failure", async () => {
  await harness(async (p) => {
    const old = await settled(p, (await p.start(await input())).id);
    const v = plan();
    v.proposal = { ...old.contract, leanTarget: "True" };
    await assert.rejects(
      p.recoverDomain(old.id, { mode: "manual", plan: v }),
      /不能修改/,
    );
    const r = await p.recoverDomain(old.id, { mode: "manual", plan: plan() });
    await p.cancel(r.id);
    const done = await settled(p, r.id);
    assert.equal(done.status, "cancelled");
    assert.equal(done.check, null);
    assert.equal(done.approval, null);
  });
});

test("automatic planner recovers a missing translation through the real adapter with controlled HTTP responses", async () => {
  const { callModel } = await import("../server/model.mjs");
  const calls = [];
  const model = async (config, req) => {
    calls.push(req);
    let parsed;
    if (req.role === "R03")
      parsed = {
        unavailable: "The paper-specific Shift definition is not available.",
      };
    else if (req.role === "RDQ") parsed = { queries: [] };
    else if (req.role === "RDP") {
      parsed = plan();
      parsed.proposal = (await input()).proposal;
      parsed.proposal.alignment = [
        "variables",
        "quantifiers",
        "domain",
        "assumptions",
        "conclusion",
        "definitions",
      ].map((category) => ({
        category,
        explanation: "Controlled fixture alignment.",
        leanFragment: "n",
        anchors: [{ pageIndex: 0, quote }],
      }));
    } else parsed = (await fixtureModel(config, req)).parsed;
    return callModel(
      {
        endpoint: "http://127.0.0.1:1/controlled-only",
        model: "controlled-http-fixture",
        key: "fixture-not-a-secret",
        timeoutMs: 1000,
      },
      {
        ...req,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  message: { content: JSON.stringify(parsed) },
                },
              ],
            }),
            { status: 200 },
          ),
      },
    );
  };
  await harness(
    async (p) => {
      const old = await settled(
        p,
        (await p.start({ ...(await input()), mode: "model" })).id,
      );
      assert.equal(old.status, "blocked");
      assert.equal(old.contract, null);
      const r = await settled(
        p,
        (await p.recoverDomain(old.id, { mode: "model" })).id,
      );
      assert.equal(r.status, "awaiting_confirmation", r.error);
      for (const role of ["RDQ", "RDP", "RDDR", "R04"])
        assert.ok(calls.some((c) => c.role === role));
      assert.equal(r.domainRecovery.components.length, 3);
      assert.equal(r.approval, null);
    },
    { model },
  );
});

test("model cannot change helper target during repair and repeated candidates stop within budget", async () => {
  for (const mutated of [true, false])
    await harness(
      async (p) => {
        const old = await settled(p, (await p.start(await input())).id);
        const v = plan();
        v.lemmas[0].proof = "by rfl";
        const r = await settled(
          p,
          (await p.recoverDomain(old.id, { mode: "model", plan: v })).id,
        );
        assert.equal(r.status, "blocked");
        assert.equal(r.contract, null);
        assert.ok(r.domainRecovery.modelCalls <= 3);
        assert.equal(r.domainRecovery.components[1].attempts.length, 1);
        assert.equal(r.check, null);
      },
      {
        model: async (config, req) =>
          req.role === "RDLP"
            ? {
                parsed: mutated
                  ? { target: "True", proof: "by trivial" }
                  : { proof: "by rfl" },
                record: { provider: "controlled_fixture" },
              }
            : fixtureModel(config, req),
      },
    );
});

test("cache extension refuses overwrite/removal, and library search rejects command-like inputs", async () => {
  const { assertCacheExtension, searchMathlib, moduleManifest } =
    await import("../server/domain-library.mjs");
  const old = [{ path: "A.olean", sha256: "a" }];
  assert.doesNotThrow(() =>
    assertCacheExtension(old, [...old, { path: "B.olean", sha256: "b" }]),
  );
  assert.throws(() =>
    assertCacheExtension(old, [{ path: "A.olean", sha256: "changed" }]),
  );
  assert.throws(() => assertCacheExtension(old, []));
  await assert.rejects(searchMathlib(["bad\nquery"]));
  await assert.rejects(moduleManifest(["../../Bad"]));
});

test("cancelling a definition check marks its unfinished component cancelled rather than still running", async () => {
  let reached;
  const inside = new Promise((resolve) => {
    reached = resolve;
  });
  await harness(
    async (p) => {
      const old = await settled(p, (await p.start(await input())).id);
      const run = await p.recoverDomain(old.id, {
        mode: "manual",
        plan: plan(),
      });
      await inside;
      await p.cancel(run.id);
      const done = await settled(p, run.id);
      assert.equal(done.status, "cancelled");
      assert.equal(done.domainRecovery.components[0].status, "cancelled");
      assert.equal(done.approval, null);
      assert.equal(done.contract, null);
    },
    {
      targetChecker: async (c, { signal }) => {
        if (!c.domainContext)
          return { status: "well_typed", targetHash: c.targetHash };
        reached();
        return new Promise((resolve, reject) => {
          if (signal.aborted) reject(new Error("cancelled fixture"));
          else
            signal.addEventListener(
              "abort",
              () => reject(new Error("cancelled fixture")),
              { once: true },
            );
        });
      },
    },
  );
});

test("library result budget preserves later concepts and prefers declarations over references", async () => {
  const { selectSearchCandidates } =
    await import("../server/domain-library.mjs");
  const broad = Array.from({ length: 100 }, (_, i) => ({
    file: `Mathlib/Broad${i}.lean`,
    line: 1,
    snippet: "UniformContinuous f",
  }));
  const definition = {
    file: "Mathlib/Convex.lean",
    line: 54,
    snippet: "def ConvexOn : Prop :=",
  };
  const result = selectSearchCandidates(
    [
      { query: "UniformContinuous", candidates: broad },
      {
        query: "ConvexOn",
        candidates: [
          ...Array.from({ length: 20 }, (_, i) => ({
            file: definition.file,
            line: i + 1,
            snippet: "-- ConvexOn reference",
          })),
          definition,
        ],
      },
    ],
    4,
  );
  assert.equal(result.selected.length, 4);
  assert.deepEqual(result.selected[1], definition);
  assert.ok(result.queryCoverage.every((q) => q.returned > 0));
  assert.equal(result.truncated, true);
});

test("library selection deduplicates shared hits without wasting another query's slot", async () => {
  const { selectSearchCandidates } =
    await import("../server/domain-library.mjs");
  const shared = {
    file: "Mathlib/A.lean",
    line: 1,
    snippet: "def _root_.AbsolutelyContinuousOnInterval :=",
  };
  const later = {
    file: "Mathlib/B.lean",
    line: 2,
    snippet: "def ConcaveOn :=",
  };
  const result = selectSearchCandidates(
    [
      { query: "AbsolutelyContinuousOnInterval", candidates: [shared] },
      { query: "AbsolutelyContinuous", candidates: [shared] },
      { query: "ConcaveOn", candidates: [later] },
      { query: "Missing", candidates: [] },
    ],
    2,
  );
  assert.deepEqual(result.selected, [shared, later]);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.queryCoverage.map((q) => q.returned),
    [1, 1, 1, 0],
  );
  assert.throws(() => selectSearchCandidates([], 0));
  assert.throws(() => selectSearchCandidates([], 81));
});

test("a nonexistent module is repaired from concrete pinned-source feedback before acquisition", async () => {
  await harness(async (p) => {
    const start = await input();
    start.proposal.alignment = [
      "variables",
      "quantifiers",
      "domain",
      "assumptions",
      "conclusion",
      "definitions",
    ].map((category) => ({
      category,
      explanation: "Controlled source alignment.",
      leanFragment: "n",
      anchors: [{ pageIndex: 0, quote }],
    }));
    const old = await settled(p, (await p.start(start)).id);
    let plans = 0;
    p.model = async (config, request) => {
      if (request.role !== "RDP") return fixtureModel(config, request);
      plans++;
      const next = plan();
      if (plans === 1) next.modules = ["Mathlib.Topology.Order.Interval"];
      else
        assert.match(
          request.input.validationFeedback.validationError,
          /does not exist/,
        );
      return {
        parsed: next,
        record: { testFixture: true, requestId: `module-plan-${plans}` },
      };
    };
    const r = await settled(
      p,
      (await p.recoverDomain(old.id, { mode: "model", queries: ["Shift"] })).id,
    );
    assert.equal(r.status, "awaiting_confirmation", r.error);
    assert.equal(plans, 2);
    const tasks = r.tasks.filter((t) => t.role === "RDP");
    assert.equal(tasks[0].status, "blocked");
    assert.equal(tasks[1].status, "succeeded");
    assert.deepEqual(r.domainRecovery.plan.modules, []);
  });
});
