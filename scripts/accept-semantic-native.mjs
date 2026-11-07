import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  checkProof,
  sandboxProfile,
  binary,
  runBounded,
} from "../server/lean.mjs";
import { LIBRARY_ROOTS, MATHLIB_ROOT } from "../server/libraries.mjs";
import { proverCapabilities } from "../server/prover-session.mjs";
import { createContract } from "../server/contracts.mjs";
import { sha256 } from "../server/evidence.mjs";
const out = path.resolve(process.argv[2]);
await mkdir(out, { recursive: false });
const directory = await realpath(out),
  root = process.cwd(),
  replRoot = path.join(root, ".tools/proving/repl");
const replBinary = path.join(replRoot, ".lake/build/bin/repl"),
  searchPaths = LIBRARY_ROOTS.map((p) => path.join(MATHLIB_ROOT, p));
const capabilities = await proverCapabilities({ includeManifest: true });
if (!capabilities.ready) throw Error(capabilities.reason);
const cases = [
  {
    id: "identical-open-predicate",
    left: "theorem a (n : Nat) : n + 1 = 2 := sorry",
    right: "theorem b (n : Nat) : n + 1 = 2 := sorry",
  },
  {
    id: "same-open-predicate",
    left: "theorem a (n : Nat) : n + 1 = 2 := sorry",
    right: "theorem b (n : Nat) : 1 + n = 2 := sorry",
  },
  {
    id: "strict-versus-nonstrict",
    left: "theorem a : ∀ n : Nat, 0 < n := sorry",
    right: "theorem b : ∀ n : Nat, 0 ≤ n := sorry",
  },
  {
    id: "different-true-theorems",
    left: "theorem a : ∀ n : Nat, n = n := sorry",
    right: "theorem b : (2 : Nat) + 2 = 4 := sorry",
  },
];
const config = {
  timeoutPerProof: 5,
  upstream: path.join(
    root,
    "evaluation/upstream/leaninteract-beq/768e18ebcb5c7ec34d308768a785389eeac37798/beq_plus.py",
  ),
  replRoot,
  replBinary,
  directory,
  cases,
  header:
    "import Mathlib.Tactic.Tauto\nimport Mathlib.Tactic.NoncommRing\nimport Mathlib.Tactic",
  sandbox:
    sandboxProfile(directory, [replBinary, ...searchPaths]) +
    `\n(allow process-exec (literal ${JSON.stringify(replBinary)}))`,
  environment: {
    PATH: path.dirname(binary),
    LANG: "C.UTF-8",
    TMPDIR: directory,
    LEAN_PATH: searchPaths.join(path.delimiter),
  },
  journal: path.join(directory, "beq-journal.jsonl"),
  result: path.join(directory, "beq-result.json"),
};
// Import pinned local tactics; worker records the exact compatibility patch.
config.header =
  "import Mathlib.Tactic.Tauto\nimport Mathlib.Tactic.NoncommRing";
await writeFile(out + "/beq-config.json", JSON.stringify(config, null, 2), {
  flag: "wx",
});
const upstream = await runBounded(
  path.join(root, ".tools/proving-venv/bin/python"),
  [path.join(root, "scripts/beq-worker.py"), out + "/beq-config.json"],
  {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", PYTHONUNBUFFERED: "1" },
    timeoutMs: 120000,
    maxMemoryMiB: 8192,
    maxOutput: 1024 * 1024,
  },
);
await writeFile(
  out + "/beq-execution.json",
  JSON.stringify({ capabilities, ...upstream }, null, 2),
  { flag: "wx" },
);
const source =
  "Authored diagnostic; fixed variables and conditions. No natural-language equivalence certificate.";
const nativeCases = [
  {
    id: "same-open-predicate",
    target: "∀ n : Nat, (n + 1 = 2 ↔ 1 + n = 2)",
    proof: "by intro n; omega",
    mode: "proof",
  },
  {
    id: "strict-versus-nonstrict",
    target: "∀ n : Nat, (0 < n ↔ 0 ≤ n)",
    proof:
      "by intro h; have hn := (h 0).mpr (Nat.zero_le 0); exact (Nat.lt_irrefl 0) hn",
    mode: "counterexample",
  },
  {
    id: "different-true-theorems",
    target: "(∀ n : Nat, n = n) ↔ ((2 : Nat) + 2 = 4)",
    proof: "by constructor; intro _; rfl; intro _ n; rfl",
    mode: "proof",
  },
  {
    id: "false-author-source",
    target: "∀ n : Nat, 0 < n",
    proof: "by intro h; exact (Nat.lt_irrefl 0) (h 0)",
    mode: "counterexample",
  },
  {
    id: "empty-premise",
    target: "∀ n : Nat, n < 0 → n = 999",
    proof: "by intro n h; exact False.elim (Nat.not_lt_zero n h)",
    mode: "proof",
  },
];
const rows = [];
for (const c of nativeCases) {
  const contract = createContract(
    {
      text: source,
      paperSha256: sha256(source),
      pageIndex: 0,
      artifact: sha256(c.id),
    },
    {
      label: c.id,
      quote: source,
      statement: source,
      assumptions: [],
      leanTarget: c.target,
    },
    "std-v1",
  );
  const check = await checkProof(contract, c.proof, { mode: c.mode });
  rows.push({ ...c, contract, check });
  await writeFile(
    out + `/native-${c.id}.json`,
    JSON.stringify(rows.at(-1), null, 2),
    { flag: "wx" },
  );
}
let beq;
try {
  beq = JSON.parse(await readFile(config.result, "utf8"));
} catch {
  beq = null;
}
const report = {
  classification: "authored_native_and_upstream_metric_diagnostics",
  rows,
  beq,
  upstreamExit: upstream.exitCode,
  nativePassed: rows.every((r) => r.check.status === "verified"),
  semanticCertificate: false,
  caveat:
    "A proof of equivalence between closed true propositions does not establish source faithfulness. BEq+ false means not established, never inequivalence.",
};
await writeFile(out + "/report.json", JSON.stringify(report, null, 2), {
  flag: "wx",
});
console.log(JSON.stringify({ out, nativePassed: report.nativePassed, beq }));
if (
  !report.nativePassed ||
  upstream.exitCode !== 0 ||
  beq?.some((r) => r.status === "error") ||
  beq?.find((r) => r.id === "identical-open-predicate")?.beqPlus !== true
)
  process.exitCode = 1;
