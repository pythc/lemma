import { mkdir, writeFile, readFile } from "node:fs/promises";
import {
  cases,
  laterDomainCases,
  semanticCases,
  researchCandidates,
} from "../fixtures/capability-cases.mjs";
import { validateSplits, summarizeEvaluation } from "../server/evaluation.mjs";
import { checkProof } from "../server/lean.mjs";
import { createContract } from "../server/contracts.mjs";
import { structuralConcerns } from "../server/semantics.mjs";
import { sha256, digest } from "../server/evidence.mjs";
const allCases = [...cases, ...laterDomainCases];
validateSplits(allCases);
const filter = process.argv.find((a) => a.startsWith("--case="))?.slice(7);
if (filter && !allCases.some((c) => c.id === filter))
  throw new Error("Unknown case");
const onlyLater = process.argv.includes("--later-domains");
const selected = allCases.filter(
    (c) =>
      (!filter || c.id === filter) &&
      (!onlyLater || c.libraryProfile !== "analysis-continuity-v1"),
  ),
  rows = [];
await mkdir("evidence/capability-evaluation", { recursive: true });
const implementation = {};
for (const file of [
  "server/pipeline.mjs",
  "server/evaluation.mjs",
  "server/repair.mjs",
  "server/review-evidence.mjs",
  "server/model.mjs",
  "server/contracts.mjs",
  "server/semantics.mjs",
  "server/context.mjs",
  "server/lean.mjs",
  "server/lean-query.mjs",
  "server/knowledge.mjs",
  "shared/knowledge-catalog.mjs",
  "shared/library-profiles.mjs",
  "fixtures/capability-cases.mjs",
])
  implementation[file] = sha256(await readFile(file));
for (const c of selected) {
  const source = {
    paperSha256: sha256(c.quote),
    pageIndex: 0,
    artifact: digest({ source: c.quote }),
    text: c.quote,
  };
  const contract = createContract(
    source,
    { ...c, label: c.id },
    c.libraryProfile,
  );
  const start = Date.now();
  const check = await checkProof(contract, c.proof, { mode: c.mode });
  const row = {
    id: c.id,
    family: c.family,
    split: c.split,
    sourceKind: c.sourceKind,
    referenceReview: c.referenceReview,
    contract,
    mode: c.mode,
    expected: c.expected,
    matchesReference: check.status === c.expected,
    elapsedMs: Date.now() - start,
    check,
  };
  rows.push(row);
  await writeFile(
    `evidence/capability-evaluation/${c.id}.json`,
    JSON.stringify(row, null, 2),
  );
  console.log(
    JSON.stringify({
      id: c.id,
      status: check.status,
      expected: c.expected,
      matchesReference: row.matchesReference,
      elapsedMs: row.elapsedMs,
    }),
  );
}
const semanticRows = semanticCases.map((c) => ({
  id: c.id,
  expectedConcern: c.expectedConcern,
  labelKind: c.labelKind,
  issues: structuralConcerns(c.source),
}));
const report = {
  schemaVersion: "lemma.capability-evaluation.v1",
  recordedAt: new Date().toISOString(),
  implementation,
  summary: summarizeEvaluation(rows, semanticRows, researchCandidates),
  rows: rows.map(({ check, ...row }) => ({
    ...row,
    checkStatus: check.status,
    evidence: `capability-evaluation/${row.id}.json`,
  })),
  semanticRows,
  researchCandidates,
};
const filename = filter
  ? `evidence/capability-evaluation-${filter}.json`
  : onlyLater
    ? "evidence/capability-evaluation-later-domains.json"
    : "evidence/capability-evaluation-summary.json";
const changed = [];
for (const [file, hash] of Object.entries(implementation))
  if (sha256(await readFile(file)) !== hash) changed.push(file);
report.changedDuringRun = changed;
report.summary.currentImplementation = changed.length === 0;
await writeFile(filename, JSON.stringify(report, null, 2));
if (
  changed.length ||
  rows.some((r) => !r.matchesReference) ||
  semanticRows.some((r) => !!r.issues.length !== r.expectedConcern)
)
  process.exitCode = 1;
console.log(JSON.stringify(report.summary));
