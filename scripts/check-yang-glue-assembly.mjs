// Assemble recorded, checked helper proofs. No inference or approval mutation.
import { readFile, writeFile } from "node:fs/promises";
import {
  obligationContract,
  composeDecomposition,
} from "../server/proof-decomposition.mjs";
import { checkProof } from "../server/lean.mjs";
import { EvidenceStore, digest } from "../server/evidence.mjs";
const dir = "evidence/yang-recursive-20261019";
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const previous = await read("evidence/yang-decomposition-20261019/result.json");
const glue = previous.result.report.decomposition.helpers.findLast(
  (h) => h.name === "GlueIncDec",
).contract;
const plan = (await read(`${dir}/model-3.json`)).parsed;
const compression = await read(`${dir}/compression-local-repair.json`);
if (
  compression.check.status !== "verified" ||
  compression.replay.status !== "verified"
)
  throw Error("Compression repair was not verified");
const proofs = {
  UCE: (await read(`${dir}/model-4.json`)).parsed.proof,
  Anchor: (await read(`${dir}/model-5.json`)).parsed.proof,
  Compress: compression.proof,
};
const solved = new Map();
for (const part of plan.parts) {
  const contract = obligationContract(glue, part.name, part.target);
  const check = await checkProof(contract, proofs[part.name], {
    mode: "proof",
  });
  if (check.status !== "verified") throw Error(`${part.name} replay failed`);
  solved.set(part.name, {
    ...part,
    contract,
    proof: proofs[part.name],
    check,
    identity: digest({ target: part.target, dependsOn: part.dependsOn }),
  });
}
const connection = obligationContract(
  glue,
  "Connection",
  glue.leanTarget,
  plan.parts,
);
const proof = composeDecomposition(plan, solved, connection);
const check = await checkProof(glue, proof, { mode: "proof" });
const replay =
  check.status === "verified"
    ? await checkProof(glue, proof, { mode: "proof" })
    : null;
const value = {
  scope: "checked_increasing_decreasing_increment_glue_not_full_paper",
  contract: glue,
  proof,
  helpers: [...solved.values()],
  check,
  replay,
};
const store = new EvidenceStore(
  ".runtime/prover-benchmark/deepseek-flash-20261018/integrated/yang-zhu",
);
await store.init();
const root = await store.put("yang_glue_local_assembly", value, [
  compression.root,
]);
await writeFile(
  `${dir}/glue-local-assembly.json`,
  JSON.stringify({ ...value, root }, null, 2),
  { flag: "wx" },
);
await writeFile(
  `${dir}/glue-local-assembly-bundle.json`,
  JSON.stringify(await store.bundle(root), null, 2),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    status: check.status,
    replay: replay?.status,
    root,
    errors:
      check.status === "verified" ? undefined : check.stdout?.slice(0, 3000),
  }),
);
