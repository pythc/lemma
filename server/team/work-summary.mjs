import { navigationTools } from "./action-identity.mjs";
// Observable work, not a mathematical score or a mandatory research schedule.
export function workSummary(run, actorId = null) {
  const all = (run.operations || []).filter(
      (o) => !actorId || o.actorId === actorId,
    ),
    groups = new Map();
  for (const o of all) {
    if (
      !o.logicalKey ||
      !["check_lean", "lean_draft", "inspect_target"].includes(o.name)
    )
      continue;
    const g = groups.get(o.logicalKey) || [];
    g.push(o);
    groups.set(o.logicalKey, g);
  }
  const repeats = [...groups.values()]
    .filter((g) => g.length > 1)
    .slice(-10)
    .map((g) => ({
      name: g[0].name,
      actorId: g[0].actorId,
      version: g[0].version,
      operationIds: g.map((o) => o.id),
      explicitNewReasons: g.map((o) => o.newExecutionReason).filter(Boolean),
      read: { tool: "get_operation", arguments: { operationId: g.at(-1).id } },
    }));
  const work = all.filter(
    (o) =>
      !navigationTools.has(o.name) &&
      ["completed", "failed"].includes(o.status),
  );
  const latest = work.at(-1);
  return {
    scope: "observable_work_not_proof_progress",
    navigationCalls: all.filter((o) => navigationTools.has(o.name)).length,
    operationCalls: all.length,
    nativeKernelSpans: all.reduce(
      (n, o) =>
        n +
        (o.nativeTimings || []).filter((s) => s.name === "native.kernel")
          .length,
      0,
    ),
    explicitReuseReceipts: (run.executionIndex || []).filter((e) =>
      ["lean_reuse", "lean_draft_reuse"].includes(e.kind),
    ).length,
    acceptedSubmissions: (run.submissions || []).filter(
      (s) => s.status === "pass" && !s.superseded,
    ).length,
    openObjectives: (run.objectives || []).filter((g) => g.status === "open")
      .length,
    targetVersions: (run.targets || []).length,
    lastWork: latest
      ? {
          operationId: latest.id,
          name: latest.name,
          status: latest.status,
          at: latest.endedAt,
        }
      : null,
    repeatedChecks: repeats,
    advisory: repeats.length
      ? "Repeated same-contract checks are visible. Inspect their original outcomes and decide whether to retrieve, explicitly recheck, change strategy, or propose stopping. No automatic stop or proof-route choice is imposed."
      : null,
  };
}
export function readerTaskPage(
  run,
  { bound = run.tasks.length, before = bound, limit = 60 } = {},
) {
  if (
    ![bound, before, limit].every(Number.isSafeInteger) ||
    bound < 0 ||
    before < 0 ||
    before > bound ||
    bound > run.tasks.length ||
    limit < 1 ||
    limit > 100
  )
    throw Error("Invalid task page cursor");
  const from = Math.max(0, before - limit),
    slice = run.tasks.slice(from, before),
    main = run.tasks.find((t) => t.role === "main");
  const rows =
    main && !slice.some((t) => t.id === main.id) ? [main, ...slice] : slice;
  return {
    items: rows.map(({ artifacts, notes, feedback, ...t }) => ({
      ...t,
      feedback: feedback?.slice(-1) || [],
    })),
    bound,
    nextBefore: from > 0 ? from : null,
    total: run.tasks.length,
    revision: run.revision,
  };
}
