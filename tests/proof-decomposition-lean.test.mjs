import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createContract } from "../server/contracts.mjs";
import { sha256 } from "../server/evidence.mjs";
import { ProvingEngine } from "../server/proving-engine.mjs";
import { checkProof } from "../server/lean.mjs";
await mkdir("evidence/yang-decomposition-20261019", { recursive: true });
const root = createContract(
  {
    text: "authored decomposition fixture",
    paperSha256: sha256("decomposition fixture"),
    pageIndex: 0,
    artifact: sha256("source"),
  },
  {
    label: "fixture",
    quote: "authored decomposition fixture",
    statement: "execution fixture",
    assumptions: [],
    leanTarget: "(∀ n : Nat, n + 0 = n) ∧ (∀ n : Nat, (n + 0) + 0 = n)",
  },
);
test(
  "real Lean proves dependent helpers, composes the exact root and independently replays",
  { timeout: 240000 },
  async () => {
    const engine = new ProvingEngine({
      capabilities: async () => ({ ready: false }),
      knowledge: async () => ({ entries: [] }),
      specialistAvailable: async () => ({ ready: false }),
      model: async (_c, r) => ({
        parsed:
          r.role === "R09_DECOMPOSE"
            ? {
                parts: [
                  {
                    name: "Zero",
                    target: "∀ n : Nat, n + 0 = n",
                    purpose: "zero identity",
                    dependsOn: [],
                    proof: "by intro n; rfl",
                  },
                  {
                    name: "Twice",
                    target: "∀ n : Nat, (n + 0) + 0 = n",
                    purpose: "use checked identity",
                    dependsOn: ["Zero"],
                    proof:
                      "by intro ProofPart_Zero n; exact (ProofPart_Zero (n + 0)).trans (ProofPart_Zero n)",
                  },
                ],
                assembly:
                  "by intro ProofPart_Zero ProofPart_Twice; exact ⟨ProofPart_Zero, ProofPart_Twice⟩",
              }
            : { unavailable: "authored route requires decomposition" },
        record: { provider: "controlled_fixture_no_external_model" },
      }),
    });
    const result = await engine.prove(root, {
      config: { model: "controlled_fixture" },
      budget: { maxModelCalls: 6, maxTacticSteps: 0, maxDecompositionPlans: 1 },
    });
    assert.equal(
      result.report.stopReason,
      "verified",
      JSON.stringify(result.report),
    );
    const replay = await checkProof(root, result.candidate.proof);
    assert.equal(replay.status, "verified");
    assert.ok(!replay.axioms.includes("sorryAx"));
    await mkdir("evidence/yang-decomposition-20261019", { recursive: true });
    await writeFile(
      "evidence/yang-decomposition-20261019/dependent-helper-real-lean.json",
      JSON.stringify(
        {
          classification: "authored_execution_fixture_not_paper_accuracy",
          root,
          result,
          replay,
        },
        null,
        2,
      ),
    );
  },
);
test(
  "real Lean accepts a conditional connection but rejects an unproved helper",
  { timeout: 120000 },
  async () => {
    const engine = new ProvingEngine({
      capabilities: async () => ({ ready: false }),
      knowledge: async () => ({ entries: [] }),
      specialistAvailable: async () => ({ ready: false }),
      model: async (_c, r) => ({
        parsed:
          r.role === "R09_DECOMPOSE"
            ? {
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
              }
            : { unavailable: "negative fixture" },
        record: { provider: "controlled_fixture_no_external_model" },
      }),
    });
    const result = await engine.prove(root, {
      config: { model: "controlled_fixture" },
      budget: {
        maxModelCalls: 5,
        maxHelperModelCalls: 1,
        maxTacticSteps: 0,
        maxDecompositionPlans: 1,
      },
    });
    assert.equal(
      result.report.decomposition.plans[0].connection.check.status,
      "verified",
    );
    assert.notEqual(
      result.report.decomposition.helpers[0].check.status,
      "verified",
    );
    assert.notEqual(result.report.stopReason, "verified");
    assert.equal(result.check, null);
    await writeFile(
      "evidence/yang-decomposition-20261019/false-helper-real-lean.json",
      JSON.stringify(
        { classification: "negative_execution_fixture", root, result },
        null,
        2,
      ),
    );
  },
);
test(
  "real Lean replays a recursively decomposed helper inside the unchanged root",
  { timeout: 180000 },
  async () => {
    const engine = new ProvingEngine({
      capabilities: async () => ({ ready: false }),
      knowledge: async () => ({ entries: [] }),
      specialistAvailable: async () => ({ ready: false }),
      model: async (_c, r) => {
        let parsed = { unavailable: "authored recursive route" };
        if (r.role === "R09_DECOMPOSE")
          parsed =
            r.input.root.targetHash === root.targetHash
              ? {
                  parts: [
                    {
                      name: "Zero",
                      target: "∀ n : Nat, n + 0 = n",
                      purpose: "needs a smaller helper",
                      dependsOn: [],
                    },
                    {
                      name: "Twice",
                      target: "∀ n : Nat, (n + 0) + 0 = n",
                      purpose: "use first identity",
                      dependsOn: ["Zero"],
                      proof:
                        "by intro ProofPart_Zero n; exact (ProofPart_Zero (n + 0)).trans (ProofPart_Zero n)",
                    },
                  ],
                  assembly:
                    "by intro ProofPart_Zero ProofPart_Twice; exact ⟨ProofPart_Zero, ProofPart_Twice⟩",
                }
              : {
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
                };
        return {
          parsed,
          record: {
            provider: "controlled_recursive_fixture_no_external_model",
          },
        };
      },
    });
    const result = await engine.prove(root, {
      config: { model: "controlled_fixture" },
      budget: {
        maxModelCalls: 8,
        maxTacticSteps: 0,
        maxDecompositionPlans: 1,
        maxDecompositionDepth: 2,
        maxHelperModelCalls: 8,
      },
    });
    assert.equal(
      result.report.stopReason,
      "verified",
      JSON.stringify(result.report),
    );
    assert.equal(result.report.modelCalls, 4);
    assert.equal(
      result.report.decomposition.helpers[0].report.decomposition.helpers[0]
        .status,
      "verified",
    );
    const replay = await checkProof(root, result.candidate.proof);
    assert.equal(replay.status, "verified");
    await writeFile(
      "evidence/yang-decomposition-20261019/recursive-helper-real-lean.json",
      JSON.stringify(
        {
          classification: "authored_recursive_fixture_not_paper_accuracy",
          root,
          result,
          replay,
        },
        null,
        2,
      ),
    );
  },
);
