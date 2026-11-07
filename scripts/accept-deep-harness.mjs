import { mkdir, writeFile } from "node:fs/promises";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";
import { modelConfig } from "../server/model.mjs";
import { DeepProofHarness } from "../server/deep-harness.mjs";
const out = "evidence/deepagents-20261019";
await mkdir(out, { recursive: true });
const store = new EvidenceStore(".runtime/deepagents-20261019/store");
await store.init();
const text =
  "For every real x with |x| < pi/2, the square of sin x is strictly less than one.";
const source = await store.put("harness_acceptance_fixture", {
  text,
  scope: "external_library_infrastructure_test_not_paper_review",
});
const contract = createContract(
  { paperSha256: sha256(text), pageIndex: 0, text, artifact: source },
  {
    label: "外部定理库端到端验收",
    quote: text,
    statement: text,
    assumptions: [],
    leanTarget: "∀ x : ℝ, |x| < Real.pi / 2 → Real.sin x ^ 2 < 1",
  },
  "analysis-continuity-v1",
);
const harness = new DeepProofHarness({
  store,
  onProgress: async (r, t) =>
    console.log(
      JSON.stringify({
        id: r.id,
        tool: t.tool,
        status: t.status,
        error: t.error || null,
      }),
    ),
});
try {
  const result = await harness.run({
    config: await modelConfig(process.cwd()),
    contract,
    inputs: [source],
    goal: "This is an explicitly labeled integration test, not a paper theorem review. Find a public external Lean theorem library containing a strict sin-square bound, inspect its compatibility and source, install its relevant module, and prove/check the EXACT fixed target using its declaration. Use find_libraries, inspect_library, read_library_source, install_library and check_lean. Reuse no claimed results without tool evidence. Return JSON {mode:'proof',proof:'by ...',route:'independent',explanation:'中文说明'} with valid JSON strings. This task requires at least one newly compiled external library and actual dependency on that library.",
    maxCalls: 32,
  });
  await writeFile(
    `${out}/external-library-acceptance.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      root: result.record.harnessRoot,
      check: result.check?.status,
      contract: result.contract?.targetHash,
    }),
  );
} finally {
  await harness.close();
}
