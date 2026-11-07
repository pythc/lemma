import { randomUUID } from "node:crypto";
import { isId } from "./evidence.mjs";

export const freshProofSession = () => ({
  schemaVersion: "lemma.proof-autonomy.v1",
  policy: "fresh_agent_only",
  sessionId: randomUUID(),
  historicalProofs: "excluded",
  externalProofSeeds: "rejected",
});

export function assertProofSession(
  autonomy,
  { seedGraph, resume, repairFrom, theoremCandidate } = {},
) {
  if (!autonomy) return;
  if (
    autonomy.schemaVersion !== "lemma.proof-autonomy.v1" ||
    autonomy.policy !== "fresh_agent_only" ||
    !isId(autonomy.sessionId)
  )
    throw Error("Invalid autonomous proof session");
  if (seedGraph || theoremCandidate)
    throw Error(
      "Fresh autonomous reviews reject supplied proof graphs and theorem candidates",
    );
  for (const previous of [resume, repairFrom].filter(Boolean))
    if (
      previous.autonomy?.sessionId !== autonomy.sessionId ||
      previous.autonomy?.policy !== autonomy.policy
    )
      throw Error(
        "Fresh autonomous review cannot inherit another session's proofs",
      );
}

export const sameProofSession = (entry, autonomy) =>
  !autonomy || entry.branch?.autonomySession === autonomy.sessionId;
