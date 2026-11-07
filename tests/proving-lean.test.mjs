import test from "node:test";
import assert from "node:assert/strict";
import {
  ProverSession,
  proverCapabilities,
} from "../server/prover-session.mjs";
import { ProvingEngine } from "../server/proving-engine.mjs";
import { createContract } from "../server/contracts.mjs";
import { checkProof } from "../server/lean.mjs";
import { sha256 } from "../server/evidence.mjs";
const make = (target) =>
  createContract(
    {
      paperSha256: sha256("compatibility fixture"),
      text: "authored compatibility target",
      pageIndex: 0,
      artifact: sha256("source"),
    },
    {
      label: "compatibility",
      quote: "authored compatibility target",
      statement: "authored compatibility target",
      assumptions: [],
      leanTarget: target,
    },
    "analysis-continuity-v1",
  );
test("LeanInteract and LeanCopilot pinned artifacts are available", async () => {
  assert.equal((await proverCapabilities()).ready, true);
});
test(
  "rollback, coupled goals, checkpoint restart and fresh kernel replay",
  { timeout: 240000 },
  async () => {
    const c = make("∀ P Q : Prop, P ∧ Q → Q ∧ P");
    let s = new ProverSession();
    try {
      const initial = await s.create(c);
      const bad = await s.applyTactic("exact Nat.zero_le");
      assert.equal(bad.status, "rejected");
      assert.deepEqual((await s.inspectGoal()).goals, initial.goals);
      await s.applyTactic("intro P Q h");
      await s.applyTactic("constructor");
      assert.equal((await s.inspectGoal()).goals.length, 2);
      const checkpoint = s.checkpoint();
      await s.close();
      s = new ProverSession();
      await s.create(c);
      await s.resume(checkpoint);
      await s.applyTactic("exact h.2");
      assert.equal((await s.inspectGoal()).goals.length, 1);
      await s.applyTactic("exact h.1");
      const candidate = s.exportCandidate();
      assert.equal((await checkProof(c, candidate.proof)).status, "verified");
      await assert.rejects(
        s.resume({ ...checkpoint, targetHash: sha256("other") }),
      );
    } finally {
      await s.close();
    }
  },
);
test(
  "LeanCopilot proof extraction is independently checked and contains no search commands",
  { timeout: 180000 },
  async () => {
    const c = make("Continuous (fun x : ℝ => x)");
    const s = new ProverSession();
    try {
      await s.create(c);
      const entries = await s.queryPremises(["continuous_id"]);
      assert.equal(entries.status, "resolved");
      assert.ok(entries.entries.some((e) => e.name === "continuous_id"));
      const ranked = await s.queryPremises(["Continuous", "continuous_id"]);
      assert.ok(ranked.entries.some((e) => e.name === "continuous_id"));
      assert.ok(
        ranked.entries.find((e) => e.name === "continuous_id").nameMatchScore >=
          900,
      );
      const result = await s.runSearch(["fun_prop"]);
      assert.equal(result.completed, true);
      const p = s.exportCandidate();
      assert.ok(!p.proof.includes("[apply]"));
      assert.ok(!p.proof.includes("search_proof"));
      const check = await checkProof(c, p.proof);
      assert.equal(check.status, "verified");
      assert.ok(!check.axioms.includes("sorryAx"));
      await assert.rejects(s.applyTactic("exact lemma_search_target"));
    } finally {
      await s.close();
    }
  },
);
test(
  "search cannot certify a false target or a circular proof",
  { timeout: 180000 },
  async () => {
    const c = make("False");
    const s = new ProverSession();
    try {
      await s.create(c);
      const r = await s.runSearch(["rfl", "assumption"]);
      assert.notEqual(r.completed, true);
      assert.throws(() => s.exportCandidate());
    } finally {
      await s.close();
    }
    assert.notEqual(
      (await checkProof(c, "by exact lemma_search_target")).status,
      "verified",
    );
    await assert.rejects(checkProof(c, "by sorry"));
  },
);
test(
  "integrated search uses real Lean and preserves final trust boundary",
  { timeout: 180000 },
  async () => {
    const c = make("∀ x : ℝ, 0 ≤ x ^ 2");
    const r = await new ProvingEngine().prove(c, {
      budget: { maxModelCalls: 0 },
    });
    assert.equal(r.report.stopReason, "verified");
    assert.equal(r.check.targetHash, c.targetHash);
    assert.equal(r.report.modelCalls, 0);
    assert.equal(r.report.originalProofCoverage, "not_established");
  },
);
