import { digest, isHash } from "./evidence.mjs";
import { validateSplits } from "./evaluation.mjs";

const INPUT_KEYS = {
  semantic: ["source", "candidate", "definitions", "extraction"],
  formal: ["formalStatement", "header", "helper", "leanVersion"],
  paper: ["pdfSha256", "pdfFile", "scope"],
};
const STATUSES = new Set(["accepted", "rejected", "unknown", "error", "timeout", "not_run"]);
export function validateDataset(dataset) {
  if (dataset?.schemaVersion !== "lemma.evaluation-set.v1" || !Array.isArray(dataset.cases) || !dataset.cases.length)
    throw Error("Invalid evaluation set");
  validateSplits(dataset.cases);
  for (const c of dataset.cases) {
    if (!INPUT_KEYS[c.layer] || !["authored_regression", "upstream_reference", "research_candidate"].includes(c.origin) ||
      !c.provenance?.revision || !c.provenance?.url || !["unknown", "private_unpublished", "known_exposed"].includes(c.contamination))
      throw Error(`Incomplete evaluation provenance: ${c.id}`);
    evaluationInput(c);
  }
  return dataset;
}
// Deliberately construct a new object. A full dataset row or evaluator gold is
// never used as the model input, even when a caller adds another private field.
export function evaluationInput(c) {
  const allowed = INPUT_KEYS[c.layer];
  if (!allowed || !c.input || Object.keys(c.input).some((key) => !allowed.includes(key)))
    throw Error(`Answer or unsupported field in tested input: ${c.id}`);
  if (c.layer === "semantic" && (typeof c.input.source !== "string" || typeof c.input.candidate !== "string"))
    throw Error("Semantic inputs require source and a candidate, no translator rationale");
  if (c.layer === "formal" && (!c.input.formalStatement || c.input.formalStatement.includes("sorry")))
    throw Error("Formal task must contain the statement only, without its placeholder proof");
  if (c.layer === "paper" && (!isHash(c.input.pdfSha256) || !c.input.pdfFile || !c.input.scope))
    throw Error("Paper task requires raw PDF identity and natural-language scope");
  return Object.fromEntries(allowed.filter((k) => Object.hasOwn(c.input, k)).map((k) => [k, structuredClone(c.input[k])]));
}
export function createExperiment(dataset, { model, budget, implementation, protocol }) {
  validateDataset(dataset);
  if (!model?.name || !budget || !implementation || !protocol) throw Error("Experiment configuration is incomplete");
  const configuration = {
    dataset: digest(dataset), model: { name: model.name, endpointHost: model.endpointHost || null,
      family: model.family || "unknown", familyEvidence: model.familyEvidence || "not_verified",
      reasoningEffort: model.reasoningEffort || null, temperature: model.temperature ?? null,
      revision: model.revision || "provider_revision_not_reported" },
    budget: structuredClone(budget), implementation, protocol,
  };
  return { schemaVersion: "lemma.experiment.v1", id: digest(configuration), configuration };
}
export function summarizeExperiment(dataset, gold, rows, experiment) {
  validateDataset(dataset);
  if (experiment.configuration.dataset !== digest(dataset)) throw Error("Experiment dataset changed");
  const cases = new Map(dataset.cases.map((c) => [c.id, c])), received = new Map();
  for (const r of rows) {
    if (!cases.has(r.caseId) || received.has(r.caseId) || !STATUSES.has(r.status) || r.experimentId !== experiment.id)
      throw Error("Result identity/status/experiment mismatch or duplicate");
    received.set(r.caseId, r);
  }
  const labels = new Map();
  for (const g of gold) {
    if (!cases.has(g.caseId) || labels.has(g.caseId) || !["accept", "reject", "unlabelled"].includes(g.expectation) ||
      !["authored", "upstream_only", "independently_reviewed", "unlabelled"].includes(g.status))
      throw Error("Gold annotation identity or status invalid");
    labels.set(g.caseId, g);
  }
  const completeRows = dataset.cases.map((c) => received.get(c.id) ||
    { caseId: c.id, experimentId: experiment.id, status: "not_run", reason: "No execution receipt" });
  const keys = [...new Set(dataset.cases.map((c) => `${c.layer}/${c.origin}/${c.split}`))];
  const groups = keys.map((key) => {
    const selected = completeRows.filter((r) => {
      const c = cases.get(r.caseId);
      return `${c.layer}/${c.origin}/${c.split}` === key;
    });
    const known = selected.filter((r) => ["accept", "reject"].includes(labels.get(r.caseId)?.expectation));
    const negative = known.filter((r) => labels.get(r.caseId).expectation === "reject");
    const positive = known.filter((r) => labels.get(r.caseId).expectation === "accept");
    const falseAccepts = negative.filter((r) => r.status === "accepted").length;
    const falseRejects = positive.filter((r) => r.status === "rejected").length;
    const unknownReasons = {};
    for (const r of selected.filter((r) => !["accepted", "rejected"].includes(r.status))) {
      const reason = r.reason || r.status;
      unknownReasons[reason] = (unknownReasons[reason] || 0) + 1;
    }
    const exactTargets = selected.filter((r) => r.nativeTheoremVerified === true).length;
    const sourceRoutes = selected.filter((r) => r.nativeSourceRouteVerified === true).length;
    return {
      group: key, denominator: selected.length,
      statuses: Object.fromEntries([...STATUSES].map((s) => [s, selected.filter((r) => r.status === s).length])),
      goldPositives: positive.length, goldNegatives: negative.length,
      falseAccepts, falseRejects,
      falseAcceptanceRate: negative.length ? falseAccepts / negative.length : null,
      falseRejectionRate: positive.length ? falseRejects / positive.length : null,
      resolvedCoverage: selected.filter((r) => ["accepted", "rejected"].includes(r.status)).length / selected.length,
      unknownReasons, nativeExactTargets: exactTargets, nativeSourceRoutes: sourceRoutes,
      elapsedMs: selected.reduce((n, r) => n + (r.elapsedMs || 0), 0),
      cost: selected.every((r) => typeof r.cost === "number") ? selected.reduce((n, r) => n + r.cost, 0) : null,
      usageReportedCases: selected.filter((r) => r.usage != null).length,
      independentlyReviewed: selected.filter((r) => labels.get(r.caseId)?.status === "independently_reviewed").length,
      researchAccuracy: null,
    };
  });
  return { schemaVersion: "lemma.evaluation-report.v1", experiment, groups, rows: completeRows,
    caveat: "Engineering diagnostics and upstream reference labels are not independently annotated research accuracy. Public training exposure is unknown." };
}
export function compareExperiments(before, after) {
  const a = before.experiment.configuration, b = after.experiment.configuration;
  if (a.dataset !== b.dataset || digest(a.budget) !== digest(b.budget) || a.protocol !== b.protocol)
    throw Error("Different dataset, budget or protocol: results must not be compared as one experiment");
  const old = new Map(before.rows.map((r) => [r.caseId, r]));
  return {
    before: before.experiment.id, after: after.experiment.id,
    changedFactors: ["model", "implementation"].filter((k) => digest(a[k]) !== digest(b[k])),
    paired: after.rows.map((r) => ({ caseId: r.caseId, before: old.get(r.caseId)?.status || "not_run", after: r.status })),
    crossFamilyValidated: a.model.family !== "unknown" && b.model.family !== "unknown" &&
      a.model.family !== b.model.family && a.model.familyEvidence === "verified" && b.model.familyEvidence === "verified",
  };
}
