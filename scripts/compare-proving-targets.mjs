// Local ablation on historical, unapproved real-paper targets. This does not
// approve their semantics, run paper reading, or rewrite historical evidence.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { ProvingEngine } from "../server/proving-engine.mjs";
import { validateContract } from "../server/contracts.mjs";
import { sha256 } from "../server/evidence.mjs";
const output = "evidence/prover-integration-20261018/local-target-ablation";
await mkdir(output, { recursive: true });
const budget = {
  maxElapsedMs: 180000,
  maxCandidates: 2,
  maxModelCalls: 1,
  maxCompletionTokens: 2048,
  perCallCompletionTokens: 2048,
  perStepMs: 30000,
};
for (const [name, id] of [
  ["aktan-vural", "6a502e43-43a9-4d81-b8ec-50f1017d5444"],
  ["yang-zhu", "9068d18e-5e8a-461e-8f5b-cdbe6b4bbdfe"],
]) {
  const historical = JSON.parse(
    await readFile(`.runtime/runs/${id}.json`, "utf8"),
  );
  const contract = validateContract(historical.contract);
  const pdf = await readFile(`.runtime/real-papers-20261017/${name}.pdf`);
  if (sha256(pdf) !== contract.paperSha256)
    throw Error("Paper bytes do not match the historical target");
  await writeFile(
    `${output}/${name}-contract.json`,
    JSON.stringify(
      { contract, sourceRun: id, semanticApproval: false },
      null,
      2,
    ),
    { flag: "wx" },
  );
  for (const arm of ["whole_file_generation", "interactive_search"]) {
    const events = [];
    const prover = new ProvingEngine(
      arm === "whole_file_generation"
        ? {
            capabilities: async () => ({
              ready: false,
              reason: "search disabled for controlled ablation",
            }),
          }
        : {},
    );
    const result = await prover.prove(contract, {
      budget,
      step: async (kind, title, fn) => {
        const start = Date.now();
        const result = await fn();
        events.push({
          kind,
          title,
          startedAt: new Date(start).toISOString(),
          elapsedMs: Date.now() - start,
          result,
        });
        return result;
      },
    });
    const record = {
      experiment: "local_specialist_search_ablation_not_production_baseline",
      paper: name,
      arm,
      sourceRun: id,
      targetHash: contract.targetHash,
      semanticApproval: false,
      paperVerdict: "not_established",
      budget,
      events,
      ...result,
    };
    await writeFile(
      `${output}/${name}-${arm}.json`,
      JSON.stringify(record, null, 2),
      { flag: "wx" },
    );
    console.log(
      JSON.stringify({
        name,
        arm,
        status: result.check?.status || "no_candidate",
        stop: result.report.stopReason,
        elapsedMs: result.report.elapsedMs,
        calls: result.report.modelCalls,
      }),
    );
  }
}
