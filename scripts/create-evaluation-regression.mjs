import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { digest, sha256 } from "../server/evidence.mjs";
import { validateDataset } from "../server/evaluation-protocol.mjs";
const rows = [
  ["square-faithful", "square", "Every real number x satisfies x squared greater than or equal to zero.", "∀ x : ℝ, 0 ≤ x ^ 2", "accept", "Original universal claim"],
  ["square-exists", "square", "Every real number x satisfies x squared greater than or equal to zero.", "∃ x : ℝ, 0 ≤ x ^ 2", "reject", "Universal quantifier weakened to existence"],
  ["square-domain", "square", "Every real number x satisfies x squared greater than or equal to zero.", "∀ x : ℕ, 0 ≤ x ^ 2", "reject", "Real domain narrowed to natural numbers"],
  ["commute-faithful", "addition", "For all real numbers x and y, x plus y equals y plus x.", "∀ x y : ℝ, x + y = y + x", "accept", "Faithful statement"],
  ["commute-vacuous", "addition", "For all real numbers x and y, x plus y equals y plus x.", "∀ x y : ℝ, False → x + y = y + x", "reject", "False assumption inserted"],
  ["strict-silent-fix", "strict-square", "For every real number x, x squared is strictly greater than zero.", "∀ x : ℝ, 0 ≤ x ^ 2", "reject", "False source silently repaired to a true non-strict statement"],
  ["strict-faithful-false", "strict-square", "For every real number x, x squared is strictly greater than zero.", "∀ x : ℝ, 0 < x ^ 2", "accept", "Faithful translation of a false source is semantically aligned; theorem truth is separate"],
  ["sqrt-assumption", "sqrt", "For every nonnegative real number x, the square of its square root equals x.", "∀ x : ℝ, Real.sqrt x ^ 2 = x", "reject", "Nonnegative premise removed"],
  ["conjugate-missing", "conjugate", "For every complex number z, z times its complex conjugate equals its squared norm.", "∀ z : ℂ, z * z = (‖z‖ ^ 2 : ℝ)", "reject", "Complex conjugation omitted"],
];
const dataset = { schemaVersion: "lemma.evaluation-set.v1", name: "Authored semantic and execution diagnostics", cases: [] };
const gold = [];
for (const [id, family, source, candidate, expected, rationale] of rows) {
  const caseId = `authored/${id}`;
  dataset.cases.push({ id: caseId, family: `authored/${family}`, split: family === "conjugate" ? "holdout" : "development",
    layer: "semantic", origin: "authored_regression", contamination: "private_unpublished",
    provenance: { url: "local:authored-evaluation-regression", revision: "v1" },
    input: { source, candidate } });
  gold.push({ caseId, expectation: expected, status: "authored", rationale });
}
const fixture = JSON.parse(await readFile(new URL("../fixtures/analysis-cases.json", import.meta.url), "utf8"));
for (const [n, item] of fixture.cases.entries()) {
  const id = `authored/formal/${n}`;
  dataset.cases.push({ id, family: "authored/analysis-fixtures", split: "development", layer: "formal",
    origin: "authored_regression", contamination: "known_exposed",
    provenance: { url: "local:fixtures/analysis-cases.json", revision: digest(fixture) },
    input: { formalStatement: item.leanTarget, header: fixture.libraryProfile, leanVersion: "4.35.0" } });
  gold.push({ caseId: id, expectation: item.expected === "formalized_proved" ? "accept" : "unlabelled",
    status: "authored", referenceProof: item.proof, proofMode: item.proofMode || "proof" });
}
const pdf = await readFile(new URL("../public/analysis-fixtures.pdf", import.meta.url));
dataset.cases.push({ id: "authored/paper/analysis-fixtures", family: "authored/analysis-fixtures",
  split: "development", layer: "paper", origin: "authored_regression", contamination: "known_exposed",
  provenance: { url: "local:public/analysis-fixtures.pdf", revision: sha256(pdf) },
  input: { pdfSha256: sha256(pdf), pdfFile: "public/analysis-fixtures.pdf",
    scope: "请阅读 PDF 中的数学命题与论证，自主选择一个命题核查，区分原文语义、原证明路线和形式目标是否通过。" } });
gold.push({ caseId: "authored/paper/analysis-fixtures", expectation: "unlabelled", status: "unlabelled" });
validateDataset(dataset);
const out = path.resolve(process.argv[2] || "evaluation/sets/authored-regression");
await mkdir(path.dirname(out), { recursive: true });
await mkdir(out, { recursive: false });
await writeFile(path.join(out, "inputs.json"), JSON.stringify(dataset, null, 2));
await writeFile(path.join(out, "evaluator-gold.json"), JSON.stringify(gold, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ out, cases: dataset.cases.length, layers: [...new Set(dataset.cases.map((c) => c.layer))] }));
