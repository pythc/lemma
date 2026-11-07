import { readFile } from "node:fs/promises";
import path from "node:path";
import { digest, sha256 } from "./evidence.mjs";
import { contentTree } from "./toolchain-tree.mjs";
import { ANCHORED_AUDIT_PROTOCOL } from "./audit-wire.mjs";

export const EVALUATION_CODE_PATHS = [
  "server",
  "shared",
  "worker",
  "scripts",
  "tests",
  "package.json",
  "package-lock.json",
  "evaluation",
];
export const SEMANTIC_THRESHOLDS = Object.freeze({
  denominator: 60,
  firstPassComplete: 57,
  complete: 57,
  faithfulAccepted: 27,
  falseAccepted: 0,
  ambiguityFalselyCleared: 0,
  unknownCorrect: 11,
});
const stop = (message) =>
  Object.assign(new Error(message), {
    evaluationStop: "evaluation_registration_changed_or_invalid",
  });

export function validateSemanticDataset(dataset, gold, development) {
  const cases = dataset?.cases,
    labels = gold?.labels;
  if (
    !Array.isArray(cases) ||
    !Array.isArray(labels) ||
    cases.length !== (development ? 6 : 20) ||
    labels.length !== cases.length
  )
    throw stop(
      "Expected six boundary cases or twenty formal cases and matching labels",
    );
  const ids = new Set(cases.map((c) => c.id));
  if (
    ids.size !== cases.length ||
    cases.some((c) => typeof c.id !== "string" || !c.id) ||
    new Set(labels.map((l) => l.caseId)).size !== labels.length ||
    labels.some(
      (l) =>
        !ids.has(l.caseId) ||
        !["accept", "reject", "unknown"].includes(l.expectation),
    )
  )
    throw stop("Evaluation case identity or labels are invalid");
  for (const c of cases) {
    if (
      !Array.isArray(c.pages) ||
      !c.pages.length ||
      new Set(c.pages.map((p) => p.pageIndex)).size !== c.pages.length ||
      c.pages.some(
        (p) =>
          !Number.isInteger(p.pageIndex) ||
          p.pageIndex < 0 ||
          typeof p.text !== "string",
      ) ||
      typeof c.quote !== "string" ||
      !c.quote ||
      typeof c.candidate !== "string" ||
      !c.candidate ||
      !c.pages.find((p) => p.pageIndex === c.pageIndex)?.text.includes(c.quote)
    )
      throw stop("Evaluation source locator or pages are invalid");
  }
  if (digest(gold.thresholds) !== digest(SEMANTIC_THRESHOLDS))
    throw stop("The original six formal thresholds must remain unchanged");
  if (!development) {
    const counts = Object.fromEntries(
      ["accept", "reject", "unknown"].map((k) => [
        k,
        labels.filter((l) => l.expectation === k).length,
      ]),
    );
    if (counts.accept !== 10 || counts.reject !== 6 || counts.unknown !== 4)
      throw stop("Formal label partition must be 10/6/4");
    if (
      dataset.exposure !==
      "frozen_internal_evaluation_not_used_for_prompt_tuning"
    )
      throw stop(
        "Formal evaluation requires explicit internal-data exposure provenance",
      );
  }
}

export async function semanticRegistration({
  datasetPath,
  development,
  config,
  root = process.cwd(),
}) {
  if (!datasetPath) throw stop("Explicit evaluation dataset required");
  const directory = path.resolve(root, datasetPath);
  const [inputs, labels] = await Promise.all([
    readFile(path.join(directory, "inputs.json")),
    readFile(path.join(directory, "evaluator-gold.json")),
  ]);
  const dataset = JSON.parse(inputs),
    gold = JSON.parse(labels);
  validateSemanticDataset(dataset, gold, development);
  return {
    schemaVersion: "lemma.semantic-registration.v1",
    datasetPath: directory,
    datasetSha256: sha256(inputs),
    goldSha256: sha256(labels),
    implementation: await contentTree(root, EVALUATION_CODE_PATHS),
    // A digest binds the exact loaded configuration without exporting secrets.
    configurationHash: digest(config),
    protocol: ANCHORED_AUDIT_PROTOCOL,
    mode: development ? "development" : "run",
    caseCount: dataset.cases.length,
    repetitions: development ? 1 : 3,
    baselineCap: development ? 12 : 120,
    repairCap: development ? 0 : 8,
    thresholds: SEMANTIC_THRESHOLDS,
    secondFamily: "not_accepted",
    independentExpertLabels: false,
  };
}

export async function registeredSemanticGuard({
  registrationPath,
  expected,
  config,
  root = process.cwd(),
}) {
  if (!registrationPath)
    throw stop("A preflight registration is required before dispatch");
  const original = await readFile(registrationPath);
  if (digest(JSON.parse(original)) !== digest(expected))
    throw stop(
      "Current inputs, configuration or implementation do not match preregistration",
    );
  return {
    async assertCurrent() {
      try {
        const current = await semanticRegistration({
          datasetPath: expected.datasetPath,
          development: expected.mode === "development",
          config,
          root,
        });
        if (
          sha256(await readFile(registrationPath)) !== sha256(original) ||
          digest(current) !== digest(expected)
        )
          throw stop(
            "Evaluation changed after preregistration; request not sent",
          );
      } catch (error) {
        if (error.evaluationStop) throw error;
        throw Object.assign(
          stop("Evaluation registration cannot be verified; request not sent"),
          { cause: error },
        );
      }
    },
  };
}
