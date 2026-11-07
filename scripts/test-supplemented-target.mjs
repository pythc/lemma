// Candidate-only experiment. Never creates semantic approval or updates a run.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EvidenceStore, digest } from "../server/evidence.mjs";
import { ProvingEngine } from "../server/proving-engine.mjs";
import { modelConfig, callModel } from "../server/model.mjs";
import { checkProof } from "../server/lean.mjs";
import { analysisLibraryStatus } from "../server/libraries.mjs";
const [label, name] = process.argv.slice(2);
if (
  !/^[a-z0-9-]{1,80}$/.test(label || "") ||
  !["aktan-vural", "yang-zhu"].includes(name)
)
  throw Error("Invalid evidence identity");
const output = path.resolve("evidence", label);
const reference = JSON.parse(
  await readFile(path.join(output, `${name}-reference.json`)),
);
const store = new EvidenceStore(
  path.resolve(
    ".runtime/prover-benchmark/deepseek-flash-20261018/integrated",
    name,
  ),
);
await store.init();
const run = await store.getRun(reference.id),
  before = digest(run);
if (run.status !== "awaiting_confirmation" || run.approval || !run.contract)
  throw Error("Expected unapproved new environment");
const scope =
  "supplemented_target_candidate_experiment_not_semantic_approval_or_paper_verdict";
const save = (suffix, value) =>
  writeFile(
    path.join(output, `${name}-candidate-${suffix}.json`),
    JSON.stringify(value, null, 2),
    { flag: "wx" },
  );
await save("started", {
  at: new Date().toISOString(),
  runId: run.id,
  targetHash: run.contract.targetHash,
  scope,
});
const environment = await analysisLibraryStatus({ verify: true });
if (!environment.ready) throw Error("Fixed library not ready");
const config = {
  ...(await modelConfig(process.cwd())),
  timeoutMs: 300000,
  maxOutputTokens: 32768,
};
let calls = 0,
  latest = run.contractArtifact;
const model = async (cfg, request) => {
  if (calls >= 3)
    throw Error("Experiment model budget exhausted before dispatch");
  const number = ++calls;
  try {
    const result = await callModel(cfg, request);
    await save(`model-${number}`, {
      role: request.role,
      parsed: result.parsed,
      record: result.record,
    });
    return result;
  } catch (error) {
    await save(`model-${number}`, {
      error: error.message,
      record: error.modelRecord || null,
    });
    throw error;
  }
};
const result = await new ProvingEngine({ model }).prove(run.contract, {
  config,
  context: {
    paper: run.context,
    proposedSupplement: run.domainRecovery.plan,
    sourceCandidates: run.domainRecovery.search,
  },
  budget: reference.budget,
  step: async (kind, title, action) => {
    console.log(JSON.stringify({ kind, title, calls }));
    const value = await action();
    latest = await store.put(
      `candidate_experiment:${kind}`,
      { scope, title, value },
      [run.contractArtifact, latest],
    );
    return value;
  },
});
const replay =
  result.check?.status === "verified"
    ? await checkProof(run.contract, result.candidate.proof, { mode: "proof" })
    : null;
if (digest(await store.getRun(run.id)) !== before)
  throw Error("Unapproved run mutated by experiment");
const report = {
  scope,
  runId: run.id,
  targetHash: run.contract.targetHash,
  target: run.contract.leanTarget,
  environment,
  result,
  replay,
  calls,
  originalRunUnchanged: true,
};
const root = await store.put("supplemented_candidate_experiment", report, [
  run.contractArtifact,
  latest,
]);
await save("result", { ...report, root });
await save("bundle", await store.bundle(root));
console.log(
  JSON.stringify({
    status: result.check?.status,
    replay: replay?.status,
    stop: result.report.stopReason,
    calls,
    root,
  }),
);
