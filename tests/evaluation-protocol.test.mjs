import test from "node:test";
import assert from "node:assert/strict";
import { validateDataset, evaluationInput, createExperiment, summarizeExperiment, compareExperiments } from "../server/evaluation-protocol.mjs";
const make = () => ({ schemaVersion: "lemma.evaluation-set.v1", cases: [0, 1, 2, 3].map((n) => ({
  id: `case-${n}`, family: `family-${n}`, split: "development", layer: "semantic",
  origin: "authored_regression", contamination: "unknown",
  provenance: { url: "local:authored", revision: "v1" },
  input: { source: "Every real number has a nonnegative square.", candidate: "∀ x : ℝ, 0 ≤ x ^ 2" },
})) });
const experiment = (d) => createExperiment(d, { model: { name: "fixture" },
  budget: { calls: 4 }, implementation: "fixture-v1", protocol: "blind-v1" });
test("input boundary rejects answer fields and raw-paper hints; family leakage is fatal", () => {
  const d = make();
  d.cases[1].family = d.cases[0].family;
  d.cases[1].split = "holdout";
  assert.throws(() => validateDataset(d), /家族/);
  const c = make().cases[0];
  c.gold = "Never sent";
  assert.deepEqual(Object.keys(evaluationInput(c)), ["source", "candidate"]);
  c.input.referenceProof = "leak";
  assert.throws(() => evaluationInput(c), /Answer/);
  assert.throws(() => evaluationInput({ id: "paper", layer: "paper",
    input: { pdfSha256: "a".repeat(64), pdfFile: "paper.pdf", scope: "Review", target: "LEAK" } }), /Answer/);
});
test("unknown, errors and unexecuted cases remain in denominator; absent cost is not zero", () => {
  const d = make(), e = experiment(d);
  const gold = d.cases.map((c, n) => ({ caseId: c.id, expectation: n === 0 ? "reject" : "accept", status: "authored" }));
  const rows = ["accepted", "error", "timeout"].map((status, n) => ({
    caseId: d.cases[n].id, status, experimentId: e.id,
  }));
  const report = summarizeExperiment(d, gold, rows, e), g = report.groups[0];
  assert.equal(g.denominator, 4);
  assert.equal(g.falseAccepts, 1);
  assert.equal(g.falseAcceptanceRate, 1);
  assert.equal(g.resolvedCoverage, 0.25);
  assert.equal(g.statuses.not_run, 1);
  assert.equal(g.cost, null);
  assert.equal(g.researchAccuracy, null);
  assert.throws(() => summarizeExperiment(d, gold, [...rows, rows[0]], e), /duplicate/);
  const changed = structuredClone(report);
  changed.experiment.configuration.budget.calls = 5;
  assert.throws(() => compareExperiments(report, changed), /budget/);
  assert.equal(compareExperiments(report, report).crossFamilyValidated, false);
});
