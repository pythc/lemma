// Read-only provider discovery and local proof replay; no inference requests.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { checkProof } from "../server/lean.mjs";
import { modelConfig } from "../server/model.mjs";
import {
  EvidenceStore,
  digest,
  sha256,
  inspectBundle,
} from "../server/evidence.mjs";
import { PROOF_RUNTIME, MODEL_RUNTIME } from "../server/runtime-limits.mjs";
const dir = "evidence/runtime-limits-20261019";
await mkdir(dir, { recursive: true });
const config = await modelConfig(process.cwd());
const api = await fetch("http://127.0.0.1:4179/api/status").then((r) =>
  r.json(),
);
assert.deepEqual(api.runtimeLimits.proof, PROOF_RUNTIME);
assert.equal(api.model.timeoutMs, MODEL_RUNTIME.defaultTimeoutMs);
assert.equal(api.model.maxOutputTokens, MODEL_RUNTIME.outputTokens);
assert.equal(api.model.resources.limit, 1);
assert.equal((await stat(".env.local")).mode & 0o777, 0o600);
const url = new URL(
  "models",
  config.endpoint.replace(/chat\/completions$/, ""),
);
const response = await fetch(url, {
  redirect: "error",
  headers: { Authorization: `Bearer ${config.key}` },
  signal: AbortSignal.timeout(20000),
});
if (!response.ok) throw Error(`Provider directory HTTP ${response.status}`);
const item = (await response.json()).data.find((m) => m.id === config.model);
assert.ok(item.max_output_tokens >= config.maxOutputTokens);
const prior = JSON.parse(
  await readFile(
    "evidence/yang-recursive-20261019/original-environment-replay.json",
    "utf8",
  ),
);
const experiment = JSON.parse(
  await readFile("evidence/yang-recursive-20261019/result.json", "utf8"),
);
assert.equal(prior.priorApproval.targetHash, prior.contract.targetHash);
const store = new EvidenceStore(
  ".runtime/prover-benchmark/deepseek-flash-20261018/integrated/yang-zhu",
);
const before = digest(await store.getRun(prior.originalRunId));
const check = await checkProof(prior.contract, prior.proof, { mode: "proof" });
const replay = await checkProof(prior.contract, prior.proof, { mode: "proof" });
for (const c of [check, replay]) {
  assert.equal(c.status, "verified");
  assert.equal(c.targetHash, prior.contract.targetHash);
  assert.ok(c.axioms.every((a) => prior.contract.allowedAxioms.includes(a)));
  assert.equal(
    c.invocation.maxHeartbeats,
    api.runtimeLimits.lean.maxHeartbeats,
  );
  assert.equal(
    c.invocation.timeoutMs,
    api.runtimeLimits.lean.analysisTimeoutMs,
  );
}
assert.equal(digest(await store.getRun(prior.originalRunId)), before);
const tests = {};
for (const [name, expected] of [
  ["unit", 177],
  ["lean", 6],
  ["domain", 4],
  ["decomposition", 4],
]) {
  const log = await readFile(`.runtime/runtime-limits-${name}.log`, "utf8");
  assert.match(log, new RegExp(`pass ${expected}\\b`));
  assert.match(log, /fail 0\b/);
  tests[name] = { passed: expected, logSha256: sha256(log) };
}
const paths = ["server", "worker", "scripts", "tests"];
let scanned = 0,
  matches = 0;
const scan = async (folder) => {
  for (const e of await readdir(folder, { withFileTypes: true })) {
    const file = `${folder}/${e.name}`;
    if (e.isDirectory() && e.name !== "__pycache__") await scan(file);
    else if (/\.(mjs|py|txt)$/.test(e.name)) {
      scanned++;
      if ((await readFile(file, "utf8")).includes(config.key)) matches++;
    }
  }
};
for (const folder of paths) await scan(folder);
assert.equal(matches, 0);
const files = [
  "server/runtime-limits.mjs",
  "server/proving-engine.mjs",
  "server/proof-decomposition.mjs",
  "server/domain-recovery.mjs",
  "server/domain-evidence.mjs",
  "server/model.mjs",
  "server/lean.mjs",
  "server/lean-query.mjs",
  "server/prover-session.mjs",
  "server/contracts.mjs",
  "server/domain-schema.mjs",
  "server/evidence.mjs",
  "server/index.mjs",
  "server/autonomous.mjs",
  "server/adaptive.mjs",
  "server/adaptive-schema.mjs",
  "server/repair.mjs",
  "server/context.mjs",
  "server/reference-reader.mjs",
  "server/ledger-model.mjs",
  "server/domain-library.mjs",
  "server/premise-index.mjs",
  "server/specialist-model.mjs",
  "server/pipeline.mjs",
  "worker/proving.py",
  "worker/specialist_limits.py",
  "scripts/retest-yang-decomposition.mjs",
  "scripts/replay.mjs",
  "tests/runtime-limits.test.mjs",
  "tests/domain-recovery.test.mjs",
  "tests/evidence.test.mjs",
  "tests/capabilities.test.mjs",
  "tests/specialist-limits.test.py",
];
const implementation = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [file, sha256(await readFile(file))]),
  ),
);
const report = {
  scope: "runtime_limit_configuration_and_local_replay_no_inference",
  beforeExperimentBudget: experiment.budget,
  runtime: api.runtimeLimits,
  model: api.model,
  provider: {
    id: item.id,
    contextWindow: item.context_window,
    maxOutputTokens: item.max_output_tokens,
  },
  implementation,
  tests,
  credentialScan: { scanned, matches },
  proofReplay: {
    contract: prior.contract,
    proof: prior.proof,
    check,
    replay,
    previousProofRoot: prior.root,
    originalRunUnchanged: true,
  },
  limitations: [
    "Provider context counts input plus output tokens; character caps are not token guarantees",
    "Native local specialist context is 40960 tokens; output subtracts actual prompt tokens",
    "Existing review records retain recorded budgets",
  ],
};
const root = await store.put("runtime_limits_acceptance", report, [prior.root]);
const bundle = await store.bundle(root);
inspectBundle(bundle, root);
await writeFile(
  `${dir}/verification.json`,
  JSON.stringify({ ...report, root }, null, 2),
  { flag: "wx" },
);
await writeFile(
  `${dir}/runtime-limits-evidence.json`,
  JSON.stringify(bundle, null, 2),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    root,
    artifacts: bundle.artifacts.length,
    proof: check.status,
    replay: replay.status,
    tests,
    credentialMatches: matches,
  }),
);
