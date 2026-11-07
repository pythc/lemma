import {
  ANCHOR_PROTOCOL,
  COMPACT_AUDIT_PROMPT,
} from "../server/source-anchor-index.mjs";
// Explicit, bounded single-factor trials. Each case gets one request in the
// half-budget cohort. Never retries truncated or unknown external outcomes.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { callModel, semanticModelConfig } from "../server/model.mjs";
import { digest } from "../server/evidence.mjs";
import { contentTree } from "../server/toolchain-tree.mjs";
import {
  controlledPlan,
  pairedSchedule,
  summarizeControlled,
} from "../server/controlled-evaluation.mjs";
import { blindSemanticInput, BLIND_PROMPT } from "../server/semantic-blind.mjs";
import { semanticReview } from "../server/semantics.mjs";
import {
  validateSourceAudit,
  SOURCE_AUDIT_PROTOCOL,
} from "../server/source-audit.mjs";
import { infrastructureFailure } from "../server/model-delivery.mjs";
const [configRoot, out, mode = "effort"] = process.argv.slice(2);
if (!["effort", "protocol"].includes(mode)) throw Error("Unknown trial mode");
if (!configRoot || !out) throw Error("Usage: CONFIG_ROOT NEW_OUTPUT");
await mkdir(out, { recursive: false });
const save = (name, value) =>
  writeFile(path.join(out, name), JSON.stringify(value, null, 2), {
    flag: "wx",
  });
const dataset = JSON.parse(
  await readFile("evaluation/sets/source-semantics/inputs.json", "utf8"),
);
const base = await semanticModelConfig(path.resolve(configRoot));
if (!base) throw Error("Model configuration unavailable");
const implementation = await contentTree(process.cwd(), ["server", "shared"]);
const plan = controlledPlan({
  datasetHash: digest(dataset),
  environmentHash: digest({ nativeChecks: "not_run_source_audit_only" }),
  implementationHash: implementation.sha256,
  model: {
    name: base.model,
    endpointHost: new URL(base.endpoint).host,
    revision: "provider_revision_unpinned",
    ...(mode === "protocol" ? { reasoningEffort: "low" } : {}),
  },
  budget: {
    maxCallsPerCase: 1,
    outputTokens: 4000,
    timeoutMs: 60000,
    concurrency: 1,
  },
  factor: mode === "effort" ? "reasoningEffort" : "wireProtocol",
  arms:
    mode === "effort"
      ? [
          { id: "high", value: "high" },
          { id: "low", value: "low" },
        ]
      : [
          { id: "quoted", value: "quoted-v1" },
          { id: "indexed", value: ANCHOR_PROTOCOL },
        ],
  repetitions: 2,
});
await save("plan.json", {
  plan,
  dataset,
  prompt: BLIND_PROMPT,
  ...(mode === "protocol" ? { compactPrompt: COMPACT_AUDIT_PROMPT } : {}),
  implementation,
  secondFamily: "not_accepted",
  budgetAmendment:
    "User requested experiment budgets halved; sample count and acceptance thresholds unchanged. Max 40 wire requests; 4000 output tokens and 60s per request. No schema retries in this cohort.",
  scope:
    "blind_audit_diagnostic_not_product_or_independent_accuracy_acceptance",
});
let calls = 0;
const rows = [];
if (process.env.LEMMA_TRIAL_CONTINUE_FROM) {
  const previous = JSON.parse(
    await readFile(
      path.join(process.env.LEMMA_TRIAL_CONTINUE_FROM, "report.json"),
      "utf8",
    ),
  );
  if (
    previous.plan.planHash !== plan.planHash ||
    !previous.implementationUnchanged
  )
    throw Error("Cannot continue a different frozen trial");
  for (const r of previous.rows.filter((r) => r.status !== "not_run")) {
    rows.push(r);
    calls += r.calls;
  }
  await save("continuation.json", {
    previousReportHash: digest(previous),
    reusedRows: rows,
    scope: "same_experiment_received_samples_not_new_fresh_runs",
  });
}
for (const row of pairedSchedule(
  plan,
  dataset.cases.map((c) => c.id),
)) {
  if (rows.some((r) => r.sequence === row.sequence)) continue;
  const c = dataset.cases.find((c) => c.id === row.caseId);
  const paperSha256 = digest(c.pages);
  const contract = {
    paperSha256,
    pageIndex: c.pageIndex,
    quote: c.quote,
    statement: c.quote,
    leanTarget: c.candidate,
    assumptions: [],
    imports: [],
    libraryProfile: "std-v1",
    targetHash: digest(c),
  };
  const context = {
    paperSha256,
    selectedPage: c.pageIndex,
    pages: c.pages,
    supplements: [],
    omittedPages: [],
    semanticProtocol: SOURCE_AUDIT_PROTOCOL,
  };
  if (mode === "protocol" && row.arm === "indexed")
    context.anchorProtocol = ANCHOR_PROTOCOL;
  const r = {
    ...row,
    planHash: plan.planHash,
    status: "error",
    calls: 1,
    cost: null,
  };
  let terminal = false;
  calls++;
  try {
    const result = await callModel(
      {
        ...base,
        concurrency: 1,
        timeoutMs: 60000,
        maxOutputTokens: 4000,
        reasoningEffort: mode === "effort" ? row.arm : "low",
      },
      {
        role: "R04",
        system:
          mode === "protocol" && row.arm === "indexed"
            ? COMPACT_AUDIT_PROMPT
            : BLIND_PROMPT,
        input: blindSemanticInput(contract, context),
        maxTokens: 4000,
      },
    );
    await save(`call-${calls}.json`, result);
    r.model = result.record;
    const review = semanticReview(contract, context, [], result.parsed, null),
      audit = validateSourceAudit(result.parsed.sourceAudit, contract, context);
    const issues = [
      ...review.issues.filter((i) => i.code !== "alignment_missing"),
      ...audit.issues,
    ];
    r.status = review.checks.some((x) => x.status === "concern")
      ? "rejected"
      : issues.length
        ? "unknown"
        : "accepted";
    r.review = review;
    r.sourceAudit = audit;
  } catch (e) {
    r.error = e.message;
    r.model = e.modelRecord || r.model || null;
    if (e.modelRecord) {
      await save(`call-${calls}-failed.json`, {
        message: e.message,
        record: e.modelRecord,
      });
      terminal =
        infrastructureFailure(e) &&
        !(
          e.modelRecord.finishReason === "length" &&
          e.modelRecord.http?.bodyDigestScope === "complete_body"
        );
    }
    if (r.model?.error?.code === "model_timeout") r.status = "timeout";
  }
  rows.push(r);
  await save(`case-${row.sequence}.json`, r);
  console.log(
    JSON.stringify({
      sequence: row.sequence,
      caseId: row.caseId,
      arm: row.arm,
      status: r.status,
      finish: r.model?.finishReason,
      reasoningTokens:
        r.model?.usage?.completion_tokens_details?.reasoning_tokens,
    }),
  );
  if (terminal) break;
}
const report = summarizeControlled(
  plan,
  dataset.cases.map((c) => c.id),
  rows,
);
await save("report.json", {
  ...report,
  calls,
  implementationUnchanged:
    (await contentTree(process.cwd(), ["server", "shared"])).sha256 ===
    implementation.sha256,
});
console.log(JSON.stringify({ complete: true, calls, groups: report.groups }));
