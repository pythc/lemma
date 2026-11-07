// Assistant-authored symmetry transports around checked model subproofs.
// This is explicitly supervised construction, not an autonomous success claim.
import { readFile, writeFile } from "node:fs/promises";
import { checkProof } from "../server/lean.mjs";
import { EvidenceStore } from "../server/evidence.mjs";
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const label =
  process.env.LEMMA_YANG_SYMMETRY_LABEL || "symmetry-local-assembly";
if (!/^[a-z0-9-]{1,80}$/.test(label)) throw Error("Invalid evidence label");
const dir = "evidence/yang-recursive-20261019";
const slope = await read(
  "evidence/yang-decomposition-20261019/verified-slope-lemma.json",
);
const glue = await read(`${dir}/glue-local-assembly.json`);
const store = new EvidenceStore(
  ".runtime/prover-benchmark/deepseek-flash-20261018/integrated/yang-zhu",
);
await store.init();
const run = await store.getRun("cfa60e3e-903b-4b13-a2b0-7a8f293b2dbb");
let proof = await readFile("scripts/yang-symmetry-proof.txt", "utf8");
for (const [token, value] of Object.entries({
  GLUE_PROOF: glue.proof,
  GLUE_TARGET: glue.contract.leanTarget,
  SLOPE_PROOF: slope.proof,
  SLOPE_TARGET: slope.contract.leanTarget,
}))
  proof = proof.replace(
    token,
    `\n${value
      .split("\n")
      .map((line) => "        " + line)
      .join("\n")}\n        `,
  );
const check = await checkProof(run.contract, proof, { mode: "proof" });
const replay =
  check.status === "verified"
    ? await checkProof(run.contract, proof, { mode: "proof" })
    : null;
const value = {
  scope: "supervised_symmetry_construction_not_autonomous_benchmark",
  contract: run.contract,
  proof,
  check,
  replay,
  approval: null,
};
const root = await store.put("yang_supervised_symmetry_assembly", value, [
  glue.root,
  slope.root,
]);
await writeFile(
  `${dir}/${label}.json`,
  JSON.stringify({ ...value, root }, null, 2),
  { flag: "wx" },
);
await writeFile(
  `${dir}/${label}-bundle.json`,
  JSON.stringify(await store.bundle(root), null, 2),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    status: check.status,
    replay: replay?.status,
    root,
    errors:
      check.status === "verified" ? undefined : check.stdout?.slice(0, 6500),
  }),
);
