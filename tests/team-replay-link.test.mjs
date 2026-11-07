import test from "node:test";
import assert from "node:assert/strict";
import {
  validateObjectiveDecisions,
  newObjective,
} from "../server/team/objectives.mjs";
test("the exact accepted proof receipt must be present in the replay list", async () => {
  const g = newObjective(
    { kind: "theorem", title: "T", description: "T", targetId: "t" },
    "worker",
  );
  const a = {
    run: { objectives: [g] },
    submission: { objectiveIds: [g.id], objectiveVersions: { [g.id]: 1 } },
    decision: {
      replayIds: ["other"],
      objectiveDecisions: [
        {
          objectiveId: g.id,
          version: 1,
          outcome: "proved",
          explanation: "x",
          sourceAssessment: "source",
          evidenceIds: ["proof", "other"],
        },
      ],
    },
    actor: { id: "reviewer" },
    getTarget: () => ({ contract: { targetHash: "hash" } }),
    getArtifact: async (id) => ({
      kind: "team:lean",
      payload: {
        actorId: "reviewer",
        result: {
          targetId: "t",
          mode: "proof",
          result: {
            status: id === "proof" ? "verified" : "not_verified",
            targetHash: "hash",
          },
        },
      },
    }),
  };
  await assert.rejects(validateObjectiveDecisions(a), /fresh exact/);
  a.decision.replayIds = ["proof"];
  await validateObjectiveDecisions(a);
});
