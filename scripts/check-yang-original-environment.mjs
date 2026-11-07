// Check the supervised proof in the previously approved, narrower environment.
// No new approval, library change, or mutation of historical run state.
import { readFile, writeFile } from "node:fs/promises";
import { EvidenceStore, digest } from "../server/evidence.mjs";
import { checkProof } from "../server/lean.mjs";
const dir = "evidence/yang-recursive-20261019";
const candidate = JSON.parse(
  await readFile(`${dir}/symmetry-local-assembly-v3.json`, "utf8"),
);
const store = new EvidenceStore(
  ".runtime/prover-benchmark/deepseek-flash-20261018/integrated/yang-zhu",
);
await store.init();
const run = await store.getRun("da738981-5c54-46e2-bdae-43182d967500");
const before = digest(run);
if (run.contract.leanTarget !== candidate.contract.leanTarget || !run.approval)
  throw Error("Original approved target does not match");
const check = await checkProof(run.contract, candidate.proof, {
  mode: "proof",
});
const replay =
  check.status === "verified"
    ? await checkProof(run.contract, candidate.proof, { mode: "proof" })
    : null;
if (digest(await store.getRun(run.id)) !== before)
  throw Error("Historical run mutated");
const value = {
  scope: "same_goal_supervised_proof_original_approved_environment",
  originalRunId: run.id,
  originalRunUnchanged: true,
  contract: run.contract,
  priorApproval: run.approval,
  proof: candidate.proof,
  check,
  replay,
  autonomous: false,
};
const root = await store.put("yang_original_environment_replay", value, [
  candidate.root,
  run.contractArtifact,
]);
await writeFile(
  `${dir}/original-environment-replay.json`,
  JSON.stringify({ ...value, root }, null, 2),
  { flag: "wx" },
);
await writeFile(
  `${dir}/original-environment-replay-bundle.json`,
  JSON.stringify(await store.bundle(root), null, 2),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    status: check.status,
    replay: replay?.status,
    root,
    errors:
      check.status === "verified" ? undefined : check.stdout?.slice(0, 4000),
    reason: check.reason,
  }),
);
