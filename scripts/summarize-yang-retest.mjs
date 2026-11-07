import { readFile, readdir, writeFile } from "node:fs/promises";
import { EvidenceStore, inspectBundle, sha256 } from "../server/evidence.mjs";
import { modelConfig } from "../server/model.mjs";
const dir = "evidence/yang-recursive-20261019";
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const flat = await read("evidence/yang-decomposition-20261019/result.json");
const automatic = await read(`${dir}/result.json`);
const supervised = await read(`${dir}/original-environment-replay.json`);
const engine = await read(`${dir}/supervised-project-replay.json`);
const config = await modelConfig(process.cwd());
let scanned = 0,
  credentialMatches = 0;
const scan = async (folder) => {
  for (const e of await readdir(folder, { withFileTypes: true })) {
    const file = `${folder}/${e.name}`;
    if (e.isDirectory()) await scan(file);
    else if (/\.(json|md|mjs|txt|lean)$/.test(file)) {
      scanned++;
      if (config.key && (await readFile(file, "utf8")).includes(config.key))
        credentialMatches++;
    }
  }
};
for (const folder of [
  "evidence/yang-decomposition-20261019",
  dir,
  "server",
  "tests",
  "scripts",
])
  await scan(folder);
if (credentialMatches) throw Error("Credential scan failed");
const files = [
  "server/proof-decomposition.mjs",
  "server/proving-engine.mjs",
  "server/contracts.mjs",
  "server/lean.mjs",
  "server/prover-session.mjs",
  "server/pipeline.mjs",
  "server/domain-recovery.mjs",
  "shared/evidence-display.mjs",
  "package.json",
  "tests/proof-decomposition.test.mjs",
  "tests/proof-decomposition-lean.test.mjs",
  "tests/proof-decomposition-http.test.mjs",
  "scripts/yang-symmetry-proof.txt",
  "scripts/check-yang-compression-repair.mjs",
  "scripts/check-yang-glue-assembly.mjs",
  "scripts/check-yang-symmetry-assembly.mjs",
  "scripts/check-yang-original-environment.mjs",
  "scripts/replay-yang-supervised-project.mjs",
  "scripts/retest-yang-decomposition.mjs",
];
const implementation = Object.fromEntries(
  await Promise.all(files.map(async (f) => [f, sha256(await readFile(f))])),
);
for (const [file, hash] of Object.entries(engine.implementation)) {
  if (implementation[file] !== hash)
    throw Error("Current engine differs from supervised replay");
}
const tested = {};
for (const [name, count] of [
  ["unit", 171],
  ["real", 4],
]) {
  const log = await readFile(
    `.runtime/decomposition-final-${name}.log`,
    "utf8",
  );
  if (!new RegExp(`pass ${count}\\b`).test(log) || !/fail 0\b/.test(log))
    throw Error("Test result mismatch");
  tested[name] = { passed: count, failed: 0, logSha256: sha256(log) };
}
const build = await readFile(".runtime/decomposition-final-build.log", "utf8");
if (!build.includes("Prepared Sites build"))
  throw Error("Missing successful build");
const outcomes = {};
for (const name of (await readdir(dir)).filter((n) =>
  /^model-\d+\.json$/.test(n),
)) {
  const record = (await read(`${dir}/${name}`)).record;
  const key = record?.finishReason || record?.error?.code || "unknown";
  outcomes[key] = (outcomes[key] || 0) + 1;
}
const describe = (p) => ({
  root: p.root,
  stop: p.result.report.stopReason,
  check: p.result.check?.status || null,
  externalRequests: p.externalRequests,
  proofInvocationReservations: p.result.report.modelCalls,
  inputCharacters: p.result.report.inputCharacters,
  elapsedMs: p.result.report.elapsedMs,
  originalRunUnchanged: p.originalRunUnchanged,
});
const report = {
  scope:
    "yang_zhu_incremental_engineering_and_supervised_proof_not_equal_budget_benchmark",
  targetHash: supervised.contract.targetHash,
  targetTextUnchanged: supervised.contract.leanTarget === automatic.rootTarget,
  provider: { model: config.model, reasoningEffort: config.reasoningEffort },
  firstStage: describe(flat),
  automatic: describe(automatic),
  automaticResponses: outcomes,
  supervised: {
    root: supervised.root,
    check: supervised.check.status,
    replay: supervised.replay.status,
    axioms: supervised.check.axioms,
    approvalTargetMatches:
      supervised.priorApproval.targetHash === supervised.contract.targetHash,
    originalRunUnchanged: supervised.originalRunUnchanged,
    autonomous: false,
  },
  currentEngineReplay: {
    root: engine.root,
    status: engine.result.check.status,
    modelCalls: engine.result.report.modelCalls,
  },
  implementation,
  tested,
  build: { passed: true, logSha256: sha256(build) },
  credentialScan: { scanned, matches: credentialMatches },
  libraryAfter: automatic.libraryAfter,
  limits: [
    "Supervised construction includes assistant repairs and symmetry proofs",
    "Not a line-by-line certification of the original paper",
    "Budgets and strategies differ across stages",
  ],
};
const store = new EvidenceStore(
  ".runtime/prover-benchmark/deepseek-flash-20261018/integrated/yang-zhu",
);
await store.init();
const root = await store.put("yang_retest_final_acceptance", report, [
  flat.root,
  automatic.root,
  supervised.root,
  engine.root,
]);
const bundle = await store.bundle(root);
inspectBundle(bundle, root);
await writeFile(
  `${dir}/final-verification.json`,
  JSON.stringify({ ...report, root }, null, 2),
  { flag: "wx" },
);
await writeFile(
  `${dir}/yang-zhu-final-evidence.json`,
  JSON.stringify(bundle, null, 2),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    root,
    artifacts: bundle.artifacts.length,
    bytes: Buffer.byteLength(JSON.stringify(bundle, null, 2)),
    credentialMatches,
    tested,
    automatic: describe(automatic),
    supervised: report.supervised,
  }),
);
