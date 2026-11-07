// Explicit user-authorized continuation of the interrupted Yang–Zhu experiment.
// Completed evidence is reused; this does not approve any mathematical target.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { EvidenceStore } from "../server/evidence.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { AutonomousReview } from "../server/autonomous.mjs";
import { ProvingEngine } from "../server/proving-engine.mjs";
import { modelConfig, callModel } from "../server/model.mjs";

const root = process.cwd();
const experiment = "deepseek-flash-20261018",
  name = "yang-zhu",
  arm = "integrated";
const id = "5c5ed4bb-5cd3-479a-8ef8-be5be8ddf9e7";
const output = path.join(
  root,
  "evidence/prover-integration-20261018",
  experiment,
  arm,
);
const store = new EvidenceStore(
  path.join(root, ".runtime/prover-benchmark", experiment, arm, name),
);
await store.init();
const before = await store.getRun(id);
await writeFile(
  path.join(output, "yang-zhu-before-authorized-resume.json"),
  JSON.stringify(
    {
      authorization:
        "User explicitly allowed resending two unknown model requests and continuing the interrupted experiment.",
      at: new Date().toISOString(),
      run: before,
      unknownRequests: [13, 14],
    },
    null,
    2,
  ),
  { flag: "wx" },
);
let calls = 14;
const config = {
  ...(await modelConfig(root)),
  timeoutMs: 600000,
  maxOutputTokens: 32768,
};
const observed = async (cfg, input) => {
  const number = ++calls;
  try {
    const result = await callModel(cfg, input);
    await writeFile(
      path.join(output, `${name}-model-${number}.json`),
      JSON.stringify(result.record, null, 2),
      { flag: "wx" },
    );
    return result;
  } catch (error) {
    await writeFile(
      path.join(output, `${name}-model-${number}.json`),
      JSON.stringify(
        { error: error.message, record: error.modelRecord },
        null,
        2,
      ),
      { flag: "wx" },
    );
    throw error;
  }
};
const pipeline = new ReviewPipeline({
  store,
  getConfig: () => config,
  model: observed,
  concurrent: true,
  prover: new ProvingEngine({ model: observed }),
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
  limits: before.limits,
});
await review.init();
const parent = await review.load(id);
const upload = (await store.get(parent.uploadArtifact)).payload;
for (const task of parent.tasks.filter((t) => t.childRunId && !t.childFinal)) {
  const prior = await store.getRun(task.childRunId);
  if (prior.status !== "interrupted") continue;
  let next;
  if (prior.contract && prior.translationArtifact) {
    next = await pipeline.retryTranslation(prior.id);
  } else {
    next = await pipeline.startReserved(
      {
        mode: "model",
        paperSha256: prior.paperSha256,
        pdfBase64: upload.pdfBase64,
        pageIndex: prior.pageIndex,
        focusQuote: prior.focusQuote || undefined,
        libraryProfile: prior.libraryProfile,
      },
      { parentReviewId: id, parentTaskId: task.id },
    );
    next.continuedFrom = prior.id;
    await store.saveRun(next);
  }
  await review.adoptChild(prior.id, next);
}
await review.resume(id);
let last = "",
  result;
try {
  const deadline = Date.now() + 35 * 60 * 1000;
  while (Date.now() < deadline) {
    result = await store.getRun(id);
    const status = `${result.status}:${calls}:${result.tasks.length}`;
    if (status !== last)
      console.log(
        JSON.stringify({
          name,
          status: result.status,
          calls,
          tasks: result.tasks.length,
          active: result.tasks
            .filter((t) => t.status === "running")
            .map((t) => t.title),
        }),
      );
    last = status;
    if (
      !["running", "preparing", "pausing"].includes(result.status) &&
      !review.active.has(id)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (review.active.has(id)) {
    await review.cancel(id);
    result = await store.getRun(id);
  }
  const children = [];
  for (const task of result.tasks.filter((t) => t.childRunId))
    children.push(await store.getRun(task.childRunId));
  await writeFile(
    path.join(output, `${name}.json`),
    JSON.stringify(
      {
        experiment,
        arm,
        name,
        run: result,
        children,
        calls,
        model: config.model,
        settings: before.limits,
        elapsedMs: Date.now() - Date.parse(before.createdAt),
        semanticApprovalsPerformed: 0,
        continuation:
          "Explicitly authorized after reference-download process crash; elapsed time includes interruption.",
        comparableTiming: false,
        unknownRequestsRetained: [13, 14],
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      name,
      status: result.status,
      calls,
      children: children.length,
    }),
  );
} finally {
  await review.close();
}
