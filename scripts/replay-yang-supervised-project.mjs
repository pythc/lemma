// Replay the supervised construction through the current generic proof-project engine.
// It contains recorded proofs, makes zero model calls, and is not an autonomous benchmark.
import { readFile, writeFile } from "node:fs/promises";
import { ProvingEngine } from "../server/proving-engine.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const dir = "evidence/yang-recursive-20261019";
const slope = await read(
  "evidence/yang-decomposition-20261019/verified-slope-lemma.json",
);
const glue = await read(`${dir}/glue-local-assembly.json`);
const original = await read(`${dir}/original-environment-replay.json`);
const contract = original.contract;
const ac =
  "∀ ε : ℝ, 0 < ε → ∃ δ : ℝ, 0 < δ ∧ ∀ (n : ℕ) (x y : Fin n → ℝ), (∀ i : Fin n, x i ∈ I ∧ y i ∈ I ∧ x i < y i) → (∀ i j : Fin n, i ≠ j → y i ≤ x j ∨ y j ≤ x i) → Finset.univ.sum (fun i : Fin n => y i - x i) < δ → Finset.univ.sum (fun i : Fin n => |f (y i) - f (x i)|) < ε";
const target =
  "∀ (I : Set ℝ) (f : ℝ → ℝ), (∀ x ∈ I, ∀ y ∈ I, ∀ z : ℝ, x ≤ z → z ≤ y → z ∈ I) → MonotoneOn f I → (∀ a ∈ I, ∀ b ∈ I, ∀ θ : ℝ, 0 < θ → θ < 1 → θ * f a + (1 - θ) * f b ≤ f (θ * a + (1 - θ) * b)) → UniformContinuousOn f I → " +
  ac;
const indent = (value) =>
  value
    .split("\n")
    .map((line) => "        " + line)
    .join("\n");
const goodProof = `by\n  intro I f hI hm hc\n  exact ((\n${indent(glue.proof)}\n  ) : (\n${indent(glue.contract.leanTarget)}\n  )) I f hI hm (((\n${indent(slope.proof)}\n  ) : (\n${indent(slope.contract.leanTarget)}\n  )) I f hI hm hc)`;
let transport = await readFile("scripts/yang-symmetry-proof.txt", "utf8");
const start = transport.indexOf("  have good :"),
  end = transport.indexOf("  have negUC :");
if (start < 0 || end <= start) throw Error("Transport template changed");
const signature = transport.slice(start, end).split(" := by")[0];
transport =
  transport.slice(0, start) +
  signature +
  " := ProofPart_Good\n" +
  transport.slice(end);
transport = transport.replace(/^by\n/, "by\n  intro ProofPart_Good\n");
// The four-case transport proves the conditional connection itself; never
// repeat the root proposition as a helper or treat that connection as success.
const plan = {
  parts: [
    {
      name: "Good",
      target,
      purpose: "Increasing concave case from slope and finite compression",
      dependsOn: [],
      proof: goodProof,
    },
  ],
  assembly: transport,
};
const store = new EvidenceStore(
  ".runtime/prover-benchmark/deepseek-flash-20261018/integrated/yang-zhu",
);
await store.init();
let previous = original.root;
const result = await new ProvingEngine({
  model: async () => {
    throw Error("Model dispatch prohibited in recorded-proof replay");
  },
}).prove(contract, {
  config: { model: "recorded-proof-replay" },
  initialDecomposition: {
    rootTargetHash: contract.targetHash,
    plans: [{ plan }],
    helpers: [],
  },
  budget: { maxModelCalls: 1, maxTacticSteps: 0, maxDecompositionPlans: 1 },
  step: async (kind, title, action) => {
    const value = await action();
    previous = await store.put(
      `yang_supervised_project:${kind}`,
      { title, value },
      [previous],
    );
    return value;
  },
});
const implementation = Object.fromEntries(
  await Promise.all(
    ["server/proof-decomposition.mjs", "server/proving-engine.mjs"].map(
      async (file) => [file, sha256(await readFile(file))],
    ),
  ),
);
const value = {
  scope: "recorded_supervised_proof_project_zero_inference",
  contract,
  result,
  implementation,
  autonomous: false,
  previousSupervisedRoot: original.root,
};
const root = await store.put("yang_current_engine_supervised_replay", value, [
  previous,
]);
await writeFile(
  `${dir}/supervised-project-replay.json`,
  JSON.stringify({ ...value, root }, null, 2),
  { flag: "wx" },
);
await writeFile(
  `${dir}/supervised-project-replay-bundle.json`,
  JSON.stringify(await store.bundle(root), null, 2),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    status: result.check?.status,
    stop: result.report.stopReason,
    modelCalls: result.report.modelCalls,
    root,
  }),
);
