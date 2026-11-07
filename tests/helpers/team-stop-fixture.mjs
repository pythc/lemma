// Controlled driver helpers, never imported by product or real-paper runners.
export async function finishFixture(call, run, input) {
  const attempt = await call("search_mathlib", {
    queries: ["controlledFixtureNoSuchDeclaration"],
  });
  return call("finish_review", {
    ...input,
    stopProposal: {
      reason: "no_viable_path",
      explanation:
        "Controlled test's execution script has no additional mathematical implementation; this is not a real-paper result.",
      objectives: run.objectives.map((g) => ({
        objectiveId: g.id,
        version: g.version,
        attemptIds: [attempt.artifactId],
        whyStop: "Controlled test scope only",
        nextOptions: "Real autonomous paper acceptance is a separate test",
      })),
    },
  });
}
export async function assessFixture(call, run, actor, input) {
  const submission = run.submissions.find((s) => s.id === actor.submissionId);
  return call("assess_submission", {
    ...input,
    ...(submission.final
      ? {
          stopVerdict: "stop",
          stopExplanation:
            "Controlled stopping protocol accepted; no mathematical success inferred",
          reviewedObjectiveIds: run.objectives.map((g) => g.id),
        }
      : {}),
  });
}
