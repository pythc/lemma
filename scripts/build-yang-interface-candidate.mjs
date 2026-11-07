import { EvidenceStore } from "../server/evidence.mjs";
import { obligationContract } from "../server/proof-decomposition.mjs";
import { checkProof } from "../server/lean.mjs";
import { auditLocalInference } from "../server/lean-dependencies.mjs";
import { ProofMemory, proofMemoryScope } from "../server/proof-memory.mjs";
import { writeFile } from "node:fs/promises";
// This is a source-specific proof construction for the real-paper experiment,
// not a special case in the product. Every transformed term is recompiled.
const store = new EvidenceStore(".runtime/original-proof-20261019/store");
const baseline = await store.getRun("c4036820-196a-44b6-8152-3e8a48de0c14");
const plan = await store.get(
  "ebcdd485abb004af5b22053aa48fdb2f58c9f33ef8fe6e7ac9c4a8e249e87d3a",
);
const graph = plan.payload.graph,
  old = baseline.originalProofRoute;
const proof = old.steps.find((s) => s.name === "S2").proof;
const cases = proof
  .split(/^    · /m)
  .slice(1)
  .map((s) => s.replace(/\n  · rcases hc with hconc \| hconv\s*$/, ""));
if (cases.length !== 4) throw Error("Source proof case layout changed");
const trim = (s) =>
  s
    .split("\n")
    .map((l, i) => (i ? l.replace(/^      /, "") : l))
    .join("\n")
    .trimEnd();
const bodies = cases.map(trim);
bodies[0] = bodies[0].replace(
  "exact Or.inl (ProofPart_S1 I f hI hmono hconc σ hσ)",
  "exact ProofPart_S1 I f hI hmono hconc σ hσ",
);
for (const i of [1, 2]) bodies[i] = bodies[i].replace(/^right\n/m, "");
bodies[3] = bodies[3].replace("exact Or.inl hS", "exact hS");
const indent = (s, n) =>
  s
    .split("\n")
    .map((l) => " ".repeat(n) + l)
    .join("\n");
const candidate =
  "by\n  intro ProofPart_S1 I f hI\n  refine ⟨?_, ?_, ?_, ?_⟩\n" +
  bodies
    .map(
      (b, i) =>
        "  · intro h σ hσ\n    rcases h with ⟨" +
        ["hmono, hconc", "hmono, hconv", "hanti, hconc", "hanti, hconv"][i] +
        "⟩\n" +
        indent(b, 4),
    )
    .join("\n");
const s2 = graph.steps.find((s) => s.name === "S2");
const contract = obligationContract(baseline.contract, "S2", s2.target, [
  graph.steps.find((s) => s.name === "S1"),
]);
const check = await checkProof(contract, candidate, {
  dependencyAudit: true,
  requiredBinders: 1,
});
const audit = auditLocalInference(check, old.policy, [graph.steps[0]]);
const memory = new ProofMemory(store);
const artifact = await memory.remember({
  contract,
  proof: candidate,
  check,
  audit,
  scope: proofMemoryScope(contract, {
    context: old.context,
    policy: old.policy,
  }),
  branch: {
    strategy: "source_case_indexed_interface",
    parent: old.steps.find((s) => s.name === "S2").artifact,
  },
  inputs: [baseline.root, plan.id],
});
await writeFile(
  "evidence/proof-workspace-20261019/case-interface-candidate.json",
  JSON.stringify({ artifact, contract, proof: candidate, check, audit }),
);
console.log(
  JSON.stringify({
    artifact,
    status: check.status,
    used: check.dependencies?.binderUse,
    diagnostic: check.status === "verified" ? null : check.stdout.slice(-2000),
  }),
);
