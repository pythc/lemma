import { workSummary } from "./work-summary.mjs";
// Public navigation only. No summary supplies a proof premise or closes a goal.
export function resumeContext(run, actor, { offset = 0, limit = 40 } = {}) {
  const own = (run.operations || []).filter((o) => o.actorId === actor.id);
  const pending = own.filter(
    (o) => !["completed", "failed", "cancelled"].includes(o.status),
  );
  const checks = own
    .filter(
      (o) =>
        o.version === actor.version &&
        o.status === "completed" &&
        ["check_lean", "lean_draft", "lean_explore", "inspect_target"].includes(
          o.name,
        ),
    )
    .reverse();
  const page = (rows) => ({
    total: rows.length,
    offset,
    items: rows.slice(offset, offset + limit).map((o) => ({
      id: o.id,
      name: o.name,
      version: o.version,
      status: o.status,
      receivedAt: o.endedAt || null,
      inputArtifact: o.inputArtifact || null,
      artifactId: o.artifactId || null,
      read: { tool: "get_operation", arguments: { operationId: o.id } },
    })),
    nextOffset: offset + limit < rows.length ? offset + limit : null,
  });
  return {
    scope: "public_navigation_not_proof_or_new_verification",
    revision: run.revision,
    work: workSummary(run, actor.id),
    actor: { id: actor.id, version: actor.version, role: actor.role },
    pendingAndUnknown: page(pending),
    receivedChecksThisVersion: page(checks),
    exactCheckReceipts: {
      total: (run.proofReceiptIndex || []).filter((r) => r.actorId === actor.id)
        .length,
      offset,
      items: (run.proofReceiptIndex || [])
        .filter((r) => r.actorId === actor.id)
        .slice(offset, offset + limit)
        .map((r) => ({
          ...r,
          read: {
            tool: "read_evidence",
            arguments: { artifactId: r.artifactId },
          },
        })),
    },
    source: { tool: "read_source", arguments: {} },
    submission: actor.submissionId
      ? {
          tool: "read_object",
          arguments: { id: actor.submissionId, kind: "submission" },
        }
      : null,
    guidance:
      "Received checks belong to their recorded target/proof/environment. Retrieve the operation before deciding on a new check. New task/target/environment versions require validity assessment. Unknown requests are never replayed. Full source and all history remain available; this view does not choose a proof route.",
    more: {
      tool: "read_resume_context",
      arguments: { offset: offset + limit, limit },
    },
  };
}
