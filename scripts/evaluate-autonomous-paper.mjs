// Generic raw-PDF acceptance runner. Inputs are PDF bytes and a natural-language
// scope only. No proof text, contracts, graphs or historical bundles are loaded.
import { readFile, writeFile, mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { sha256 } from "../server/evidence.mjs";
import { writeEvidenceFile } from "../server/evidence-io.mjs";
import { replayOriginalProof } from "../server/original-proof.mjs";
import { REVIEW_RUNTIME } from "../server/runtime-limits.mjs";
import {
  modelConfig,
  semanticModelConfig,
  callModel,
} from "../server/model.mjs";
import { contentTree } from "../server/toolchain-tree.mjs";
import { EVALUATION_CODE_PATHS } from "../server/evaluation-registration.mjs";
const [pdfPath, outPath, reviewIntent, ...flags] = process.argv.slice(2);
if (!pdfPath || !outPath || !reviewIntent)
  throw Error(
    "Usage: node scripts/evaluate-autonomous-paper.mjs paper.pdf output-directory 'review scope'",
  );
const evaluationLimits = {};
const modelOverrides = {};
for (const flag of flags) {
  if (flag === "--fifth-stage-profile") {
    if (modelOverrides.stageBudgets) throw Error("Repeated stage profile");
    modelOverrides.maxOutputTokens = 16000;
    modelOverrides.stageBudgets = {
      default: {
        reasoningEffort: "low",
        maxOutputTokens: 16000,
        timeoutMs: 90000,
      },
      A_READ: {
        reasoningEffort: "none",
        maxOutputTokens: 3000,
        timeoutMs: 60000,
      },
      A_COORDINATOR: {
        reasoningEffort: "low",
        maxOutputTokens: 6000,
        timeoutMs: 45000,
      },
      semantic_blind: {
        reasoningEffort: "low",
        maxOutputTokens: 12000,
        timeoutMs: 90000,
      },
      semantic_comparison: {
        reasoningEffort: "low",
        maxOutputTokens: 12000,
        timeoutMs: 90000,
      },
      source_planning: {
        reasoningEffort: "low",
        maxOutputTokens: 16000,
        timeoutMs: 90000,
      },
      proof_construction: {
        reasoningEffort: "low",
        maxOutputTokens: 16000,
        timeoutMs: 90000,
      },
    };
    evaluationLimits.chunkCharacters = 8000;
    continue;
  }
  if (flag === "--fourth-stage-profile") {
    modelOverrides.stageBudgets = {
      default: {
        reasoningEffort: "low",
        maxOutputTokens: 6000,
        timeoutMs: 90000,
      },
      A_READ: {
        reasoningEffort: "low",
        maxOutputTokens: 3000,
        timeoutMs: 60000,
      },
      A_COORDINATOR: {
        reasoningEffort: "low",
        maxOutputTokens: 2000,
        timeoutMs: 45000,
      },
      R04: { reasoningEffort: "low", maxOutputTokens: 6000, timeoutMs: 90000 },
    };
    evaluationLimits.chunkCharacters = 8000;
    continue;
  }
  const modelMatch = flag.match(
    /^--(model-output-tokens|model-timeout-seconds)=(\d+)$/,
  );
  if (modelMatch) {
    const key =
      modelMatch[1] === "model-output-tokens" ? "maxOutputTokens" : "timeoutMs";
    const value = Number(modelMatch[2]) * (key === "timeoutMs" ? 1000 : 1);
    if (
      Object.hasOwn(modelOverrides, key) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > (key === "timeoutMs" ? 14400000 : 393216)
    )
      throw Error("Invalid model evaluation budget");
    modelOverrides[key] = value;
    continue;
  }
  const match = flag.match(/^--(max-model-calls|max-run-minutes)=(\d+)$/);
  if (!match)
    throw Error(
      "Unknown evaluation limit; mathematical targets and proof inputs are not accepted",
    );
  const value = Number(match[2]);
  const key = match[1] === "max-model-calls" ? "maxModelCalls" : "maxRunMs";
  if (
    Object.hasOwn(evaluationLimits, key) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >
      (key === "maxModelCalls"
        ? REVIEW_RUNTIME.maxModelCalls
        : REVIEW_RUNTIME.maxRunMs / 60000)
  )
    throw Error("Evaluation limit outside product ceiling or repeated");
  evaluationLimits[key] = key === "maxRunMs" ? value * 60000 : value;
}
const out = path.resolve(outPath),
  dataRoot = path.join(out, "store");
await mkdir(out, { recursive: true });
try {
  if ((await readdir(dataRoot)).length)
    throw Error(
      "Autonomous acceptance requires a NEW empty store; never reuse candidates",
    );
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const pdf = await readFile(pdfPath),
  paperSha256 = sha256(pdf);
if (pdf.subarray(0, 5).toString() !== "%PDF-")
  throw Error("Input is not a PDF");
const implementationTree = await contentTree(
  process.cwd(),
  EVALUATION_CODE_PATHS,
);
const implementation = {};
for (const folder of ["server", "shared"])
  for (const file of (await readdir(folder))
    .filter((f) => f.endsWith(".mjs"))
    .sort())
    implementation[`${folder}/${file}`] = sha256(
      await readFile(`${folder}/${file}`),
    );
await writeFile(
  path.join(out, "acceptance-input.json"),
  JSON.stringify(
    {
      schemaVersion: "lemma.autonomous-acceptance.v1",
      paperSha256,
      reviewIntent,
      startedAt: new Date().toISOString(),
      implementation,
      implementationTree,
      historicalArtifactsImported: 0,
      suppliedProofs: 0,
      suppliedLeanTargets: 0,
      suppliedProofGraphs: 0,
      evaluationLimits,
      modelOverrides,
      evaluationLimitScope: "explicit_test_budget_product_defaults_unchanged",
      scope: "fresh_product_agent_execution_not_developer_proof_construction",
    },
    null,
    2,
  ),
);
const app = await createApp({
  dataRoot,
  transportModel: async (config, request) => {
    if (
      (await contentTree(process.cwd(), EVALUATION_CODE_PATHS)).sha256 !==
      implementationTree.sha256
    )
      throw Object.assign(
        Error("Frozen evaluation implementation changed; request not sent"),
        { evaluationStop: "implementation_changed" },
      );
    return callModel(config, request);
  },
  ...(process.env.LEMMA_EVALUATION_CONFIG_ROOT ||
  Object.keys(modelOverrides).length
    ? {
        configProvider: async () => ({
          ...(await modelConfig(
            path.resolve(process.env.LEMMA_EVALUATION_CONFIG_ROOT || "."),
          )),
          ...modelOverrides,
        }),
        semanticConfigProvider: async () => ({
          ...(await semanticModelConfig(
            path.resolve(process.env.LEMMA_EVALUATION_CONFIG_ROOT || "."),
          )),
          ...modelOverrides,
        }),
      }
    : {}),
  adaptiveOptions: { limits: evaluationLimits },
});
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
let final;
let evaluationTimer;
try {
  const run = await app.adaptive.start({
    paperSha256,
    pdfBase64: pdf.toString("base64"),
    reviewIntent,
  });
  if (evaluationLimits.maxRunMs)
    evaluationTimer = setTimeout(() => {
      void (async () => {
        await writeFile(
          path.join(out, "evaluation-stop.json"),
          JSON.stringify(
            {
              reason: "explicit_evaluation_wall_time",
              requestedAt: new Date().toISOString(),
              limitMs: evaluationLimits.maxRunMs,
            },
            null,
            2,
          ),
        );
        await app.adaptive.expireBudget(run.id);
      })().catch((error) =>
        console.error("Evaluation cancellation failed:", error.message),
      );
    }, evaluationLimits.maxRunMs);
  await writeFile(
    path.join(out, "started.json"),
    JSON.stringify(
      { id: run.id, paperSha256, serverPort: app.server.address().port },
      null,
      2,
    ),
  );
  let last = "";
  while (app.adaptive.active.has(run.id) || app.pipeline.active.size) {
    const r = await app.store.getRun(run.id);
    const progress = JSON.stringify({
      id: r.id,
      status: r.status,
      calls: r.modelCalls,
      active: r.tasks
        .filter((t) => ["running", "queued", "recovering"].includes(t.status))
        .map((t) => ({ kind: t.kind, title: t.title })),
      children: r.tasks
        .filter((t) => t.childRunId)
        .map((t) => ({ id: t.childRunId, status: t.childStatus })),
    });
    if (progress !== last) {
      console.log(progress);
      last = progress;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  final = await app.store.getRun(run.id);
  const children = [];
  for (const f of await readdir(path.join(dataRoot, "runs"))) {
    if (!f.endsWith(".json")) continue;
    const child = await app.store.getRun(f.slice(0, -5));
    if (child.parentReviewId !== run.id || child.engine === "deepagents-v1")
      continue;
    const route = child.originalProofRoute;
    const item = {
      id: child.id,
      status: child.status,
      error: child.error || null,
      contract: child.contract,
      autonomy: child.autonomy,
      theoremCheck: child.check
        ? {
            status: child.check.status,
            mode: child.check.mode,
            targetHash: child.check.targetHash,
          }
        : null,
      sourceRoute: route
        ? {
            summary: route.summary,
            graphArtifact: route.graphArtifact,
            assembly: route.assembly?.status,
            steps: route.steps?.map((s) => ({
              name: s.name,
              title: s.title,
              status: s.status,
              explanation: s.explanation,
              targetHash: s.contract?.targetHash,
              leanStatus: s.check?.status || null,
              attempts: s.attempts,
              unknownExternalOutcome: s.unknownExternalOutcome || false,
            })),
            budget: route.budget,
            root: route.root,
          }
        : null,
    };
    if (
      route?.root &&
      route.steps?.some((s) => s.check?.status === "verified")
    ) {
      item.replay = await replayOriginalProof(
        await app.store.bundle(route.root),
        route.root,
      );
    }
    children.push(item);
    await writeFile(
      path.join(out, `child-${child.id}.json`),
      JSON.stringify(child, null, 2),
    );
    if (child.root)
      await writeEvidenceFile(
        path.join(out, `child-${child.id}.ndjson`),
        app.store,
        child.root,
      );
  }
  const drift = [];
  if (
    (await contentTree(process.cwd(), EVALUATION_CODE_PATHS)).sha256 !==
    implementationTree.sha256
  )
    drift.push("evaluation_implementation_tree");
  for (const [file, hash] of Object.entries(implementation))
    if (sha256(await readFile(file)) !== hash) drift.push(file);
  const toolCounts = {},
    artifactCounts = {};
  for (const file of await readdir(path.join(dataRoot, "artifacts"))) {
    if (!file.endsWith(".json")) continue;
    const a = JSON.parse(
      await readFile(path.join(dataRoot, "artifacts", file), "utf8"),
    );
    artifactCounts[a.kind] = (artifactCounts[a.kind] || 0) + 1;
    if (a.kind === "harness:tool")
      toolCounts[a.payload.name] = (toolCounts[a.payload.name] || 0) + 1;
  }
  const summary = {
    id: run.id,
    paperSha256,
    reviewIntent,
    status: final.status,
    error: final.error || null,
    conclusion: final.conclusion,
    evaluationLimits,
    modelOverrides,
    budget: final.modelBudget || null,
    reviewScope: final.reviewScope || null,
    executionFootprint: {
      toolCounts,
      artifactCounts,
      scopes: final.claims.map((c) => ({
        label: c.label,
        originalLocator: c.anchor,
        sourceScopeHash: c.formalScope?.scopeHash || null,
        spans: c.formalScope?.spans || [],
        scopeReviewArtifact: c.scopeReviewArtifact || null,
        formalizationStalled: c.formalizationStalled || null,
      })),
    },
    children,
    implementationChangedDuringRun: drift,
    endedAt: new Date().toISOString(),
    scope: "bounded_autonomous_sample_not_general_success_rate",
  };
  await writeFile(
    path.join(out, "result.pending.json"),
    JSON.stringify(summary, null, 2),
  );
  await writeFile(path.join(out, "run.json"), JSON.stringify(final, null, 2));
  if (final.root || final.failureRoot)
    await writeEvidenceFile(
      path.join(out, "bundle.ndjson"),
      app.store,
      final.root || final.failureRoot,
    );
  await rename(
    path.join(out, "result.pending.json"),
    path.join(out, "result.json"),
  );
  console.log(
    JSON.stringify({
      id: run.id,
      status: final.status,
      error: summary.error,
      children: children.map((c) => ({
        id: c.id,
        status: c.status,
        theorem: c.theoremCheck?.status || null,
        assembly: c.sourceRoute?.assembly || null,
        steps:
          c.sourceRoute?.steps?.map((s) => ({
            name: s.name,
            status: s.status,
          })) || [],
      })),
      implementationChangedDuringRun: drift,
    }),
  );
} finally {
  clearTimeout(evaluationTimer);
  await app.adaptive.close();
  await app.harness.close();
  await new Promise((resolve) => app.server.close(resolve));
}
