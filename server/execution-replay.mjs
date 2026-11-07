import { inspectBundle, evidenceClosure } from "./evidence.mjs";

// Replay every archived native child check reachable from an autonomous run.
// Model planning/opinions and unfinished obligations remain explicitly unchecked.
export async function replayExecutionBundle(bundle, expectedRoot, replayReview) {
  const { root, artifacts } = inspectBundle(bundle, expectedRoot);
  if (!root.kind.startsWith("adaptive:")) throw Error("Unsupported execution report");
  const results = [], unchecked = [];
  for (const artifact of artifacts.values()) {
    if (artifact.kind !== "review_report") continue;
    if (!artifact.payload.check || !artifact.payload.proofArtifact) {
      unchecked.push({ root: artifact.id, status: artifact.payload.status,
        reason: "no_archived_native_completion" });
      continue;
    }
    try {
      results.push(await replayReview(evidenceClosure(bundle, artifact.id), artifact.id));
    } catch (e) {
      results.push({ root: artifact.id, reproduced: false, revalidated: false,
        error: { message: e.message, code: e.code || null } });
    }
  }
  return { schemaVersion: "lemma.execution-replay.v1", root: root.id, integrity: true, results, unchecked,
    reproduced: results.length > 0 && results.every((r) => r.reproduced),
    revalidated: results.length > 0 && results.every((r) => r.revalidated),
    sameEnvironment: results.length > 0 && results.every((r) => r.sameEnvironment),
    scope: "reachable_archived_native_checks_only_not_whole_paper_or_model_judgment",
    wholePaperVerified: false, modelReplay: "not_requested" };
}
