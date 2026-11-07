import { digest } from "./evidence.mjs";
import { resolveContextAnchor } from "./context.mjs";
export function inspectSourceProofAbsence(artifacts, root, contract) {
  const a = artifacts.get(root),
    p = a?.payload;
  if (
    a?.kind !== "source_proof_absence" ||
    p.targetHash !== contract.targetHash ||
    p.paperSha256 !== contract.paperSha256
  )
    throw Error("Source proof absence identity mismatch");
  const audit = artifacts.get(p.auditArtifact),
    decision = artifacts.get(p.decisionArtifact),
    context = artifacts.get(p.contextArtifact),
    target = artifacts.get(p.contractArtifact);
  if (
    ![
      p.auditArtifact,
      p.decisionArtifact,
      p.contextArtifact,
      p.contractArtifact,
    ].every((id) => a.inputs.includes(id)) ||
    audit?.kind !== "task:R06" ||
    !audit.payload.model ||
    audit.payload.status !== "source_proof_missing" ||
    !audit.payload.anchor ||
    !audit.inputs.includes(p.contractArtifact) ||
    !audit.inputs.includes(p.contextArtifact) ||
    decision?.kind !== "adaptive:assess_target" ||
    !decision.inputs.includes(p.contractArtifact) ||
    !decision.inputs.includes(p.contextArtifact) ||
    !decision.payload.model ||
    decision.payload.value.sourceProof !== "missing" ||
    decision.payload.value.targetHash !== contract.targetHash ||
    !context ||
    context.payload.paperSha256 !== contract.paperSha256 ||
    context.payload.omittedPages?.length !== 0 ||
    digest(target?.payload) !== digest(contract)
  )
    throw Error(
      "Source absence needs two source-bound observations and full context",
    );
  const resolved = resolveContextAnchor(audit.payload.anchor, context.payload, {
    focusAnchor: { pageIndex: contract.pageIndex, quote: contract.quote },
  });
  if (digest(resolved) !== digest(audit.payload.anchor))
    throw Error("Source absence anchor is not bound to its full context");
  return {
    status: "source_proof_missing",
    authority: "two_agent_source_observations_not_mathematical_proof",
    reproduced: true,
    revalidated: false,
  };
}
