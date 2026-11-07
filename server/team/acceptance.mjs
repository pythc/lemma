// Acceptance policy is separate from orchestration and from native resources.
export async function validateAcceptance({
  run,
  actor,
  submission,
  decision,
  getArtifact,
  getTarget,
}) {
  const proofs = [];
  for (const id of decision.replayIds || []) {
    const e = await getArtifact(id);
    if (
      !["team:lean", "team:lean_reuse"].includes(e.kind) ||
      e.payload.actorId !== actor.id
    )
      throw Error(
        "Replay must be a fresh Lean receipt or validated reuse receipt made by this acceptance Agent",
      );
    proofs.push(e.payload.result);
  }
  if (decision.verdict !== "pass") return;
  if (submission.targetIds.some((t) => getTarget(t).supersededBy))
    throw Error(
      "Target version superseded; submit the new version for fresh acceptance",
    );
  if (
    ["lemma", "theorem", "counterexample", "author_route"].includes(
      submission.resultKind,
    )
  ) {
    const requiredMode =
      submission.resultKind === "counterexample" ? "counterexample" : "proof";
    if (
      !submission.targetIds.length ||
      submission.targetIds.some(
        (t) =>
          !proofs.some(
            (p) =>
              p.targetId === t &&
              p.mode === requiredMode &&
              p.result.status === "verified" &&
              p.result.targetHash === getTarget(t).contract.targetHash,
          ),
      )
    )
      throw Error(
        "No fresh exact-target Lean proof or validated reuse for each submitted target",
      );
    if (submission.resultKind === "author_route") {
      const routes = [];
      for (const id of submission.artifactIds) {
        const e = await getArtifact(id);
        if (e.kind === "team:route") routes.push(e.payload.result);
      }
      if (routes.length !== 1)
        throw Error("One explicit source route required");
      const route = routes[0];
      if (!submission.targetIds.includes(route.rootTargetId))
        throw Error("Root target must be rechecked");
      const checked = new Set(
        proofs
          .filter((p) => p.mode === "proof" && p.result.status === "verified")
          .map((p) => p.targetId),
      );
      if (!checked.has(route.rootTargetId))
        throw Error(
          "The assembled root requires a proof, not a negation or conditional draft",
        );
      for (const step of route.steps)
        if (!checked.has(step.targetId))
          throw Error(
            "Every source step must have independent closed-proof evidence",
          );
      // Correspondence/completeness is an independent Agent assessment, never
      // a kernel theorem about the natural-language author's argument.
    }
  }
}
