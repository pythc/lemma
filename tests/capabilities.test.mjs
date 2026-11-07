import {
  sourceAuditFixture,
  fixtureTargetStructure,
} from "./source-audit-fixture.mjs";
import { CONTEXT_RUNTIME } from "../server/runtime-limits.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  EvidenceStore,
  sha256,
  digest,
  inspectBundle,
} from "../server/evidence.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import {
  buildContext,
  supplementsFor,
  anchorInContext,
} from "../server/context.mjs";
import {
  structuralConcerns,
  semanticReview,
  validateResolutions,
  validateAlignment,
  ALIGNMENT_CATEGORIES,
} from "../server/semantics.mjs";
import { createContract, deriveConclusion } from "../server/contracts.mjs";
import { diagnose, REPAIR_BUDGET } from "../server/repair.mjs";
import { inspectReviewEvidence } from "../server/review-evidence.mjs";
import { rankDeclarations } from "../server/knowledge.mjs";

const quote = "For every natural number n, n + 0 = n.";
const proposal = {
  label: "Theorem 1",
  quote,
  statement: "任意自然数右加零不变",
  assumptions: ["n 为自然数"],
  leanTarget: "∀ n : Nat, n + 0 = n",
  ambiguity: "",
};
const typeChecker = async (c) => ({
  status: "well_typed",
  targetHash: c.targetHash,
  reason: "Synthetic type fixture; not real Lean.",
  targetStructure: fixtureTargetStructure(c),
});
const noKnowledge = async (c) => ({
  targetHash: c.targetHash,
  entries: [],
  status: "no_matches",
});
const alignment = () =>
  ALIGNMENT_CATEGORIES.map((category) => ({
    category,
    explanation: "Test fixture alignment only",
    leanFragment: "n",
    anchors: [{ pageIndex: 1, quote }],
  }));
async function input() {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman);
  for (const body of [
    "Notation: n denotes a natural number throughout this paper.",
    quote,
  ])
    pdf.addPage().drawText(body, { x: 30, y: 700, font, size: 11 });
  const bytes = Buffer.from(await pdf.save());
  return {
    pdfBase64: bytes.toString("base64"),
    paperSha256: sha256(bytes),
    pageIndex: 1,
    mode: "model",
    libraryProfile: "std-v1",
  };
}
async function settled(p, id) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (!p.active.has(id)) return p.store.getRun(id);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Test pipeline did not settle");
}
const approve = (r) => ({
  confirmed: true,
  targetHash: r.contract.targetHash,
  semanticArtifact: r.semanticArtifact,
  resolutions: r.semanticReview.issues.map((i) => ({
    issueId: i.id,
    decision: "confirmed_with_reason",
    reason: "Synthetic human attestation for this explicit arithmetic fixture.",
  })),
});
async function harness(
  action,
  { proofs = ["by rfl", "by intro n; rfl"], checks = null, ...overrides } = {},
) {
  const folder = await mkdtemp(
    path.join(os.tmpdir(), "lemma-capability-test-"),
  );
  let calls = 0,
    checksDone = 0;
  const modelInputs = [];
  const p = new ReviewPipeline({
    store: new EvidenceStore(folder),
    getConfig: async () => ({ model: "synthetic-only" }),
    targetChecker: typeChecker,
    knowledge: noKnowledge,
    model: async (_c, request) => {
      modelInputs.push(request);
      let parsed;
      if (request.role === "R03")
        parsed = { ...proposal, alignment: alignment() };
      else if (request.role === "R04")
        parsed = {
          targetHash: request.input.contract.targetHash,
          ...(request.input.context?.semanticProtocol ===
          "lemma.source-audit.v5"
            ? { findings: [] }
            : {}),
          ...(request.input.stage
            ? {}
            : {
                sourceAudit: sourceAuditFixture(
                  request.input.contract,
                  request.input.targetStructure,
                  request.input.context.semanticProtocol,
                ),
              }),
          backTranslation: "每个自然数右加零等于自身。",
          checks: ALIGNMENT_CATEGORIES.map((category) => ({
            category,
            status: "aligned",
            explanation: "Fixture agrees with the arithmetic source.",
            anchors: [{ pageIndex: 1, quote }],
          })),
        };
      else if (request.role === "R06")
        parsed = {
          status: "unchecked",
          quote: "",
          explanation: "No original proof in this fixture.",
        };
      else {
        parsed =
          typeof proofs[calls] === "object"
            ? proofs[calls]
            : {
                proof: proofs[calls] || proofs.at(-1),
                mode: "proof",
                route: "independent",
                explanation: "Synthetic candidate, no real model.",
              };
        calls++;
      }
      return {
        parsed,
        record: { provider: "synthetic-only", role: request.role },
      };
    },
    checker: async (c, proof, options) => {
      const step = checks?.[checksDone++];
      if (step)
        return { targetHash: c.targetHash, mode: options.mode, ...step };
      return {
        targetHash: c.targetHash,
        mode: options.mode,
        status: proof === "by intro n; rfl" ? "verified" : "not_verified",
        exitCode: proof === "by intro n; rfl" ? 0 : 1,
        axioms: [],
        failureKind: "proof_rejected",
        stdout:
          proof === "by intro n; rfl"
            ? ""
            : "unsolved goals\n⊢ ∀ n : Nat, n + 0 = n",
      };
    },
    ...overrides,
  });
  try {
    await p.init();
    await action(p, modelInputs);
  } finally {
    for (const c of p.active.values()) c.abort();
    while (p.active.size)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await rm(folder, { recursive: true, force: true });
  }
}

test("context binds cross-page definitions, supplementary provenance, omissions and exact anchors", () => {
  const paper = {
    paperSha256: "a".repeat(64),
    pages: Array.from({ length: CONTEXT_RUNTIME.pages + 4 }, (_, index) => ({
      index,
      text:
        index === 14
          ? "Definition 3.1 states the domain is compact."
          : index === 4
            ? "Theorem 4 uses Definition 3.1. Every f is continuous."
            : `Page ${index} has unique text.`,
      quality: "text_layer",
    })),
  };
  const context = buildContext(
    paper,
    4,
    supplementsFor([{ name: "source.tex", text: "\\newcommand{\\domain}{K}" }]),
  );
  assert.ok(context.pages.some((p) => p.pageIndex === 14));
  assert.equal(context.pages.length, CONTEXT_RUNTIME.pages);
  assert.equal(context.omittedPages.length, 4);
  assert.equal(
    context.supplements[0].provenance,
    "user_supplied_unverified_source",
  );
  assert.equal(
    anchorInContext(
      { pageIndex: 14, quote: "Definition 3.1 states the domain is compact." },
      context,
    ).sourceTextHash,
    digest(paper.pages[14].text),
  );
  assert.throws(() =>
    anchorInContext({ pageIndex: 14, quote: "invented text" }, context),
  );
  assert.throws(() =>
    supplementsFor([
      {
        name: "big",
        text: "x".repeat(CONTEXT_RUNTIME.supplementCharacters + 1),
      },
    ]),
  );
});

test("five known semantic mutations produce specific concerns while the faithful target stays unflagged", () => {
  const original = {
    quote:
      "A continuous real function on a closed bounded interval is uniformly continuous on that interval.",
    statement: "实数闭区间连续函数一致连续",
    assumptions: [],
    leanTarget:
      "∀ (f : ℝ → ℝ) (a b : ℝ), ContinuousOn f (Set.Icc a b) → UniformContinuousOn f (Set.Icc a b)",
  };
  assert.equal(structuralConcerns(original).length, 0);
  for (const [target, code] of [
    ["True", "trivial_or_false_target"],
    [original.leanTarget.replace("∀", "∃"), "quantifier_changed"],
    [
      original.leanTarget + " → UniformContinuousOn f (Set.Icc a b)",
      "conclusion_as_premise",
    ],
    ["False → (" + original.leanTarget + ")", "inconsistent_premise"],
    [
      "∀ (f : ℝ → ℝ), Continuous f → UniformContinuous f",
      "domain_condition_missing",
    ],
  ])
    assert.ok(
      structuralConcerns({ ...original, leanTarget: target }).some(
        (i) => i.code === code,
      ),
      code,
    );
  assert.equal(
    structuralConcerns({
      ...proposal,
      quote: "There exists a natural number equal to zero.",
      statement: "存在自然数等于零",
      assumptions: [],
      leanTarget: "∃ n : Nat, n = 0",
    }).length,
    0,
  );
});

test("invented alignment, missing categories, duplicate resolutions and invalid types cannot be confirmed", () => {
  const c = createContract(
    {
      paperSha256: "a".repeat(64),
      pageIndex: 1,
      artifact: "b".repeat(64),
      text: quote,
    },
    proposal,
  );
  const context = buildContext(
    {
      paperSha256: c.paperSha256,
      pages: [{ index: 1, text: quote, quality: "text_layer" }],
    },
    1,
  );
  assert.throws(() => validateAlignment(alignment().slice(1), c, context));
  assert.throws(() =>
    validateAlignment(
      alignment().map((a) => ({ ...a, leanFragment: "False" })),
      c,
      context,
    ),
  );
  const r = semanticReview(c, context, [], null, {
    status: "well_typed",
    targetHash: c.targetHash,
  });
  assert.throws(() => validateResolutions({ ...r, targetCheck: null }, []));
  assert.throws(() =>
    validateResolutions(
      {
        ...r,
        issues: [],
        targetCheck: { status: "well_typed", targetHash: "f".repeat(64) },
      },
      [],
    ),
  );
  assert.throws(() => validateResolutions(r, []));
  const decisions = r.issues.map((i) => ({
    issueId: i.id,
    decision: "confirmed_with_reason",
    reason: "Checked the arithmetic statement against the exact source.",
  }));
  assert.equal(validateResolutions(r, decisions).length, 2);
  assert.throws(() => validateResolutions(r, [decisions[0], decisions[0]]));
  assert.throws(() =>
    validateResolutions(
      { ...r, targetCheck: { status: "not_well_typed" } },
      decisions,
    ),
  );
});

test("repair receives compiler diagnostics and library context, keeps the target fixed, and exports every attempt", async () => {
  await harness(async (p, calls) => {
    const r = await settled(p, (await p.start(await input())).id);
    assert.equal(r.status, "awaiting_confirmation", r.error);
    assert.ok(
      calls
        .find((c) => c.role === "R03")
        .input.context.pages.some((page) => page.pageIndex === 0),
    );
    await assert.rejects(
      p.approve(r.id, { ...approve(r), semanticArtifact: "f".repeat(64) }),
      /版本/,
    );
    await p.approve(r.id, approve(r));
    const done = await settled(p, r.id);
    assert.equal(done.conclusion.theorem, "formalized_proved");
    assert.equal(done.conclusion.originalProof, "unverified");
    assert.equal(done.attempts.length, 2);
    assert.equal(new Set(done.attempts.map((a) => a.targetHash)).size, 1);
    const repair = calls.filter((c) => c.role === "R09")[1];
    assert.match(repair.input.previous.diagnostic.message, /unsolved goals/);
    assert.equal(repair.input.previous.proof, "by rfl");
    assert.equal(done.repair.stopReason, "verified");
    const bundle = await p.store.bundle(done.root);
    assert.equal(inspectReviewEvidence(bundle).saved.attempts.length, 2);
    assert.equal(
      deriveConclusion({
        ...done,
        approval: { ...done.approval, semanticArtifact: "f".repeat(64) },
      }).theorem,
      "semantic_review_required",
    );
    assert.equal((await p.replay(bundle, bundle.root)).revalidated, true);
  });
});

test("failed seed proof is attributed to human input, then repaired by the model", async () => {
  await harness(
    async (p, calls) => {
      const r = await settled(
        p,
        (
          await p.start({
            ...(await input()),
            seedProof: { proof: "by rfl", mode: "proof" },
          })
        ).id,
      );
      await p.approve(r.id, approve(r));
      const done = await settled(p, r.id);
      assert.equal(done.attempts.length, 2);
      assert.equal(
        done.tasks.find((t) => t.role === "R09").type,
        "human_input",
      );
      assert.equal(calls.filter((c) => c.role === "R09").length, 1);
      assert.equal(done.conclusion.theorem, "formalized_proved");
    },
    { proofs: ["by intro n; rfl"] },
  );
});

test("duplicate proof stops without a repeated checker and remains unknown", async () => {
  await harness(
    async (p) => {
      const r = await settled(p, (await p.start(await input())).id);
      await p.approve(r.id, approve(r));
      const done = await settled(p, r.id);
      assert.equal(done.repair.stopReason, "repeated_candidate");
      assert.equal(done.tasks.filter((t) => t.role === "R10").length, 1);
      assert.equal(done.conclusion.theorem, "unknown");
      inspectReviewEvidence(await p.store.bundle(done.root));
    },
    { proofs: ["by rfl", "by rfl"] },
  );
});

test("changed assumptions or a switch to the negated target stops a repair", async () => {
  for (const bad of [
    {
      mode: "proof",
      proof: "by trivial",
      route: "independent",
      leanTarget: "True",
    },
    { mode: "counterexample", proof: "by trivial", route: "independent" },
  ])
    await harness(
      async (p) => {
        const r = await settled(p, (await p.start(await input())).id);
        await p.approve(r.id, approve(r));
        const done = await settled(p, r.id);
        assert.equal(done.status, "blocked");
        assert.equal(done.conclusion.theorem, "unknown");
        assert.equal(done.tasks.filter((t) => t.role === "R10").length, 1);
      },
      { proofs: ["by rfl", bad] },
    );
});

test("resource and environment failures stop separately from mathematical failures", async () => {
  for (const result of [
    { status: "tool_unavailable" },
    {
      status: "not_verified",
      termination: "timeout",
      failureKind: "execution_failed",
    },
  ])
    await harness(
      async (p) => {
        const r = await settled(p, (await p.start(await input())).id);
        await p.approve(r.id, approve(r));
        const done = await settled(p, r.id);
        assert.equal(done.attempts.length, 1);
        assert.equal(done.conclusion.theorem, "unknown");
        assert.equal(
          done.repair.stopReason,
          result.status === "tool_unavailable"
            ? "environment"
            : "resource_limit",
        );
      },
      { checks: [result] },
    );
  assert.equal(
    diagnose({
      status: "not_verified",
      failureKind: "proof_rejected",
      stdout: "Type mismatch",
    }).category,
    "type_or_conditions",
  );
});

test("candidate and model budgets bound recovery without promoting partial work", async () => {
  await harness(
    async (p) => {
      const r = await settled(p, (await p.start(await input())).id);
      await p.approve(r.id, approve(r));
      const done = await settled(p, r.id);
      assert.equal(done.repair.stopReason, "candidate_budget");
      assert.equal(done.attempts.length, 1);
      assert.equal(done.conclusion.theorem, "unknown");
    },
    { repairBudget: { ...REPAIR_BUDGET, maxCandidates: 1 } },
  );
  await harness(
    async (p) => {
      const r = await settled(p, (await p.start(await input())).id);
      await p.approve(r.id, approve(r));
      const done = await settled(p, r.id);
      assert.equal(done.repair.stopReason, "model_budget");
      assert.equal(done.repair.modelCalls, 0);
      assert.equal(done.conclusion.theorem, "unknown");
    },
    { repairBudget: { ...REPAIR_BUDGET, maxInputCharacters: 1 } },
  );
});

test("retrieval ranks relevant domain declarations and does not claim unsupported profiles", () => {
  const c = {
    libraryProfile: "analysis-continuity-v1",
    leanTarget: "UniformContinuousOn f (Set.Icc a b)",
    statement: "闭区间连续函数一致连续",
  };
  assert.ok(
    rankDeclarations(c).some(
      (e) => e.name === "IsCompact.uniformContinuousOn_of_continuous",
    ),
  );
  assert.deepEqual(rankDeclarations({ ...c, libraryProfile: "std-v1" }), []);
});

test("type-check failure cannot be waived by a human checkbox or a written resolution", async () => {
  await harness(
    async (p) => {
      const r = await settled(p, (await p.start(await input())).id);
      assert.equal(r.status, "blocked");
      assert.equal(r.nativeTargetCheck.status, "not_well_typed");
      assert.equal(r.semanticReview, undefined);
      await assert.rejects(
        p.approve(r.id, {
          confirmed: true,
          targetHash: r.contract.targetHash,
          resolutions: [],
        }),
        /任务阶段|目标摘要/,
      );
      assert.equal((await p.store.getRun(r.id)).approval, null);
    },
    {
      targetChecker: async (c) => ({
        status: "not_well_typed",
        targetHash: c.targetHash,
        reason: "Synthetic unknown identifier",
      }),
    },
  );
});

test("an elapsed repair budget stops before further model work and keeps the result unknown", async () => {
  await harness(
    async (p, calls) => {
      const r = await settled(p, (await p.start(await input())).id);
      await p.approve(r.id, approve(r));
      const done = await settled(p, r.id);
      assert.equal(done.conclusion.theorem, "unknown");
      assert.ok(
        ["time_budget", "execution_error"].includes(done.repair.stopReason),
      );
      assert.ok(calls.filter((c) => c.role === "R09").length <= 1);
    },
    { repairBudget: { ...REPAIR_BUDGET, maxElapsedMs: 1 } },
  );
});

test("interrupted unapproved translation resumes only when explicitly retried", async () => {
  await harness(async (p, calls) => {
    const draft = await settled(p, (await p.start(await input())).id);
    draft.status = "interrupted";
    await p.store.saveRun(draft);
    const original = digest(await p.store.getRun(draft.id));
    const next = await settled(p, (await p.retryTranslation(draft.id)).id);
    assert.equal(next.status, "awaiting_confirmation");
    assert.equal(next.contract.targetHash, draft.contract.targetHash);
    assert.equal(next.approval, null);
    assert.equal(calls.filter((c) => c.role === "R03").length, 1);
    assert.equal(digest(await p.store.getRun(draft.id)), original);
  });
});

test("translation retry preserves the original failure and fixed target, without rerunning extraction", async () => {
  await harness(async (p, calls) => {
    const model = p.model;
    let failOnce = true;
    p.model = async (config, request) => {
      if (request.role === "R04" && failOnce) {
        failOnce = false;
        const error = new Error("Synthetic truncated response");
        error.modelRecord = {
          content: '{"incomplete":',
          provider: "synthetic-only",
        };
        throw error;
      }
      return model(config, request);
    };
    const failed = await settled(p, (await p.start(await input())).id);
    assert.equal(failed.status, "blocked");
    assert.ok(failed.contract);
    const original = digest(await p.store.getRun(failed.id));
    const next = await settled(p, (await p.retryTranslation(failed.id)).id);
    assert.notEqual(next.id, failed.id);
    assert.equal(next.status, "awaiting_confirmation");
    assert.equal(next.contract.targetHash, failed.contract.targetHash);
    assert.equal(calls.filter((c) => c.role === "R03").length, 1);
    assert.equal(digest(await p.store.getRun(failed.id)), original);
    await p.approve(next.id, approve(next));
    const done = await settled(p, next.id);
    assert.equal(done.conclusion.theorem, "formalized_proved");
    assert.ok(
      (await p.store.bundle(done.root)).artifacts.some(
        (a) => a.kind === "task:R04B:blocked",
      ),
    );
    inspectReviewEvidence(await p.store.bundle(done.root));
  });
});

test("cancellation during model proof work terminates the attempt without a kernel verdict", async () => {
  await harness(async (p) => {
    const model = p.model;
    let notify;
    const entered = new Promise((resolve) => {
      notify = resolve;
    });
    p.model = (config, request) =>
      request.role === "R09"
        ? new Promise((resolve, reject) => {
            notify();
            if (request.signal.aborted) reject(new Error("cancelled"));
            else
              request.signal.addEventListener(
                "abort",
                () => reject(new Error("cancelled")),
                { once: true },
              );
          })
        : model(config, request);
    const r = await settled(p, (await p.start(await input())).id);
    await p.approve(r.id, approve(r));
    await entered;
    await p.cancel(r.id);
    const done = await settled(p, r.id);
    assert.equal(done.status, "cancelled");
    assert.equal(done.conclusion.theorem, "unknown");
    assert.equal(done.repair.stopReason, "cancelled");
    assert.equal(done.tasks.filter((t) => t.role === "R10").length, 0);
  });
});

test("failure of the original-proof opinion does not masquerade as proof failure or block independent evidence", async () => {
  await harness(async (p) => {
    const model = p.model;
    p.model = (config, request) => {
      if (request.role === "R06")
        throw new Error("Synthetic provider outage in original-proof audit");
      return model(config, request);
    };
    const r = await settled(p, (await p.start(await input())).id);
    await p.approve(r.id, approve(r));
    const done = await settled(p, r.id);
    assert.equal(done.conclusion.theorem, "formalized_proved");
    assert.equal(done.conclusion.originalProof, "unverified");
    assert.match(done.originalProof.explanation, /未完成/);
    inspectReviewEvidence(await p.store.bundle(done.root));
  });
});

test("human translation can use model proof repair without inventing model translation or weakening confirmation", async () => {
  await harness(
    async (p, calls) => {
      const data = await input();
      const first = await p.start({
        ...data,
        mode: "manual",
        proofStrategy: "model",
        proposal,
        seedProof: { mode: "proof", proof: "by rfl" },
      });
      let run = await settled(p, first.id);
      assert.equal(run.status, "awaiting_confirmation");
      assert.equal(calls.length, 0);
      assert.equal(run.tasks.find((t) => t.role === "R03").type, "human_input");
      assert.ok(
        run.semanticReview.issues.some(
          (i) => i.code === "manual_alignment_review",
        ),
      );
      await assert.rejects(
        p.approve(run.id, { ...approve(run), resolutions: [] }),
        /逐项解决/,
      );
      await p.approve(run.id, approve(run));
      run = await settled(p, first.id);
      assert.equal(run.conclusion.theorem, "formalized_proved");
      assert.equal(run.attempts.length, 2);
      assert.deepEqual(
        calls.map((c) => c.role),
        ["R09", "R06"],
      );
      assert.equal(
        run.tasks.filter((t) => t.role === "R09")[0].type,
        "human_input",
      );
      assert.equal(run.tasks.filter((t) => t.role === "R09")[1].type, "model");
      inspectReviewEvidence(await p.store.bundle(run.root), run.root);
    },
    { proofs: ["by intro n; rfl"] },
  );
});

test("original-proof gap opinions become pending obligations, even when an independent proof succeeds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-gap-obligation-"));
  const p = new ReviewPipeline({
    store: new EvidenceStore(root),
    getConfig: async () => ({ model: "synthetic" }),
    targetChecker: typeChecker,
    knowledge: noKnowledge,
    model: async (_config, request) => ({
      parsed:
        request.role === "R06"
          ? {
              status: "gap_candidate",
              pageIndex: 1,
              quote,
              explanation: "Synthetic candidate gap; not a verified finding.",
            }
          : { proof: "by intro n; rfl", mode: "proof", route: "independent" },
      record: { provider: "synthetic" },
    }),
    checker: async (c) => ({
      targetHash: c.targetHash,
      mode: "proof",
      status: "verified",
      exitCode: 0,
      axioms: [],
    }),
  });
  try {
    await p.init();
    const first = await p.start({
      ...(await input()),
      mode: "manual",
      proofStrategy: "model",
      proposal,
    });
    const draft = await settled(p, first.id);
    await p.approve(first.id, approve(draft));
    const run = await settled(p, first.id);
    assert.equal(run.conclusion.theorem, "formalized_proved");
    assert.equal(run.conclusion.originalProof, "gap_candidate");
    assert.equal(run.pendingObligations[0].type, "proof_step");
    assert.equal(run.pendingObligations[0].quote, quote);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured large per-call budgets are accounted for without exhausting the old repair token ceiling", async () => {
  await harness(
    async (p) => {
      const r = await settled(p, (await p.start(await input())).id);
      await p.approve(r.id, approve(r));
      const done = await settled(p, r.id);
      assert.equal(done.repair.budget.perCallCompletionTokens, 262144);
      assert.ok(done.repair.budget.maxCompletionTokens >= 3 * 262144);
      assert.ok(done.repair.budget.maxElapsedMs >= 3600000);
      assert.ok(done.repair.modelCalls >= 2);
      assert.equal(done.conclusion.theorem, "formalized_proved");
    },
    {
      getConfig: async () => ({
        model: "synthetic-large-budget",
        maxOutputTokens: 262144,
        timeoutMs: 3600000,
      }),
    },
  );
});

test("automatic alignment repair changes evidence revision but cannot change mathematics or reuse approval", async () => {
  await harness(async (p, calls) => {
    let injectExtraTarget = true;
    const model = p.model;
    p.model = async (config, req) => {
      if (req.role === "R03_ALIGNMENT_FIX")
        return {
          parsed: {
            alignment: alignment(),
            ...(injectExtraTarget ? { leanTarget: "True" } : {}),
          },
          record: { provider: "synthetic-only", role: req.role },
        };
      const out = await model(config, req);
      if (req.role === "R03")
        out.parsed.alignment[0].anchors = [
          { pageIndex: 1, quote: "invented evidence anchor" },
        ];
      return out;
    };
    const failed = await settled(p, (await p.start(await input())).id);
    assert.equal(failed.status, "blocked");
    assert.ok(failed.contract);
    const oldHash = digest(await p.store.getRun(failed.id));
    const invalid = await settled(
      p,
      (await p.retryTranslation(failed.id, { repairAlignment: true })).id,
    );
    assert.equal(invalid.status, "blocked");
    assert.equal(invalid.contract.leanTarget, failed.contract.leanTarget);
    injectExtraTarget = false;
    const next = await settled(
      p,
      (
        await p.retryTranslation(failed.id, {
          repairAlignment: true,
          repairFeedback: "Fix only the invented quote",
        })
      ).id,
    );
    assert.equal(next.status, "awaiting_confirmation");
    assert.equal(next.contract.leanTarget, failed.contract.leanTarget);
    assert.deepEqual(next.contract.assumptions, failed.contract.assumptions);
    assert.notEqual(next.contract.targetHash, failed.contract.targetHash);
    assert.equal(next.approval, null);
    assert.equal(next.translationRepair.mathTargetUnchanged, true);
    assert.equal(digest(await p.store.getRun(failed.id)), oldHash);
    await p.approve(next.id, approve(next));
    const done = await settled(p, next.id);
    assert.equal(done.conclusion.theorem, "formalized_proved");
    inspectBundle(await p.store.bundle(done.root));
  });
});

test("unapproved target repair receives native diagnostics and rechecks a new immutable target", async () => {
  await harness(
    async (p, calls) => {
      const original = p.model;
      p.model = async (config, r) => {
        if (r.role === "R03_TARGET_REPAIR") {
          assert.match(
            r.input.previousNativeTargetCheck.parser.stderr,
            /expected/,
          );
          assert.equal(r.input.selectedQuote, quote);
          return {
            parsed: { ...proposal, alignment: alignment() },
            record: { provider: "synthetic-only", role: r.role },
          };
        }
        const value = await original(config, r);
        if (r.role === "R03") value.parsed.leanTarget = "∀ n : Nat, (n + 0 = n";
        if (
          r.role === "R04" &&
          r.input.stage === "comparison_after_immutable_blind_review" &&
          r.input.contract.leanTarget.includes("(n + 0")
        )
          assert.match(r.input.typeInspection.parser.stderr, /expected/);
        return value;
      };
      const failed = await settled(p, (await p.start(await input())).id),
        old = digest(failed);
      assert.equal(failed.nativeTargetCheck.status, "not_well_typed");
      const repaired = await settled(
        p,
        (
          await p.retryTranslation(failed.id, {
            reviseTarget: true,
            repairAlignment: true,
            repairFeedback:
              "Correct the actual parser error without changing the source claim",
          })
        ).id,
      );
      assert.equal(repaired.status, "awaiting_confirmation", repaired.error);
      assert.equal(repaired.semanticReview.targetCheck.status, "well_typed");
      assert.equal(repaired.contract.leanTarget, proposal.leanTarget);
      assert.equal(
        repaired.contract.sourceArtifact,
        failed.contract.sourceArtifact,
      );
      assert.equal(
        repaired.contract.contextArtifact,
        failed.contract.contextArtifact,
      );
      assert.deepEqual(repaired.contract.imports, failed.contract.imports);
      assert.deepEqual(repaired.autonomy, failed.autonomy);
      assert.notEqual(repaired.contract.targetHash, failed.contract.targetHash);
      assert.equal(
        repaired.translationRepair.kind,
        "unapproved_target_retranslation",
      );
      assert.equal(repaired.translationRepair.mathTargetUnchanged, false);
      assert.equal(repaired.approval, null);
      assert.equal(digest(await p.store.getRun(failed.id)), old);
    },
    {
      targetChecker: async (c) =>
        c.leanTarget.includes("(n + 0")
          ? {
              status: "not_well_typed",
              targetHash: c.targetHash,
              reason: "syntax rejected",
              parser: { exitCode: 1, stderr: "Target.txt:1:20: expected ')'" },
            }
          : typeChecker(c),
    },
  );
});

test("a new translation version drops old proof acceptance and cannot switch source passages", async () => {
  await harness(async (p) => {
    let wrongQuote = false;
    const original = p.model;
    p.model = async (c, r) =>
      r.role === "R03_TARGET_REPAIR"
        ? {
            parsed: {
              ...proposal,
              quote: wrongQuote ? "invented different passage" : quote,
              alignment: alignment(),
            },
            record: { provider: "synthetic-only", role: r.role },
          }
        : original(c, r);
    const old = await settled(p, (await p.start(await input())).id);
    const stale = await p.store.put("explicit_stale_acceptance_fixture", {
      purpose: "verify exclusion, not an actual proof",
    });
    Object.assign(old, {
      status: "completed",
      approval: { authority: "autonomous_agent_semantic_assessment_not_human" },
      approvalArtifact: stale,
      check: { status: "verified" },
      checkArtifact: stale,
      proofArtifact: stale,
      originalProof: { status: "faithful" },
      originalProofRoute: { assembly: { status: "verified" } },
      repair: { stopReason: "verified" },
      attempts: [{ proof: "stale answer" }],
      provingSearch: { status: "verified" },
      seedProof: { proof: "stale answer" },
      conclusion: { theorem: "formalized_proved" },
    });
    await p.store.saveRun(old);
    const before = digest(old);
    await assert.rejects(p.retryTranslation(old.id));
    const next = await settled(
      p,
      (await p.retryTranslation(old.id, { reviseTarget: true })).id,
    );
    assert.equal(next.status, "awaiting_confirmation", next.error);
    for (const key of [
      "check",
      "checkArtifact",
      "proofArtifact",
      "originalProof",
      "originalProofRoute",
      "repair",
      "attempts",
      "provingSearch",
      "seedProof",
      "approvalArtifact",
    ])
      assert.equal(next[key], undefined, key);
    assert.equal(next.approval, null);
    assert.equal(next.conclusion, null);
    assert(next.tasks.every((t) => !["R06", "R09", "R10"].includes(t.role)));
    assert.equal(digest(await p.store.getRun(old.id)), before);
    wrongQuote = true;
    const rejected = await settled(
      p,
      (await p.retryTranslation(next.id, { reviseTarget: true })).id,
    );
    assert.equal(rejected.status, "blocked");
    assert.match(rejected.error, /选定原文/);
    assert.equal(rejected.check, undefined);
  });
});
