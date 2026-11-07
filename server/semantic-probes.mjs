import { digest } from "./evidence.mjs";
import { validateContract, validateLeanText, text, MAX_PROOF_CHARACTERS } from "./contracts.mjs";
import { anchorInContext } from "./context.mjs";
import { checkProof } from "./lean.mjs";

export function prepareSemanticProbe(parent, context, proposal) {
  validateContract(parent);
  if (!["assumption_witness", "assumption_contradiction", "boundary_example", "counterexample"].includes(proposal?.kind))
    throw Error("语义诊断种类无效。");
  if (!Array.isArray(proposal.anchors) || !proposal.anchors.length || proposal.anchors.length > 8)
    throw Error("语义诊断缺少原文依据。");
  const anchors = proposal.anchors.map((a) => anchorInContext(a, context));
  const leanTarget = validateLeanText(proposal.leanTarget, "诊断目标", 12000);
  const proof = validateLeanText(proposal.proof, "诊断候选", MAX_PROOF_CHARACTERS);
  const { targetHash: parentTargetHash, ...base } = parent;
  const body = { ...base, label: `Diagnostic ${proposal.kind}`, leanTarget };
  const contract = validateContract({ ...body, targetHash: digest(body) });
  return { schemaVersion: "lemma.semantic-probe.v1", parentTargetHash, paperSha256: parent.paperSha256,
    kind: proposal.kind, explanation: text(proposal.explanation, 1600, "诊断目的"), anchors, contract, proof,
    relationToSource: "agent_proposed_not_certified", parentAcceptance: "unchanged",
    authority: "native_check_of_diagnostic_goal_only_not_source_fidelity_or_parent_theorem" };
}

export async function checkSemanticProbe(parent, context, proposal, { signal, checker = checkProof } = {}) {
  const prepared = prepareSemanticProbe(parent, context, proposal);
  const check = await checker(prepared.contract, prepared.proof, { mode: "proof", signal });
  return { ...prepared, check };
}
