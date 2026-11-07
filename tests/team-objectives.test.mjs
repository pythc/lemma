import test from "node:test";
import assert from "node:assert/strict";
import {
  newObjective,
  checkObjectiveGraph,
  objectiveResolved,
  invalidateObjectives,
  validateStopProposal,
  validateObjectiveDecisions,
} from "../server/team/objectives.mjs";
import { selectSearchCandidates } from "../server/domain-library.mjs";
import { rankPremiseDeclarations } from "../server/premise-index.mjs";
test("resolved helper cannot close missing dependencies; revisions invalidate transitive acceptance", () => {
  const lemma = newObjective(
      { kind: "lemma", title: "L", description: "L" },
      "actor",
    ),
    root = newObjective(
      {
        kind: "theorem",
        title: "T",
        description: "T",
        dependencies: [lemma.id],
      },
      "actor",
    ),
    scope = newObjective(
      { kind: "scope", title: "S", description: "S", dependencies: [root.id] },
      "actor",
    );
  const run = { objectives: [lemma, root, scope] };
  root.status = "proved";
  scope.status = "covered";
  assert.equal(objectiveResolved(run, scope), false);
  lemma.status = "proved";
  assert.equal(objectiveResolved(run, scope), true);
  invalidateObjectives(run, [lemma.id], "Target revised");
  assert.deepEqual(
    run.objectives.map((g) => g.status),
    ["open", "open", "open"],
  );
  assert.throws(
    () => checkObjectiveGraph(run, { ...lemma, dependencies: [root.id] }),
    /Circular/,
  );
});
test("reports and orchestration errors are not executed proof attempts for stopping", async () => {
  const g = newObjective(
      { kind: "scope", title: "Scope", description: "Scope" },
      "a",
    ),
    run = { objectives: [g] };
  const proposal = {
    reason: "no_viable_path",
    explanation: "No path",
    objectives: [
      {
        objectiveId: g.id,
        version: 1,
        attemptIds: ["receipt"],
        whyStop: "Failed",
        nextOptions: "Try later",
      },
    ],
  };
  await assert.rejects(
    validateStopProposal(run, proposal, async () => ({ kind: "team:draft" })),
    /executed/,
  );
  await assert.rejects(
    validateStopProposal(run, proposal, async () => ({
      kind: "team:tool_failure",
      payload: { result: { name: "finish_review" } },
    })),
    /orchestration/,
  );
  proposal.objectives[0].version = 2;
  await assert.rejects(
    validateStopProposal(run, proposal, async () => ({ kind: "team:lean" })),
    /actual attempts/,
  );
});
test("a typing probe and a different actor certificate cannot close an objective", async () => {
  const g = newObjective(
      { kind: "theorem", title: "T", description: "T", targetId: "t" },
      "worker",
    ),
    run = { objectives: [g] };
  const item = {
    objectiveId: g.id,
    version: 1,
    outcome: "proved",
    explanation: "Checked",
    sourceAssessment: "Read source",
    evidenceIds: ["proof"],
  };
  const receipt = {
    kind: "team:typing",
    payload: {
      actorId: "acceptance",
      result: {
        targetId: "t",
        mode: "proof",
        result: { status: "verified", targetHash: "hash" },
      },
    },
  };
  const args = {
    run,
    submission: { objectiveIds: [g.id], objectiveVersions: { [g.id]: 1 } },
    decision: { objectiveDecisions: [item], replayIds: ["proof"] },
    actor: { id: "acceptance" },
    getTarget: () => ({ contract: { targetHash: "hash" } }),
    getArtifact: async () => receipt,
  };
  await assert.rejects(validateObjectiveDecisions(args), /fresh exact/);
  receipt.kind = "team:lean";
  receipt.payload.actorId = "worker";
  await assert.rejects(validateObjectiveDecisions(args), /fresh exact/);
  receipt.payload.actorId = "acceptance";
  await validateObjectiveDecisions(args);
  g.version++;
  await assert.rejects(validateObjectiveDecisions(args), /current version/);
});
test("literal and ranked search retain later candidates from one file across pages", () => {
  const candidates = Array.from({ length: 11 }, (_, i) => ({
    file: "Mathlib/Test.lean",
    line: i + 1,
    snippet: `theorem target_${i} : True`,
  }));
  const groups = [{ query: "target", candidates }];
  const first = selectSearchCandidates(groups, 4, 0),
    second = selectSearchCandidates(groups, 4, 4),
    third = selectSearchCandidates(groups, 4, 8);
  assert.equal(first.truncated, true);
  assert.equal(second.selected.length, 4);
  assert.equal(third.truncated, false);
  assert.equal(
    new Set(
      [...first.selected, ...second.selected, ...third.selected].map(
        (c) => c.line,
      ),
    ).size,
    11,
  );
  const ranked = rankPremiseDeclarations(
    candidates.map((c) => ({ ...c, name: "target_" + c.line })),
    ["target"],
    "",
    20,
  );
  assert.equal(ranked.length, 11);
});
