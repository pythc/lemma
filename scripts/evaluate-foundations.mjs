// Small, explicitly budgeted real-provider diagnostic. No evaluator gold is
// loaded until every tested request has finished.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { callModel, modelConfig, semanticModelConfig } from "../server/model.mjs";
import { digest, sha256 } from "../server/evidence.mjs";
import { contentTree } from "../server/toolchain-tree.mjs";
import { createContract } from "../server/contracts.mjs";
import { checkProof } from "../server/lean.mjs";
import { ALIGNMENT_CATEGORIES, semanticReview } from "../server/semantics.mjs";
import { BLIND_PROMPT, COMPARISON_PROMPT, blindSemanticInput, mergeSemanticReviews, semanticModelIdentity } from "../server/semantic-blind.mjs";
import { validateDataset, evaluationInput, createExperiment, summarizeExperiment } from "../server/evaluation-protocol.mjs";

const setDirectory = path.resolve(process.argv[2] || "evaluation/sets/authored-regression");
const configRoot = path.resolve(process.argv[3] || ".");
const output = path.resolve(process.argv[4] || `evidence/foundations-20261021/real-evaluation-${randomUUID()}`);
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const dataset = validateDataset(JSON.parse(await readFile(path.join(setDirectory, "inputs.json"), "utf8")));
const configured = await semanticModelConfig(configRoot), translator = await modelConfig(configRoot);
if (!configured || !translator) throw Error("Local model configuration is unavailable");
const config = { ...configured, concurrency: 1, timeoutMs: 120_000, maxOutputTokens: 4000 };
const budget = { maxModelCalls: 21, perCallTimeoutMs: 120_000, perCallOutputTokens: 4000,
  nativeCandidatesPerFormalCase: 1, concurrency: 1, scope: "explicit_diagnostic_budget_product_defaults_unchanged" };
const implementation = await contentTree(process.cwd(), ["server", "shared", "scripts/evaluate-foundations.mjs"]);
const experiment = createExperiment(dataset, { model: { name: config.model,
  endpointHost: new URL(config.endpoint).host, family: config.family, familyEvidence: config.familyEvidence,
  reasoningEffort: config.reasoningEffort, temperature: 0 },
  budget, implementation: implementation.sha256, protocol: "blind-then-comparison-v1" });
const run = { experiment, modelRelationship: semanticModelIdentity(config, translator), rows: [], calls: 0,
  secondFamily: "not_accepted_user_requested_same_model_first", startedAt: new Date().toISOString() };
await writeFile(path.join(output, "experiment.json"), JSON.stringify(run, null, 2), { flag: "wx" });
async function invoke(system, input, role = "R04") {
  if (run.calls >= budget.maxModelCalls) throw Error("Evaluation model-call budget exhausted");
  const number = ++run.calls;
  try {
    const r = await callModel(config, { role, system, input, maxTokens: 4000 });
    await writeFile(path.join(output, `call-${number}.json`), JSON.stringify(r, null, 2), { flag: "wx" });
    return r;
  } catch (e) {
    await writeFile(path.join(output, `call-${number}-failed.json`), JSON.stringify({
      message: e.message, record: e.modelRecord || null,
    }, null, 2), { flag: "wx" });
    throw e;
  }
}
const modelStatus = (response) => response.checks.some((c) => c.status === "concern") ? "rejected"
  : response.checks.some((c) => c.status === "unresolved") ? "unknown" : "accepted";
for (const c of dataset.cases.filter((c) => c.layer !== "paper")) {
  const started = Date.now();
  const row = { caseId: c.id, experimentId: experiment.id, status: "unknown", elapsedMs: 0, cost: null };
  console.log(JSON.stringify({ case: c.id, stage: "started", completed: run.rows.length }));
  try {
    const input = evaluationInput(c);
    if (c.layer === "semantic") {
      const contract = { targetHash: digest(input), leanTarget: input.candidate, paperSha256: sha256(input.source),
        pageIndex: 0, quote: input.source, statement: input.source, assumptions: [], imports: [], libraryProfile: "analysis-continuity-v1" };
      const context = { paperSha256: contract.paperSha256, selectedPage: 0,
        pages: [{ pageIndex: 0, text: input.source }], supplements: [], omittedPages: [] };
      const blindInput = blindSemanticInput(contract, context);
      const blind = await invoke(BLIND_PROMPT, blindInput);
      semanticReview(contract, context, [], blind.parsed, null);
      row.blindModelStatus = modelStatus(blind.parsed);
      const alignment = ALIGNMENT_CATEGORIES.map((category) => ({ category,
        explanation: "Translator claims this category is faithful; this claim is unverified.",
        anchors: [{ pageIndex: 0, quote: input.source }], leanFragment: input.candidate }));
      const comparison = await invoke(COMPARISON_PROMPT, { ...blindInput, alignment,
        stage: "comparison_after_immutable_blind_review", blindResponse: blind.parsed });
      const reviewed = mergeSemanticReviews(contract, context, alignment, blind.parsed, comparison.parsed, null);
      row.comparisonModelStatus = modelStatus(comparison.parsed);
      row.status = reviewed.checks.some((v) => v.status === "concern") ? "rejected"
        : reviewed.issues.length ? "unknown" : "accepted";
      row.disagreements = reviewed.disagreements;
      row.semanticReview = reviewed;
      row.usage = [blind.record.usage, comparison.record.usage];
      row.reason = row.status === "unknown" ? "unresolved_semantics_or_review_disagreement" : undefined;
    } else {
      const source = "Fixed formal goal evaluation; no natural-language fidelity is being certified.";
      const contract = createContract({ text: source, paperSha256: sha256(source), pageIndex: 0, artifact: sha256(c.id) },
        { label: c.id, quote: source, statement: source, assumptions: [], leanTarget: input.formalStatement }, input.header);
      const proposal = await invoke(
        'Give a Lean 4 proof term for the exact formalStatement, or its negation if false. Do not change hypotheses or target. Use only the selected library profile. Return {"mode":"proof or counterexample","proof":"by ..."} or {"unavailable":"reason"}. No sorry, admit, extra commands, axioms or unsafe evaluation.',
        input, "R09");
      row.usage = proposal.record.usage;
      if (proposal.parsed.unavailable) row.reason = "model_unavailable";
      else {
        row.check = await checkProof(contract, proposal.parsed.proof, { mode: proposal.parsed.mode });
        row.status = row.check.status === "verified" ? "accepted" : "unknown";
        row.reason = row.status === "unknown" ? row.check.failureKind || "native_not_verified" : undefined;
        row.nativeTheoremVerified = row.check.status === "verified" && row.check.mode === "proof";
        row.nativeNegationVerified = row.check.status === "verified" && row.check.mode === "counterexample";
      }
    }
  } catch (e) {
    row.status = e.modelRecord?.error?.code?.includes("TIMEOUT") ? "timeout" : "error";
    row.reason = e.message;
  }
  row.elapsedMs = Date.now() - started;
  // JSON removes undefined optional fields; stable manifests never do.
  run.rows.push(JSON.parse(JSON.stringify(row)));
  await writeFile(path.join(output, `case-${run.rows.length}.json`), JSON.stringify(row, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ case: c.id, status: row.status, reason: row.reason || null, calls: run.calls }));
}
run.endedAt = new Date().toISOString();
await writeFile(path.join(output, "execution.json"), JSON.stringify(run, null, 2), { flag: "wx" });
const gold = JSON.parse(await readFile(path.join(setDirectory, "evaluator-gold.json"), "utf8"));
const report = summarizeExperiment(dataset, gold, run.rows, experiment);
report.modelRelationship = run.modelRelationship;
report.secondFamily = run.secondFamily;
await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify({ output, cases: run.rows.length, calls: run.calls, groups: report.groups }));
