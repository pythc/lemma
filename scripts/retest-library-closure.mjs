// Supplemental environment experiment on immutable, previously confirmed paper
// goals. New environment versions remain unapproved; never emit paper verdicts.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EvidenceStore, digest } from "../server/evidence.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { ProvingEngine } from "../server/proving-engine.mjs";
import { modelConfig, callModel } from "../server/model.mjs";
import { analysisLibraryStatus } from "../server/libraries.mjs";
import { diagnose } from "../server/repair.mjs";
import { missingDeclarationQueries } from "../server/proving-retrieval.mjs";

const label = process.env.LEMMA_CLOSURE_LABEL || "library-closure-20261019";
if (!/^[a-z0-9-]{1,80}$/.test(label)) throw Error("Invalid evidence label");
const output = path.resolve("evidence", label);
await mkdir(output, { recursive: true });
const selected = process.argv[2];
const targets = [
  ["aktan-vural", "b4cc00a1-1818-47d5-bf6f-b3cc8fd9c7be"],
  ["yang-zhu", "da738981-5c54-46e2-bdae-43182d967500"],
].filter(([name]) => !selected || selected === name);
if (!targets.length) throw Error("Unknown paper");
const config = {
  ...(await modelConfig(process.cwd())),
  timeoutMs: 300000,
  maxOutputTokens: 32768,
};
for (const [name, id] of targets) {
  const environment = await analysisLibraryStatus({ verify: true });
  if (!environment.ready) throw Error("Fixed library preflight failed");
  const save = (suffix, value) =>
    writeFile(
      path.join(output, `${name}-${suffix}.json`),
      JSON.stringify(value, null, 2),
      { flag: "wx" },
    );
  // A started reservation must not be silently replayed after interruption.
  await save("started", {
    at: new Date().toISOString(),
    parentRunId: id,
    scope: "new_environment_candidate_only_no_semantic_approval",
  });
  const store = new EvidenceStore(
    path.resolve(
      ".runtime/prover-benchmark/deepseek-flash-20261018/integrated",
      name,
    ),
  );
  let calls = 0;
  const observed = async (cfg, request) => {
    if (calls >= 8)
      throw Error("Experiment model call budget exhausted before dispatch");
    calls++;
    try {
      const result = await callModel(cfg, request);
      await save(`model-${calls}`, {
        role: request.role,
        parsed: result.parsed,
        record: result.record,
      });
      return result;
    } catch (error) {
      await save(`model-${calls}`, {
        role: request.role,
        error: error.message,
        record: error.modelRecord || null,
      });
      throw error;
    }
  };
  const budget = {
    maxElapsedMs: 600000,
    maxCandidates: 3,
    maxModelCalls: 3,
    maxCompletionTokens: 98304,
    perCallCompletionTokens: 32768,
    maxInputCharacters: 180000,
  };
  const pipeline = new ReviewPipeline({
    store,
    getConfig: async () => config,
    model: observed,
    prover: new ProvingEngine({ model: observed }),
    provingBudget: budget,
  });
  await pipeline.init();
  const previous = await store.getRun(id),
    before = digest(previous);
  await save("before", previous);
  const queries = missingDeclarationQueries(diagnose(previous.check));
  const run = await pipeline.recoverDomain(id, { mode: "model", queries });
  await save("reference", {
    id: run.id,
    previous: id,
    queries,
    budget,
    environment,
  });
  let last = "";
  while (pipeline.active.has(run.id)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const current = await store.getRun(run.id);
    const state = JSON.stringify({
      name,
      status: current.status,
      stage: current.domainRecovery.stage,
      calls,
      active: current.tasks
        .filter((t) => ["running", "queued"].includes(t.status))
        .map((t) => ({ title: t.title, status: t.status })),
    });
    if (state !== last) console.log(state);
    last = state;
  }
  const current = await store.getRun(run.id);
  if (digest(await store.getRun(id)) !== before)
    throw Error("Historical run mutated");
  if (
    current.approval ||
    current.check?.status === "verified" ||
    current.conclusion?.theorem === "formalized_proved"
  )
    throw Error("Unapproved environment promoted to a paper verdict");
  const after = await analysisLibraryStatus({ verify: true });
  await save("result", {
    name,
    scope: "new_environment_candidate_only_no_semantic_approval",
    run: current,
    calls,
    historicalRunUnchanged: true,
    libraryAfter: after,
  });
  if (current.root) await save("bundle", await store.bundle(current.root));
  console.log(
    JSON.stringify({
      name,
      runId: current.id,
      status: current.status,
      error: current.error,
      preview: current.domainRecovery.preview?.status,
      components: current.domainRecovery.components.map((c) => ({
        name: c.name,
        status: c.status,
        stop: c.stopReason,
      })),
      root: current.root,
    }),
  );
}
