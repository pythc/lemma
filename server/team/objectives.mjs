import { randomUUID } from "node:crypto";

// Persistent objectives describe work and evidence, never a prescribed workflow.
export const objectiveKinds = ["scope", "theorem", "lemma", "author_route"];
export function newObjective(input, actorId, parentId = null) {
  if (!input.title?.trim() || !input.description?.trim())
    throw Error("An objective needs a title and a precise description");
  if (!objectiveKinds.includes(input.kind))
    throw Error("Unknown objective kind");
  return {
    id: randomUUID(),
    version: 1,
    title: input.title,
    description: input.description,
    kind: input.kind,
    sourceSpans: input.sourceSpans || [],
    dependencies: input.dependencies || [],
    targetId: input.targetId || null,
    required: input.required !== false,
    parentId,
    ownerId: actorId,
    status: "open",
    evidenceIds: [],
    history: [],
    attempts: [],
    createdAt: new Date().toISOString(),
  };
}
export function getObjective(run, id) {
  const objective = run.objectives?.find((g) => g.id === id);
  if (!objective) throw Error("Unknown objective in this review");
  return objective;
}
export function checkObjectiveGraph(run, candidate) {
  const items = [
    ...run.objectives.filter((g) => g.id !== candidate.id),
    candidate,
  ];
  const byId = new Map(items.map((g) => [g.id, g]));
  const visit = (id, stack = new Set()) => {
    if (stack.has(id)) throw Error("Circular objective dependency");
    const g = byId.get(id);
    if (!g) throw Error("Unknown objective dependency");
    for (const d of g.dependencies) visit(d, new Set([...stack, id]));
  };
  for (const g of items) visit(g.id);
}
export function requiredObjectives(run) {
  const ids = new Set();
  const visit = (g) => {
    if (ids.has(g.id)) return;
    ids.add(g.id);
    for (const id of g.dependencies) visit(getObjective(run, id));
  };
  for (const g of run.objectives || []) if (g.required) visit(g);
  return [...ids].map((id) => getObjective(run, id));
}
export function objectiveResolved(run, goal, seen = new Set()) {
  if (seen.has(goal.id)) return false;
  if (
    !goal.dependencies.every((id) =>
      objectiveResolved(
        run,
        getObjective(run, id),
        new Set([...seen, goal.id]),
      ),
    )
  )
    return false;
  if (goal.kind === "scope")
    return (
      goal.status === "covered" &&
      (goal.dependencies.length > 0 ||
        goal.scopeDisposition === "no_mathematical_claims")
    );
  return ["proved", "refuted"].includes(goal.status);
}
export function unresolvedObjectives(run) {
  return requiredObjectives(run).filter((g) => !objectiveResolved(run, g));
}
export function invalidateObjectives(run, ids, reason) {
  const invalid = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of run.objectives || [])
      if (!invalid.has(g.id) && g.dependencies.some((d) => invalid.has(d))) {
        invalid.add(g.id);
        changed = true;
      }
  }
  for (const g of run.objectives || [])
    if (invalid.has(g.id)) {
      if (g.status !== "open")
        g.history.push({
          version: g.version,
          status: g.status,
          evidenceIds: g.evidenceIds,
          invalidatedBecause: reason,
        });
      g.status = "open";
      g.evidenceIds = [];
      g.invalidatedBecause = reason;
    }
}
const attemptKinds = new Set([
  "team:search",
  "team:premise_search",
  "team:library_discovery",
  "team:library_inspection",
  "team:library_install",
  "team:library_source",
  "team:lean",
  "team:lean_draft",
  "team:typing",
  "team:tool_failure",
  "team:workspace_check",
  "team:workspace_assembly",
  "team:experiment",
]);
export async function validateStopProposal(run, proposal, getArtifact) {
  if (
    !["goals_resolved", "no_viable_path", "external_blocked"].includes(
      proposal?.reason,
    )
  )
    throw Error(
      "Choose a stop reason; publishing a report never ends proof work",
    );
  if (!proposal.explanation?.trim())
    throw Error("Explain why the review should stop now");
  if (proposal.reason === "goals_resolved") return;
  for (const goal of unresolvedObjectives(run)) {
    const assessment = proposal.objectives?.find(
      (x) => x.objectiveId === goal.id && x.version === goal.version,
    );
    if (
      !assessment?.whyStop?.trim() ||
      !assessment.nextOptions?.trim() ||
      !assessment.attemptIds?.length
    )
      throw Error(
        `Remaining objective ${goal.id} needs actual attempts, next options and a reason to stop; limitations alone are insufficient`,
      );
    for (const id of assessment.attemptIds) {
      const artifact = await getArtifact(id);
      if (!attemptKinds.has(artifact.kind))
        throw Error(
          "A stop rationale must cite executed attempts, not only a report or plan",
        );
      if (
        artifact.kind === "team:tool_failure" &&
        ![
          "search_mathlib",
          "search_premises",
          "find_libraries",
          "inspect_library",
          "install_library",
          "prepare_modules",
          "read_library",
          "check_lean",
          "lean_draft",
          "inspect_target",
          "workspace_check",
          "check_workspace_target",
          "plan_lemmas",
          "check_lemma",
          "assemble_lemmas",
          "run_python",
        ].includes(artifact.payload.result.name)
      )
        throw Error(
          "Stopping requires a mathematical or resource attempt, not an orchestration argument error",
        );
    }
  }
}
export async function validateObjectiveDecisions({
  run,
  submission,
  decision,
  actor,
  getArtifact,
  getTarget,
}) {
  const updates = [];
  for (const item of decision.objectiveDecisions || []) {
    const goal = getObjective(run, item.objectiveId);
    if (
      !submission.objectiveIds?.includes(goal.id) ||
      submission.objectiveVersions[goal.id] !== goal.version ||
      item.version !== goal.version
    )
      throw Error(
        "Objective decision must refer to the submitted current version",
      );
    if (updates.some((x) => x.objectiveId === goal.id))
      throw Error("Duplicate objective decision");
    if (!item.explanation?.trim())
      throw Error("Objective assessment needs a source and scope explanation");
    if (!["continue", "covered", "proved", "refuted"].includes(item.outcome))
      throw Error("Unknown objective outcome");
    if (["proved", "refuted"].includes(item.outcome)) {
      if (goal.kind === "scope" || !goal.targetId)
        throw Error(
          "Bind the exact formal target before claiming proof completion",
        );
      const target = getTarget(goal.targetId);
      if (target.supersededBy)
        throw Error("Objective uses a superseded formal target");
      const mode = item.outcome === "refuted" ? "counterexample" : "proof";
      let fresh = false;
      for (const id of item.evidenceIds || []) {
        const a = await getArtifact(id),
          p = a.payload.result;
        if (
          ["team:lean", "team:lean_reuse"].includes(a.kind) &&
          a.payload.actorId === actor.id &&
          p.targetId === goal.targetId &&
          p.mode === mode &&
          p.result.status === "verified" &&
          p.result.targetHash === target.contract.targetHash &&
          (decision.replayIds || []).includes(id)
        )
          fresh = true;
      }
      if (!fresh)
        throw Error(
          "Objective completion requires this acceptance Agent's fresh exact-target Lean check",
        );
      if (
        typeof item.sourceAssessment !== "string" ||
        !item.sourceAssessment.trim()
      )
        throw Error(
          "Record independent source fidelity assessment separately from kernel success",
        );
      if (goal.kind === "author_route") {
        if (
          submission.resultKind !== "author_route" ||
          !submission.targetIds.includes(goal.targetId)
        )
          throw Error(
            "Author route objective requires an explicit route submission and root check",
          );
      }
    }
    if (item.outcome === "covered") {
      if (
        goal.kind !== "scope" ||
        (!goal.dependencies.length &&
          item.scopeDisposition !== "no_mathematical_claims") ||
        typeof item.sourceAssessment !== "string" ||
        !item.sourceAssessment.trim()
      )
        throw Error(
          "Coverage assessment needs an explicit source-grounded scope and its dependent objectives",
        );
    }
    updates.push(item);
  }
  return updates;
}
