// Isolated, repeatable end-to-end comparison. Never approves a semantic target.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkProof } from "../server/lean.mjs";
import { inspectTarget } from "../server/lean-query.mjs";
import { retrieveKnowledge } from "../server/knowledge.mjs";
import { probeEnvironment } from "../server/autonomous.mjs";
const root = process.cwd();
const [arm = "baseline", experiment = ""] = process.argv.slice(2);
if (!["baseline", "integrated"].includes(arm))
  throw Error("Unknown comparison arm");
if (experiment && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(experiment))
  throw Error("Invalid experiment label");
const source =
  arm === "baseline"
    ? path.join(root, ".runtime/prover-benchmark/baseline-app")
    : root;
const mod = (p) => import(pathToFileURL(path.join(source, p)));
const { EvidenceStore, sha256 } = await mod("server/evidence.mjs");
const { modelConfig, callModel } = await mod("server/model.mjs");
const { ReviewPipeline } = await mod("server/pipeline.mjs");
const { AutonomousReview } = await mod("server/autonomous.mjs");
const Engine =
  arm === "integrated"
    ? (await mod("server/proving-engine.mjs")).ProvingEngine
    : null;
const output = path.join(
  root,
  "evidence/prover-integration-20261018",
  experiment,
  arm,
);
await mkdir(output, { recursive: true });
const settings = { maxRunMs: 1800000, maxModelCalls: 24, maxWorkers: 2 };
const config = {
  ...(await modelConfig(root)),
  timeoutMs: 600000,
  maxOutputTokens: 32768,
};
for (const name of ["aktan-vural", "yang-zhu"]) {
  const reportPath = path.join(output, `${name}.json`);
  try {
    await readFile(reportPath);
    throw Error(`Refusing to overwrite ${reportPath}`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const store = new EvidenceStore(
    path.join(root, ".runtime/prover-benchmark", experiment, arm, name),
  );
  let calls = 0;
  const observed = async (cfg, input) => {
    if (calls >= settings.maxModelCalls)
      throw Error(
        "Experiment external model budget exhausted before transmission",
      );
    const id = ++calls;
    try {
      const r = await callModel(cfg, input);
      await writeFile(
        path.join(output, `${name}-model-${id}.json`),
        JSON.stringify(r.record, null, 2),
      );
      return r;
    } catch (e) {
      await writeFile(
        path.join(output, `${name}-model-${id}.json`),
        JSON.stringify({ error: e.message, record: e.modelRecord }, null, 2),
      );
      throw e;
    }
  };
  const prover = Engine ? new Engine({ model: observed }) : null;
  const pipeline = new ReviewPipeline({
    store,
    getConfig: () => config,
    model: observed,
    concurrent: true,
    prover,
    checker: checkProof,
    targetChecker: inspectTarget,
    knowledge: retrieveKnowledge,
    provingBudget: {
      maxModelCalls: 3,
      perCallCompletionTokens: 32768,
      maxCompletionTokens: 98304,
    },
  });
  await pipeline.init();
  const review = new AutonomousReview({
    store,
    pipeline,
    getConfig: () => config,
    model: observed,
    limits: settings,
    probe: probeEnvironment,
  });
  await review.init();
  const pdf = await readFile(
    path.join(root, ".runtime/real-papers-20261017", `${name}.pdf`),
  );
  const start = Date.now();
  const initial = await review.start({
    mode: "model",
    paperSha256: sha256(pdf),
    pdfBase64: pdf.toString("base64"),
  });
  let last = "",
    result;
  const deadline = start + settings.maxRunMs + 650000;
  try {
    while (Date.now() < deadline) {
      result = await store.getRun(initial.id);
      const state = `${result.status}:${result.tasks.length}:${calls}`;
      if (state !== last)
        console.log(
          JSON.stringify({
            arm,
            name,
            id: initial.id,
            status: result.status,
            calls,
            tasks: result.tasks.length,
            active: result.tasks
              .filter((t) => t.status === "running")
              .map((t) => t.title),
          }),
        );
      last = state;
      if (
        !["preparing", "running", "pausing"].includes(result.status) &&
        !review.active.has(initial.id)
      )
        break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (["preparing", "running", "pausing"].includes(result.status)) {
      await review.cancel(initial.id);
      throw Error(
        "Comparison deadline reached; run cancelled, no success recorded",
      );
    }
    const children = [];
    for (const t of result.tasks.filter((t) => t.childRunId))
      children.push(await store.getRun(t.childRunId));
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          arm,
          experiment,
          name,
          settings,
          callBudgetScope: "all_external_parent_and_child_requests",
          model: config.model,
          perCallTimeoutMs: config.timeoutMs,
          maxOutputTokens: config.maxOutputTokens,
          elapsedMs: Date.now() - start,
          calls,
          paperSha256: sha256(pdf),
          run: result,
          children,
          semanticApprovalsPerformed: 0,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        arm,
        name,
        status: result.status,
        elapsedMs: Date.now() - start,
        calls,
        children: children.length,
      }),
    );
  } finally {
    await review.close();
  }
}
