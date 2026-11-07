import { publicModelResult } from "../server/public-model-view.mjs";
import { selectStrictAuditConfig } from "../server/strict-audit-config.mjs";
// Frozen internal holdout through the exact product reviewTranslation entry.
// Gold labels are never sent to a model; baseline and repair pools are distinct.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { EvidenceStore, digest } from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";
import { inspectTarget } from "../server/lean-query.mjs";
import { retrieveKnowledge } from "../server/knowledge.mjs";
import { callModel, semanticModelConfig } from "../server/model.mjs";
import {
  ANCHORED_AUDIT_PROTOCOL,
  INDEXED_ANCHOR_V2,
} from "../server/audit-wire.mjs";
import { ALIGNMENT_CATEGORIES } from "../server/semantics.mjs";
import { contentTree } from "../server/toolchain-tree.mjs";
import { infrastructureFailure } from "../server/model-delivery.mjs";
import {
  semanticRegistration,
  registeredSemanticGuard,
  EVALUATION_CODE_PATHS,
} from "../server/evaluation-registration.mjs";
const [configRoot, out, datasetPath, mode = "run", registrationPath] =
  process.argv.slice(2);
const preparing = ["prepare", "prepare-development"].includes(mode);
const development = ["development", "prepare-development"].includes(mode);
if (
  !out ||
  !datasetPath ||
  !["prepare", "prepare-development", "run", "development"].includes(mode) ||
  (!preparing && !registrationPath)
)
  throw Error(
    "Expected CONFIG_ROOT NEW_OUTPUT EXPLICIT_DATASET prepare|prepare-development|run|development [REGISTRATION]",
  );
if (!preparing && !process.env.LEMMA_EXPERIMENT_LEDGER)
  throw Error("Experiment ledger required");
if (
  !preparing &&
  process.env.LEMMA_EXPERIMENT_COHORT !==
    (development ? "semanticDev" : "semanticBase")
)
  throw Error(
    "Semantic evaluation mode does not match its preregistered budget cohort",
  );
await mkdir(out, { recursive: false });
const save = (n, v) =>
  writeFile(path.join(out, n), JSON.stringify(v, null, 2), { flag: "wx" });
const dataset = JSON.parse(await readFile(datasetPath + "/inputs.json"));
const goldText = await readFile(datasetPath + "/evaluator-gold.json", "utf8");
const codePaths = EVALUATION_CODE_PATHS;
const implementation = await contentTree(process.cwd(), codePaths);
const config = selectStrictAuditConfig({
  ...(await semanticModelConfig(configRoot)),
  concurrency: 1,
  reasoningEffort: "low",
  maxOutputTokens: 16000,
  timeoutMs: 90000,
  stageBudgets: {
    semantic_blind: {
      maxOutputTokens: 12000,
      reasoningEffort: "low",
      timeoutMs: 90000,
    },
    semantic_comparison: {
      maxOutputTokens: 12000,
      reasoningEffort: "low",
      timeoutMs: 90000,
    },
  },
});
const registration = await semanticRegistration({
  datasetPath,
  development,
  config,
});
const guard = preparing
  ? null
  : await registeredSemanticGuard({
      registrationPath,
      expected: registration,
      config,
    });
const schedule = Array.from({ length: development ? 1 : 3 }, (_, repeat) =>
  dataset.cases.map((c) => ({ caseId: c.id, repeat })),
).flat();
const plan = {
  datasetHash: digest(dataset),
  goldHash: digest(goldText),
  implementation,
  schedule,
  mode,
  thresholds: JSON.parse(goldText).thresholds,
  model: { name: config.model, host: new URL(config.endpoint).host },
  stageBudgets: config.stageBudgets,
  baselineCap: registration.baselineCap,
  repairCap: registration.repairCap,
  registration,
  independentExpertLabels: false,
  secondFamily: "not_accepted",
  entry: "ReviewPipeline.reviewTranslation",
};
await save("plan.json", plan);
const prepared = [];
for (const c of dataset.cases) {
  const source = {
    text: c.pages.find((p) => p.pageIndex === c.pageIndex).text,
    paperSha256: digest(c.pages),
    pageIndex: c.pageIndex,
    artifact: digest(c),
  };
  const contract = createContract(
    source,
    {
      label: c.id,
      quote: c.quote,
      statement: c.quote,
      assumptions: [],
      leanTarget: c.candidate,
    },
    "std-v1",
  );
  const context = {
    paperSha256: source.paperSha256,
    selectedPage: c.pageIndex,
    pages: c.pages,
    supplements: [],
    omittedPages: [],
    semanticProtocol: ANCHORED_AUDIT_PROTOCOL,
    auditBindingProtocol: config.auditBindingProtocol,
    anchorProtocol: INDEXED_ANCHOR_V2,
  };
  const check = await inspectTarget(contract);
  if (check.status !== "well_typed") {
    await save("native-failure-" + c.id + ".json", check);
    throw Error("Native dataset preflight failed " + c.id);
  }
  const definitions = await retrieveKnowledge(contract);
  const alignment = ALIGNMENT_CATEGORIES.map((category) => ({
    category,
    explanation:
      "Candidate translation supplied for independent comparison; no gold label.",
    leanFragment: contract.leanTarget,
    anchors: [{ pageIndex: c.pageIndex, quote: c.quote }],
  }));
  prepared.push({ id: c.id, contract, context, check, definitions, alignment });
  console.log(JSON.stringify({ preflight: c.id }));
}
await save("prepared.json", prepared);
if (preparing) {
  await save("registration.json", registration);
  process.exit(0);
}
let count = 0,
  halt = null;
const rows = [];
for (const slot of schedule) {
  const c = prepared.find((c) => c.id === slot.caseId),
    row = {
      ...slot,
      status: "not_run",
      complete: false,
      firstPassComplete: false,
      startedAt: new Date().toISOString(),
    },
    before = count;
  if (halt) {
    row.reason = halt;
    rows.push(row);
    continue;
  }
  const dir = path.join(out, `case-${slot.repeat}-${c.id}`),
    store = new EvidenceStore(dir);
  await store.init();
  const run = {
    id: randomUUID(),
    mode: "model",
    status: "preparing",
    paperSha256: c.contract.paperSha256,
    contract: c.contract,
    context: c.context,
    tasks: [],
  };
  run.contractArtifact = await store.put("task:R05", c.contract);
  run.contextArtifact = await store.put("task:R02C", c.context);
  const proposal = { proposal: { alignment: c.alignment } };
  run.translationArtifact = await store.put("task:R03", proposal, [
    run.contractArtifact,
  ]);
  const invoke = async (cfg, req) => {
    await guard.assertCurrent();
    if (development && count - before >= 2)
      throw Error("Two-call development cap; not sent");
    count++;
    const id = count;
    try {
      const r = await callModel(cfg, req);
      await save(`call-${id}.json`, publicModelResult(r));
      return r;
    } catch (e) {
      await save(`call-${id}-failed.json`, {
        error: e.message,
        record: e.modelRecord || null,
      });
      if (infrastructureFailure(e))
        halt = "infrastructure_failure_no_auto_replay";
      throw e;
    }
  };
  const p = new ReviewPipeline({
    store,
    getConfig: async () => config,
    getSemanticConfig: async () => config,
    model: invoke,
    targetChecker: async (contract) => {
      if (digest(contract) !== digest(c.contract))
        throw Error("Cached preflight target changed");
      return structuredClone(c.check);
    },
    knowledge: async () => structuredClone(c.definitions),
  });
  try {
    await p.reviewTranslation(run, proposal, config, new AbortController());
    row.complete = true;
    row.review = run.semanticReview;
    const blind = (
      await store.get(run.tasks.find((t) => t.role === "R04B").output)
    ).payload;
    row.firstPassComplete =
      blind.structuredAttempts.length === 1 &&
      run.semanticReview.structuredAttempts.length === 1;
    row.status = run.semanticReview.adjudication
      ? run.semanticReview.adjudication.fidelity === "changed"
        ? "rejected"
        : run.semanticReview.adjudication.admission === "allowed"
          ? "accepted"
          : "unknown"
      : run.semanticReview.checks.some((x) => x.status === "concern") ||
          run.semanticReview.sourceAudit?.fidelity?.status === "changed"
        ? "rejected"
        : run.semanticReview.issues.length
          ? "unknown"
          : "accepted";
  } catch (e) {
    row.status = "error";
    row.error = e.message;
    if (e.evaluationStop) halt = e.evaluationStop;
    row.attempts = e.structuredAttempts || [];
  }
  row.calls = count - before;
  row.endedAt = new Date().toISOString();
  row.runId = run.id;
  run.status = "blocked";
  await store.saveRun(run);
  row.root = await store.put(
    "semantic_evaluation_record",
    { ...row, run },
    run.tasks.map((t) => t.output).filter(Boolean),
  );
  await save(`row-${slot.repeat}-${c.id}.json`, row);
  rows.push(row);
  console.log(
    JSON.stringify({
      case: c.id,
      repeat: slot.repeat,
      status: row.status,
      calls: row.calls,
    }),
  );
}
const gold = JSON.parse(goldText);
const result = rows.map((r) => ({
  ...r,
  reference: gold.labels.find((g) => g.caseId === r.caseId),
}));
const metrics = {
  complete: rows.filter((r) => r.complete).length,
  firstPassComplete: rows.filter((r) => r.firstPassComplete).length,
  faithfulAccepted: result.filter(
    (r) => r.reference.expectation === "accept" && r.status === "accepted",
  ).length,
  falseAccepted: result.filter(
    (r) => r.reference.expectation === "reject" && r.status === "accepted",
  ).length,
  ambiguityFalselyCleared: result.filter(
    (r) => r.reference.expectation === "unknown" && r.status === "accepted",
  ).length,
  unknownCorrect: result.filter(
    (r) => r.reference.expectation === "unknown" && r.status === "unknown",
  ).length,
};
let registrationUnchanged = true;
try {
  await guard.assertCurrent();
} catch (e) {
  registrationUnchanged = false;
  halt ||= e.evaluationStop || e.message;
}
const implementationUnchanged =
  (await contentTree(process.cwd(), codePaths)).sha256 ===
  implementation.sha256;
await save("report.json", {
  plan,
  rows: result,
  metrics,
  calls: count,
  denominator: schedule.length,
  implementationUnchanged,
  registrationUnchanged,
  halt,
  developmentAccepted:
    development &&
    implementationUnchanged &&
    registrationUnchanged &&
    result.length === registration.caseCount &&
    result.every(
      (r) =>
        r.complete &&
        r.firstPassComplete &&
        r.status ===
          { accept: "accepted", reject: "rejected", unknown: "unknown" }[
            r.reference.expectation
          ],
    ),
  accepted:
    !development &&
    registrationUnchanged &&
    implementationUnchanged &&
    schedule.length === 60 &&
    metrics.complete >= 57 &&
    metrics.firstPassComplete >= 57 &&
    metrics.faithfulAccepted >= 27 &&
    metrics.falseAccepted === 0 &&
    metrics.ambiguityFalselyCleared === 0 &&
    metrics.unknownCorrect >= 11,
  secondFamily: "not_accepted",
  independentExpertLabels: false,
});
console.log(JSON.stringify({ metrics, calls: count }));
