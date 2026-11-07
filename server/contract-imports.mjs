import { validateContract } from "./contracts.mjs";
import { domainImports } from "./domain-schema.mjs";
import { digest, isHash } from "./evidence.mjs";
import {
  MATHLIB_COMMIT,
  profileForContract,
} from "../shared/library-profiles.mjs";

const domainBody = (contract) => {
  const { modules, ...math } = contract.domainContext || {
    schemaVersion: "lemma.domain.v1",
    revision: MATHLIB_COMMIT,
    definitions: [],
    lemmas: [],
  };
  return math;
};
const stable = (contract) => {
  const {
    targetHash,
    schemaVersion,
    imports,
    externalLibraries,
    executionEnvironment,
    libraryRevision,
    domainArtifact,
    domainContext,
    ...body
  } = contract;
  return { ...body, domainContext: domainBody(contract) };
};
// Structural scope invariant, not a kernel proof of semantic equivalence.
// Every candidate and assembled root still requires a fresh native check.
export function sameContractMathematics(before, after) {
  validateContract(before);
  validateContract(after);
  if (digest(stable(before)) !== digest(stable(after))) return false;
  const nextModules = new Map(
    (after.domainContext?.modules || []).map((m) => [m.name, m]),
  );
  return (before.domainContext?.modules || []).every(
    (m) =>
      nextModules.has(m.name) && digest(m) === digest(nextModules.get(m.name)),
  );
}
export function withPinnedMathlibModules(contract, modules, artifact) {
  validateContract(contract);
  if (contract.executionEnvironment)
    throw Error(
      "Cannot transplant Mathlib modules into an unported sealed environment",
    );
  if (
    !isHash(contract.contextArtifact) ||
    !isHash(contract.translationArtifact) ||
    !isHash(artifact)
  )
    throw Error(
      "Mathlib import extension requires fixed context, translation and environment receipts",
    );
  const domainContext = {
    ...(contract.domainContext || {
      schemaVersion: "lemma.domain.v1",
      revision: MATHLIB_COMMIT,
      definitions: [],
      lemmas: [],
    }),
    modules,
  };
  const { targetHash, ...body } = contract;
  const next = {
    ...body,
    schemaVersion: contract.externalLibraries?.length
      ? "lemma.contract.v5"
      : "lemma.contract.v4",
    domainContext,
    domainArtifact: artifact,
    imports: [
      ...domainImports(profileForContract(contract), domainContext),
      ...(contract.externalLibraries || []).flatMap((e) => e.modules),
    ],
  };
  const result = validateContract({ ...next, targetHash: digest(next) });
  if (!sameContractMathematics(contract, result))
    throw Error("Mathlib imports changed the fixed mathematical scope");
  return result;
}
