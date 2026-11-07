// Same paper and exact supplemented target. Candidate experiment only: no
// semantic approval, no historical-run mutation, and no unknown-call replay.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EvidenceStore, digest, sha256 } from "../server/evidence.mjs";
import { PROOF_RUNTIME, MODEL_RUNTIME } from "../server/runtime-limits.mjs";
import { ProvingEngine } from "../server/proving-engine.mjs";
import { hasUnknownProofOutcome } from "../server/proof-decomposition.mjs";
import { modelConfig, callModel } from "../server/model.mjs";
import { checkProof } from "../server/lean.mjs";
import { analysisLibraryStatus } from "../server/libraries.mjs";
const label =
  process.env.LEMMA_YANG_RETEST_LABEL || "yang-large-limits-20261019";
if (!/^[a-z0-9-]{1,80}$/.test(label)) throw Error("Invalid retest label");
const output = path.resolve("evidence", label);
await mkdir(output, { recursive: true });
const scope =
  "same_target_resumed_recursive_decomposition_candidate_experiment_no_semantic_approval";
const save = (name, value) =>
  writeFile(path.join(output, `${name}.json`), JSON.stringify(value, null, 2), {
    flag: "wx",
  });
const store = new EvidenceStore(
  path.resolve(
    ".runtime/prover-benchmark/deepseek-flash-20261018/integrated/yang-zhu",
  ),
);
await store.init();
const run = await store.getRun("cfa60e3e-903b-4b13-a2b0-7a8f293b2dbb"),
  before = digest(run);
if (
  run.contract?.targetHash !==
    "b3bd4a479faa0d2a994424f790439cf34a8b5ee98d628e9d7275322c8fbdede0" ||
  run.approval
)
  throw Error("Fixed target changed");
const budget = { ...PROOF_RUNTIME };
const old = JSON.parse(
  await readFile("evidence/yang-recursive-20261019/result.json"),
);
if (
  old.targetHash !== run.contract.targetHash ||
  old.result.report.stopReason === "external_outcome_unknown" ||
  hasUnknownProofOutcome(old.result.report.decomposition)
)
  throw Error(
    "Previous experiment is mismatched or has an unknown outcome; no model request sent",
  );
await save("started", {
  at: new Date().toISOString(),
  scope,
  runId: run.id,
  targetHash: run.contract.targetHash,
  budget,
  previousExperimentRoot: old.root,
});
const environment = await analysisLibraryStatus({ verify: true });
if (!environment.ready) throw Error("Library preflight failed");
const config = {
  ...(await modelConfig(process.cwd())),
  timeoutMs: MODEL_RUNTIME.defaultTimeoutMs,
  maxOutputTokens: budget.perCallCompletionTokens,
};
const route = await readFile(
  "../research/yang-zhu-packing-outline-20261019.md",
  "utf8",
);
const files = [
  "server/runtime-limits.mjs",
  "server/proof-decomposition.mjs",
  "server/proving-engine.mjs",
  "server/contracts.mjs",
  "server/lean.mjs",
  "server/prover-session.mjs",
  "server/pipeline.mjs",
  "server/domain-recovery.mjs",
  "scripts/retest-yang-decomposition.mjs",
];
await save("environment", {
  environment,
  implementation: Object.fromEntries(
    await Promise.all(files.map(async (f) => [f, sha256(await readFile(f))])),
  ),
});
let calls = 0,
  latest = run.contractArtifact,
  events = 0;
const model = async (cfg, request) => {
  if (calls >= budget.maxModelCalls)
    throw Error("Retest model budget exhausted before dispatch");
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
      role: request.role,
      error: error.message,
      record: error.modelRecord || null,
    });
    throw error;
  }
};
const result = await new ProvingEngine({ model }).prove(run.contract, {
  config,
  budget,
  initialDecomposition: old.result.report.decomposition,
  context: {
    paper: run.context,
    candidateMathematicalRouteNotYetProved: route,
    priorAttempt: {
      stop: old.result.report.stopReason,
      attempts: old.result.report.attempts,
      budgetStop: old.result.report.budgetStop || null,
    },
    instruction:
      "Use the paper's Lemmas 1 and 2 as mathematical context. The exact root must include all four monotonicity/convexity cases and arbitrary finite disjoint intervals. Missing a same-named theorem is not a reason to weaken the goal; construct smaller obligations and prove them.",
  },
  step: async (kind, title, action) => {
    const number = ++events;
    console.log(
      JSON.stringify({ at: new Date().toISOString(), kind, title, calls }),
    );
    const value = await action();
    latest = await store.put(
      `yang_decomposition:${kind}`,
      { scope, title, value },
      [run.contractArtifact, latest],
    );
    await save(`event-${number}`, {
      kind,
      title,
      artifact: latest,
      status: value.status || null,
    });
    return value;
  },
});
const replay =
  result.check?.status === "verified"
    ? await checkProof(run.contract, result.candidate.proof, { mode: "proof" })
    : null;
if (digest(await store.getRun(run.id)) !== before)
  throw Error("Historical run mutated");
const report = {
  scope,
  runId: run.id,
  targetHash: run.contract.targetHash,
  rootTarget: run.contract.leanTarget,
  budget,
  result,
  replay,
  externalRequests: calls,
  previousExperimentRoot: old.root,
  events,
  originalRunUnchanged: true,
  libraryAfter: await analysisLibraryStatus({ verify: true }),
};
const root = await store.put("yang_decomposition_experiment", report, [
  run.contractArtifact,
  old.root,
  latest,
]);
await save("result", { ...report, root });
await save("bundle", await store.bundle(root));
console.log(
  JSON.stringify({
    status: result.check?.status,
    replay: replay?.status,
    stop: result.report.stopReason,
    project: result.report.decomposition?.status,
    helpers: result.report.decomposition?.helpers.map((h) => ({
      name: h.name,
      status: h.status,
    })),
    calls,
    root,
  }),
);
