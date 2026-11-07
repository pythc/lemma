import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../server/evidence.mjs";
import { validateDataset } from "../server/evaluation-protocol.mjs";
const root = new URL("../evaluation/upstream/proofnet-verified/160414332dc196583f6c37c310b420d2a3b07c58/", import.meta.url);
const provenance = JSON.parse(await readFile(new URL("provenance.json", root), "utf8"));
const bytes = await readFile(new URL("data.jsonl", root));
if (sha256(bytes) !== provenance.files["data.jsonl"].sha256) throw Error("Upstream data checksum mismatch");
const source = bytes.toString().trim().split("\n").map((l) => JSON.parse(l));
const dataset = { schemaVersion: "lemma.evaluation-set.v1", name: "ProofNet-Verified pinned reference", cases: [] };
const gold = [];
for (const row of source) {
  if (!/\s*:=\s*(?:by\s+)?sorry\s*$/.test(row.formal_stmt)) throw Error(`Unexpected upstream statement layout: ${row.name}`);
  const formal = row.formal_stmt.replace(/\s*:=\s*(?:by\s+)?sorry\s*$/, "");
  const family = `proofnet/textbook/${row.textbook}`;
  const split = parseInt(sha256(family).slice(0, 8), 16) % 5 === 0 ? "holdout" : "development";
  for (const layer of ["semantic", "formal"]) {
    const id = `proofnet/${row.index}/${row.name}/${layer}`;
    dataset.cases.push({ id, family, split, layer, origin: "upstream_reference", contamination: "unknown",
      provenance: { revision: provenance.revision, url: provenance.files["data.jsonl"].url, license: provenance.license,
        upstreamLean: provenance.upstreamLean, localCompatibility: "not_validated", index: row.index },
      input: layer === "semantic" ? { source: row.informal_stmt, candidate: formal, definitions: row.helper || "" }
        : { formalStatement: formal, header: row.header, helper: row.helper || "", leanVersion: provenance.upstreamLean } });
    gold.push({ caseId: id, expectation: "accept", status: "upstream_only",
      referenceFormalization: formal, referenceInformalProof: row.informal_proof,
      referenceFormalProof: null, independentlyAnnotatedHere: false });
  }
}
validateDataset(dataset);
const out = path.resolve(process.argv[2] || "evaluation/sets/proofnet-verified");
await mkdir(path.dirname(out), { recursive: true });
await mkdir(out, { recursive: false });
await writeFile(path.join(out, "inputs.json"), JSON.stringify(dataset, null, 2) + "\n");
await writeFile(path.join(out, "evaluator-gold.json"), JSON.stringify(gold, null, 2) + "\n", { mode: 0o600 });
await writeFile(path.join(out, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
console.log(JSON.stringify({ out, upstreamRows: source.length, cases: dataset.cases.length,
  families: [...new Set(dataset.cases.map((c) => c.family))],
  holdout: dataset.cases.filter((c) => c.split === "holdout").length,
  referenceProofsSentToModel: 0, researchAccuracy: null }));
