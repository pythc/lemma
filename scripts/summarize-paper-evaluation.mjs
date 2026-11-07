// Import a completed raw-PDF execution into the paper layer without turning
// a completed agent task or a local theorem into whole-paper acceptance.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { digest, inspectBundle, sha256 } from "../server/evidence.mjs";
import { readEvidenceFile } from "../server/evidence-io.mjs";
import { validateDataset, createExperiment, summarizeExperiment } from "../server/evaluation-protocol.mjs";

const [directory, setDirectory, caseId, output] = process.argv.slice(2);
if (!directory || !setDirectory || !caseId || !output)
  throw Error("Usage: node scripts/summarize-paper-evaluation.mjs run-directory set-directory case-id NEW-report.json");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const input = await json(path.join(directory, "acceptance-input.json"));
const result = await json(path.join(directory, "result.json"));
const run = await json(path.join(directory, "run.json"));
const dataset = validateDataset(await json(path.join(setDirectory, "inputs.json")));
const selected = dataset.cases.find((c) => c.id === caseId && c.layer === "paper");
if (!selected || selected.input.pdfSha256 !== input.paperSha256 ||
  selected.input.scope !== input.reviewIntent || result.paperSha256 !== input.paperSha256 ||
  result.implementationChangedDuringRun.length ||
  [input.historicalArtifactsImported, input.suppliedProofs, input.suppliedLeanTargets, input.suppliedProofGraphs].some((v) => v !== 0))
  throw Error("Raw-paper input, isolation or implementation identity is inconsistent");
const bundle = await readEvidenceFile(path.join(directory, "bundle.ndjson"));
inspectBundle(bundle, run.root);
const models = new Set(), hosts = new Set();
for (const a of bundle.artifacts) {
  const record = a.kind === "harness:model" ? a.payload : a.payload.model;
  if (!record?.model) continue;
  models.add(record.model);
  if (record.endpoint) hosts.add(new URL(record.endpoint).host);
}
const paperSet = { ...dataset, cases: [selected] };
const experiment = createExperiment(paperSet, {
  model: { name: [...models].sort().join("+") || "not_reported", endpointHost: [...hosts].sort().join("+") || null },
  budget: input.evaluationLimits, implementation: digest(input.implementation),
  protocol: "fresh-raw-pdf-autonomous-v1",
});
const stop = await json(path.join(directory, "evaluation-stop.json")).catch((e) => {
  if (e.code === "ENOENT") return null;
  throw e;
});
const row = {
  caseId, experimentId: experiment.id, status: stop?.reason === "explicit_evaluation_wall_time" ? "timeout" : "unknown",
  reason: stop?.reason || "whole_paper_acceptance_not_automatically_inferred",
  nativeTheoremVerified: result.children.some((c) => c.theoremCheck?.status === "verified" && c.theoremCheck.mode === "proof"),
  nativeSourceRouteVerified: result.children.some((c) => c.sourceRoute?.summary?.status === "verified_route"),
  elapsedMs: Date.parse(result.endedAt) - Date.parse(input.startedAt), cost: null,
  root: bundle.root, recordedToolCounts: result.executionFootprint.toolCounts,
  implementationChangedDuringRun: result.implementationChangedDuringRun,
  sourceResultSha256: sha256(await readFile(path.join(directory, "result.json"))),
};
const gold = (await json(path.join(setDirectory, "evaluator-gold.json"))).filter((g) => g.caseId === caseId);
const report = summarizeExperiment(paperSet, gold, [row], experiment);
report.wholePaperVerified = false;
report.executionDirectory = path.resolve(directory);
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ output, status: row.status, nativeTheoremVerified: row.nativeTheoremVerified,
  nativeSourceRouteVerified: row.nativeSourceRouteVerified, root: row.root }));
