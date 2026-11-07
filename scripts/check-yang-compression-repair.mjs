// Deterministic local repair of a recorded candidate. No model calls or run updates.
import { readFile, writeFile } from "node:fs/promises";
import { obligationContract } from "../server/proof-decomposition.mjs";
import { checkProof } from "../server/lean.mjs";
import { EvidenceStore, digest } from "../server/evidence.mjs";

const dir = "evidence/yang-recursive-20261019";
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const previous = await read("evidence/yang-decomposition-20261019/result.json");
const glue = previous.result.report.decomposition.helpers.findLast(
  (h) => h.name === "GlueIncDec",
).contract;
const plan = (await read(`${dir}/model-3.json`)).parsed;
const part = plan.parts.find((p) => p.name === "Compress");
const contract = obligationContract(glue, part.name, part.target);
const original = (await read(`${dir}/model-8.json`)).parsed.proof;
let proof = original;
const repairs = [
  ["Finset.min'_le S hS (x j) hxj", "Finset.min'_le S (x j) hxj"],
  ["              rfl\n          have hsum_inc", "          have hsum_inc"],
  [
    "Finset.eq_empty_iff_forall_not_mem.mpr (by\n          intro j hj\n          exact hsne ⟨j, hj⟩)",
    "Finset.not_nonempty_iff_eq_empty.mp hsne",
  ],
];
for (const [from, to] of repairs) {
  if (!proof.includes(from)) throw Error("Recorded repair no longer matches");
  proof = proof.replace(from, to);
}
const check = await checkProof(contract, proof, { mode: "proof" });
const replay =
  check.status === "verified"
    ? await checkProof(contract, proof, { mode: "proof" })
    : null;
const value = {
  scope: "local_repair_of_internal_obligation_not_root_proof",
  sourceCandidateHash: digest(original),
  repairs,
  contract,
  proof,
  check,
  replay,
};
const store = new EvidenceStore(
  ".runtime/prover-benchmark/deepseek-flash-20261018/integrated/yang-zhu",
);
await store.init();
const root = await store.put("yang_compression_local_repair", value, [
  previous.root,
]);
await writeFile(
  `${dir}/compression-local-repair.json`,
  JSON.stringify({ ...value, root }, null, 2),
  { flag: "wx" },
);
await writeFile(
  `${dir}/compression-local-repair-bundle.json`,
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
  }),
);
