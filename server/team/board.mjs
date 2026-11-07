const preview = (s, size = 600) =>
  typeof s === "string" && s.length > size
    ? s.slice(0, size) + "… [preview; read_object for full text]"
    : s;
export const boardSections = [
  "tasks",
  "targets",
  "objectives",
  "submissions",
  "messages",
  "progressReports",
  "operations",
  "receipts",
];
const sections = boardSections;
export const boardKinds = [
  ...sections.filter((s) => s !== "receipts"),
  "task",
  "target",
  "objective",
  "submission",
  "message",
  "operation",
  "progressReport",
  "artifact",
];
const brief = (section, x) => {
  if (section === "receipts")
    return {
      artifactId: x,
      kind: "artifact_reference",
      read: { tool: "read_evidence", arguments: { artifactId: x } },
    };
  const keys = {
    tasks: [
      "id",
      "role",
      "title",
      "goal",
      "status",
      "version",
      "parentId",
      "submissionId",
      "waitingFor",
      "waitingOperations",
      "objectiveIds",
    ],
    targets: [
      "id",
      "label",
      "taskId",
      "taskVersion",
      "artifact",
      "objectiveId",
      "supersededBy",
      "bindingStatus",
    ],
    objectives: [
      "id",
      "title",
      "kind",
      "version",
      "status",
      "targetId",
      "ownerId",
      "dependencies",
      "artifact",
      "required",
    ],
    submissions: [
      "id",
      "taskId",
      "version",
      "summary",
      "resultKind",
      "status",
      "artifact",
      "acceptanceArtifact",
      "targetIds",
      "objectiveIds",
    ],
    operations: [
      "id",
      "actorId",
      "version",
      "name",
      "status",
      "artifactId",
      "startedAt",
      "endedAt",
      "phase",
      "resource",
      "queuedAt",
      "executionStartedAt",
    ],
    messages: ["id", "from", "to", "message", "at"],
    progressReports: [
      "actorId",
      "version",
      "summary",
      "artifact",
      "submissionId",
      "acceptanceArtifact",
      "accepted",
      "at",
    ],
  }[section];
  return {
    ...Object.fromEntries(
      keys.filter((k) => x[k] !== undefined).map((k) => [k, preview(x[k])]),
    ),
    ...(x.id
      ? {
          read: { tool: "read_object", arguments: { kind: section, id: x.id } },
        }
      : {}),
    ...(x.artifact || x.artifactId
      ? {
          evidence: {
            tool: "read_evidence",
            arguments: { artifactId: x.artifact || x.artifactId },
          },
        }
      : {}),
  };
};
export function boardView(run, actor, args = {}) {
  const limit = Math.min(100, Math.max(1, args.limit || 20)),
    offset = args.offset || 0;
  const chosen = args.section
    ? [args.section]
    : sections.filter((s) => s !== "receipts");
  if (chosen.some((s) => !sections.includes(s)))
    throw Error("Unknown board section");
  const result = {
    revision: run.revision,
    pagination: {},
    actorId: actor.id,
    guidance:
      "Summaries are navigation, not evidence. Page every section with read_board(section, offset, limit); read_object returns a complete saved object. No history is discarded.",
  };
  for (const section of chosen) {
    let rows = run[section] || [];
    if (args.actorId)
      rows = rows.filter(
        (x) =>
          x.actorId === args.actorId ||
          x.taskId === args.actorId ||
          x.id === args.actorId,
      );
    if (args.status) rows = rows.filter((x) => x.status === args.status);
    // Recent work first for navigation; immutable source records retain order.
    rows = [...rows].reverse();
    result[section] = rows
      .slice(offset, offset + limit)
      .map((x) => brief(section, x));
    result.pagination[section] = {
      total: rows.length,
      offset,
      limit,
      nextOffset: offset + limit < rows.length ? offset + limit : null,
    };
  }
  result.openObjectiveCount = (run.objectives || []).filter(
    (x) => x.status === "open",
  ).length;
  return result;
}
export function readBoardObject(run, { id, kind } = {}) {
  const aliases = {
    task: "tasks",
    target: "targets",
    objective: "objectives",
    submission: "submissions",
    operation: "operations",
    message: "messages",
    progressReport: "progressReports",
  };
  kind = aliases[kind] || kind;
  const names = kind ? [kind] : sections.filter((s) => s !== "receipts");
  if (names.some((s) => !sections.includes(s) || s === "receipts"))
    throw Error("Use a board section kind; artifact content is read_evidence");
  const found = names.flatMap((k) =>
    (run[k] || [])
      .filter((x) => x.id === id)
      .map((value) => ({ kind: k, value })),
  );
  if (found.length !== 1)
    throw Object.assign(
      Error(
        "Object not found uniquely in this review. Use the supplied navigation; no shortened ID is guessed.",
      ),
      {
        navigation: {
          tool: "read_board",
          arguments: { section: sections.includes(kind) ? kind : "tasks" },
          matches: sections
            .filter((s) => s !== "receipts")
            .flatMap((section) =>
              (run[section] || [])
                .filter((x) => x.id === id)
                .map((x) => ({
                  tool: "read_object",
                  arguments: { kind: section, id: x.id },
                })),
            ),
        },
      },
    );
  return JSON.parse(JSON.stringify(found[0]));
}
