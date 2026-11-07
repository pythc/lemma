import { randomUUID } from "node:crypto";
import { ReviewPipeline } from "./pipeline.mjs";
import { DeepProofHarness, harnessModelAdapter } from "./deep-harness.mjs";
import { reviewModelTransport } from "./review-transport.mjs";
import { callModel } from "./model.mjs";
import { budgetSnapshot } from "./review-budget.mjs";

// Explicit component scope, never a whole-paper or proof acceptance record.
export async function createAdmissionRuntime({
  store,
  config,
  semanticConfig = config,
  model = callModel,
  maxCalls = 4,
  maxRunMs = 540000,
  pipelineOptions = {},
}) {
  if (maxCalls !== 4)
    throw Error("Admission component requires the frozen four-call cap");
  await store.init();
  const budget = {
    id: randomUUID(),
    schemaVersion: "lemma.admission-budget.v1",
    scope: "source_translation_admission_only",
    status: "running",
    tasks: [],
    createdAt: new Date().toISOString(),
    limits: { maxModelCalls: maxCalls, maxRunMs },
    modelCalls: 0,
    modelBudget: {
      schemaVersion: "lemma.review-budget.v1",
      legacyCalls: 0,
      entries: [],
    },
  };
  const transport = reviewModelTransport({
    store,
    model,
    getReview: (id) => store.getRun(id),
    saveReview: (run) => store.saveRun(run),
  });
  const harness = new DeepProofHarness({ store, model: transport });
  const pipeline = new ReviewPipeline({
    ...pipelineOptions,
    store,
    getConfig: async () => config,
    getSemanticConfig: async () => semanticConfig,
    model: harnessModelAdapter({ store, harness, model: transport }),
  });
  await pipeline.init();
  // Recover older runs before publishing this new live budget, otherwise init
  // incorrectly marks the fresh component as a prior interrupted execution.
  await store.saveRun(budget);
  return {
    pipeline,
    harness,
    budgetId: budget.id,
    start: (input) =>
      pipeline.reserve(() =>
        pipeline.startReserved(input, { admissionBudgetId: budget.id }),
      ),
    snapshot: async () => budgetSnapshot(await store.getRun(budget.id)),
    async close() {
      for (const controller of pipeline.active.values()) controller.abort();
      while (pipeline.active.size)
        await new Promise((resolve) => setTimeout(resolve, 20));
      await harness.close();
      const saved = await store.getRun(budget.id);
      saved.status = "closed";
      saved.endedAt = new Date().toISOString();
      await store.saveRun(saved);
    },
  };
}
