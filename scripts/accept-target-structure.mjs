import { mkdir, writeFile } from "node:fs/promises";
import { inspectTarget } from "../server/lean-query.mjs";
import { createContract } from "../server/contracts.mjs";
import { sha256 } from "../server/evidence.mjs";
const out = process.argv[2];
await mkdir(out, { recursive: false });
const rows = [];
for (const [id, target] of [
  ["forall-exists", "∀ n : Nat, ∃ m : Nat, n < m"],
  ["exists-forall", "∃ m : Nat, ∀ n : Nat, n < m"],
  ["rebound", "∀ x : Nat, x = x ∧ (∀ x : Nat, x = x)"],
]) {
  const source = {
    text: id,
    paperSha256: sha256(id),
    pageIndex: 0,
    artifact: sha256(id),
  };
  const contract = createContract(
    source,
    {
      label: id,
      quote: id,
      statement: id,
      assumptions: [],
      leanTarget: target,
    },
    "std-v1",
  );
  const result = await inspectTarget(contract);
  rows.push({ id, contract, result });
  await writeFile(
    out + "/" + id + ".json",
    JSON.stringify(rows.at(-1), null, 2),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      id,
      status: result.status,
      structure: !!result.targetStructure,
      error: result.stderr || result.reason,
    }),
  );
}
const accepted =
  rows.every(
    (r) =>
      r.result.status === "well_typed" &&
      r.result.targetStructure?.targetHash === r.contract.targetHash,
  ) &&
  new Set(rows.map((r) => r.result.targetStructure?.expression)).size === 3;
await writeFile(
  out + "/report.json",
  JSON.stringify(
    {
      accepted,
      rows,
      authority: "native_structure_only_no_natural_language_certificate",
    },
    null,
    2,
  ),
  { flag: "wx" },
);
if (!accepted) process.exitCode = 1;
