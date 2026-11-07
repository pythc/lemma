import { digest } from "../evidence.mjs";

// Reuse is explicit provenance, never a new kernel invocation. Only a proof
// previously replayed by independent acceptance in THIS run is eligible.
export async function reuseAcceptedProof(a, ctx, checkEnvironment) {
  const { run, actor, getArtifact, getTarget, record } = ctx;
  if (actor.role !== "acceptance")
    throw Error("Independent acceptance selects reusable evidence");
  const prior = run.submissions.find(
    (s) =>
      s.status === "pass" && s.acceptanceArtifact === a.acceptanceArtifactId,
  );
  if (!prior || !prior.replayIds?.includes(a.replayArtifactId))
    throw Error("Proof was not independently accepted in this review");
  const acceptance = await getArtifact(a.acceptanceArtifactId);
  if (
    acceptance.kind !== "team:acceptance" ||
    acceptance.payload.result.verdict !== "pass" ||
    acceptance.payload.actorId === prior.taskId
  )
    throw Error("Missing independent acceptance provenance");
  const old = await getArtifact(a.replayArtifactId),
    p = old.payload.result;
  if (
    !["team:lean", "team:lean_reuse"].includes(old.kind) ||
    old.payload.actorId !== acceptance.payload.actorId
  )
    throw Error(
      "Replay receipt must belong to the recorded independent reviewer",
    );
  const target = getTarget(a.targetId);
  if (
    target.supersededBy ||
    !prior.targetIds.includes(target.id) ||
    p.targetId !== target.id ||
    p.proof !== a.proof ||
    p.mode !== (a.mode || "proof") ||
    p.result.status !== "verified" ||
    p.result.targetHash !== target.contract.targetHash ||
    digest(p.contract) !== digest(target.contract)
  )
    throw Error(
      "Target version, proof, mode or contract changed; run a fresh check",
    );
  const { lean, library } = await checkEnvironment(target.contract);
  const { searchPaths, ...libraryIdentity } = library;
  const current = {
    ...lean,
    ready: lean.ready && library.ready,
    library: libraryIdentity,
    reason: lean.ready ? library.reason : lean.reason,
  };
  if (current.reason === undefined) delete current.reason;
  if (!current.ready || digest(current) !== digest(p.result.environment))
    throw Error("Native environment or checker changed; run a fresh check");
  const result = {
    targetId: target.id,
    contract: target.contract,
    proof: p.proof,
    mode: p.mode,
    result: p.result,
    reused: true,
    nativeCheckExecuted: false,
    originalProofReceipt: p.originalProofReceipt || a.replayArtifactId,
    priorAcceptanceArtifact: a.acceptanceArtifactId,
    previousReplayArtifact: a.replayArtifactId,
  };
  const artifactId = await record("lean_reuse", result, [
    target.artifact,
    a.acceptanceArtifactId,
    a.replayArtifactId,
  ]);
  return {
    ...result,
    artifactId,
    meaning:
      "Previously independently replayed exact proof reused after environment identity validation; not another Lean check or another paper theorem.",
  };
}
