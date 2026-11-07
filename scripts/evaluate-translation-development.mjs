import { publicModelResult } from "../server/public-model-view.mjs";
import { selectStrictAuditConfig } from "../server/strict-audit-config.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { createAdmissionRuntime } from "../server/admission-runtime.mjs";
import { modelConfig, callModel } from "../server/model.mjs";
import { contentTree } from "../server/toolchain-tree.mjs";
import {
  infrastructureFailure,
  unknownModelOutcome,
} from "../server/model-delivery.mjs";

const [
  configRoot,
  out,
  datasetPath = "evaluation/sets/seventh-translation-development/inputs.json",
] = process.argv.slice(2);
if (
  !out ||
  !process.env.LEMMA_EXPERIMENT_LEDGER ||
  !["translationDev", "translationRework", "developmentHoldout"].includes(
    process.env.LEMMA_EXPERIMENT_COHORT,
  )
)
  throw Error(
    "A preregistered experiment ledger/cohort and new output directory are required",
  );
await mkdir(out, { recursive: false });
const save = (name, value) =>
  writeFile(path.join(out, name), JSON.stringify(value, null, 2), {
    flag: "wx",
  });
const cases = JSON.parse(await readFile(datasetPath, "utf8")).cases;
const codePaths = [
  "server",
  "shared",
  "worker",
  "scripts",
  "tests",
  "package.json",
  "package-lock.json",
  "evaluation",
];
const implementation = await contentTree(process.cwd(), codePaths);
const config = {
  ...(await modelConfig(configRoot)),
  concurrency: 1,
  timeoutMs: 90000,
  maxOutputTokens: 12000,
  reasoningEffort: "low",
  stageBudgets: {
    semantic_blind: {
      maxOutputTokens: 12000,
      timeoutMs: 90000,
      reasoningEffort: "low",
    },
    semantic_comparison: {
      maxOutputTokens: 12000,
      timeoutMs: 90000,
      reasoningEffort: "low",
    },
  },
};
const semanticConfig = selectStrictAuditConfig(config);
config.auditBindingProtocol = semanticConfig.auditBindingProtocol;
await save("plan.json", {
  semanticTransport: {
    protocol: semanticConfig.auditBindingProtocol,
    endpoint: semanticConfig.endpoint,
    thinking: semanticConfig.auditBindingProtocol?.endsWith("tools.v4")
      ? "disabled"
      : "unchanged",
  },
  cases,
  implementation,
  perCaseCalls: 4,
  perCaseMs: 540000,
  scope:
    "actual_model_R03_native_R04_fixed_source_component_not_raw_pdf_autonomy",
  expectedAdmission: "allowed",
  model: { name: config.model, host: new URL(config.endpoint).host },
  secondFamily: "not_accepted",
});
const rows = [];
let halt = null;
for (const c of cases) {
  const dir = path.join(out, c.id);
  await mkdir(dir);
  const store = new EvidenceStore(path.join(dir, "store"));
  let calls = 0,
    runtime,
    run;
  const row = {
    id: c.id,
    passed: false,
    startedAt: new Date().toISOString(),
    versions: [],
  };
  const invoke = async (cfg, request) => {
    if (
      (await contentTree(process.cwd(), codePaths)).sha256 !==
      implementation.sha256
    )
      throw Error(
        "Frozen development implementation changed; request not sent",
      );
    if (calls >= 4)
      throw Error("Four-call component backstop; request not sent");
    const number = ++calls;
    try {
      const result = await callModel(cfg, request);
      await writeFile(
        path.join(dir, `call-${number}.json`),
        JSON.stringify(publicModelResult(result), null, 2),
        { flag: "wx" },
      );
      return result;
    } catch (error) {
      if (
        infrastructureFailure(error) ||
        (error.modelRecord && unknownModelOutcome(error.modelRecord))
      )
        halt = {
          caseId: c.id,
          error: error.message,
          delivery: error.modelRecord?.error?.delivery || null,
        };
      await writeFile(
        path.join(dir, `call-${number}-failure.json`),
        JSON.stringify(
          { error: error.message, record: error.modelRecord || null },
          null,
          2,
        ),
        { flag: "wx" },
      );
      throw error;
    }
  };
  const settle = async (id) => {
    const budget = await store.getRun(runtime.budgetId);
    const until = Date.parse(budget.createdAt) + budget.limits.maxRunMs;
    while (runtime.pipeline.active.has(id) && Date.now() < until)
      await new Promise((r) => setTimeout(r, 100));
    if (runtime.pipeline.active.has(id)) runtime.pipeline.cancel(id);
    while (runtime.pipeline.active.has(id))
      await new Promise((r) => setTimeout(r, 100));
    return store.getRun(id);
  };
  try {
    runtime = await createAdmissionRuntime({
      store,
      config,
      semanticConfig,
      model: invoke,
    });
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman);
    pdf
      .addPage()
      .drawText(c.source, { font, x: 30, y: 700, size: 10, maxWidth: 530 });
    const bytes = Buffer.from(await pdf.save());
    await writeFile(path.join(dir, "source.pdf"), bytes, { flag: "wx" });
    run = await settle(
      (
        await runtime.start({
          mode: "model",
          libraryProfile: "std-v1",
          pdfBase64: bytes.toString("base64"),
          paperSha256: sha256(bytes),
          pageIndex: 0,
          focusQuote: c.source,
        })
      ).id,
    );
    row.versions.push(run.id);
    const first = run.translationArtifact
      ? (await store.get(run.translationArtifact)).payload
      : null;
    row.firstSubmissionStructured =
      !!first?.model?.structuredSchemaHash && !first.model.alignmentRepairUsed;
    const preparation =
      first?.model?.toolReceipts?.filter(
        (t) => t.name === "prepare_translation",
      ) || [];
    const harness = first?.model?.harnessRoot
      ? await store.bundle(first.model.harnessRoot)
      : null;
    const submission = harness?.artifacts.find(
      (a) => a.kind === "harness:translation_submission",
    );
    row.preparationAdopted =
      preparation.length > 0 &&
      Boolean(submission) &&
      preparation.some(
        (t) => t.artifact === submission.payload.preparationArtifact,
      ) &&
      harness.artifacts.some(
        (a) =>
          a.kind === "harness:tool" &&
          a.id === submission.payload.preparationArtifact &&
          a.payload.name === "prepare_translation",
      );
    row.preparationReceipts = preparation;
    row.submissionPreparation = submission?.payload || null;
    if (
      run.nativeTargetCheck?.status === "not_well_typed" &&
      (await runtime.snapshot()).used <= 1
    ) {
      run = await settle(
        (
          await runtime.pipeline.retryTranslation(run.id, {
            reviseTarget: true,
            repairFeedback: JSON.stringify(run.nativeTargetCheck),
          })
        ).id,
      );
      row.versions.push(run.id);
    }
    row.runId = run.id;
    row.status = run.status;
    row.error = run.error || null;
    row.native = run.nativeTargetCheck?.status || "not_run";
    row.adjudication = run.semanticReview?.adjudication || null;
    row.passed =
      row.firstSubmissionStructured &&
      row.preparationAdopted &&
      row.native === "well_typed" &&
      row.adjudication?.admission === "allowed";
  } catch (error) {
    row.error = error.stack;
  } finally {
    row.calls = calls;
    let archiveFailure = null;
    try {
      await runtime?.close();
      const budget = runtime ? await store.getRun(runtime.budgetId) : null;
      const versions = await Promise.all(
        row.versions.map((id) => store.getRun(id)),
      );
      row.calls = calls;
      row.budget = runtime ? await runtime.snapshot() : null;
      row.endedAt = new Date().toISOString();
      row.root = await store.put(
        "seventh:translation_development",
        { row, run: run || null, versions, budget },
        [
          ...new Set(
            [
              ...versions.flatMap((v) => v.tasks.map((t) => t.output)),
              ...(budget?.modelBudget?.entries || []).map((e) => e.receipt),
            ].filter(Boolean),
          ),
        ],
      );
      await writeFile(
        path.join(dir, "bundle.json"),
        JSON.stringify(await store.bundle(row.root)),
        { flag: "wx" },
      );
    } catch (error) {
      archiveFailure = error;
      row.archiveError = error.stack;
      row.passed = false;
    }
    row.endedAt = new Date().toISOString();
    await writeFile(
      path.join(dir, "result.json"),
      JSON.stringify(row, null, 2),
      { flag: "wx" },
    );
    rows.push(row);
    console.log(JSON.stringify(row));
    if (archiveFailure) throw archiveFailure; // No further paid dispatch after incomplete sealing.
  }
  if (halt) break; // A fresh case must not silently replay a provider outage or unknown outcome.
}
const implementationUnchanged =
  (await contentTree(process.cwd(), codePaths)).sha256 ===
  implementation.sha256;
await save("result.json", {
  rows,
  implementationUnchanged,
  passed:
    !halt &&
    implementationUnchanged &&
    rows.length === cases.length &&
    rows.every((r) => r.passed),
  halt,
  notStarted: cases
    .filter((c) => !rows.some((r) => r.id === c.id))
    .map((c) => c.id),
  calls: rows.reduce((n, r) => n + r.calls, 0),
  secondFamily: "not_accepted",
});
