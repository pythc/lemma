// Algorithm comparison only: immutable historical targets are NOT semantically
// approved by this experiment, and no paper-review verdict is produced.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ProvingEngine } from "../server/proving-engine.mjs";
import { modelConfig, callModel } from "../server/model.mjs";
import { checkProof } from "../server/lean.mjs";
import { retrieveKnowledge } from "../server/knowledge.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { validateContract } from "../server/contracts.mjs";

const root = process.cwd();
const confirmed = process.argv[3] === "confirmed";
if (process.argv[3] && !confirmed) throw Error("Unknown target set");
const experiment = confirmed
  ? "confirmed-targets-20261019"
  : "deepseek-fixed-targets-v3-20261018";
const arms = process.argv[2] ? [process.argv[2]] : ["baseline", "integrated"];
if (arms.some((a) => !["baseline", "integrated"].includes(a)))
  throw Error("Invalid arm");
const output = path.join(
  root,
  "evidence/prover-integration-20261018",
  experiment,
);
await mkdir(output, { recursive: true });
const baselineSource = path.join(
  root,
  ".runtime/prover-benchmark/baseline-app",
);
const { ReviewPipeline: Baseline } = await import(
  pathToFileURL(path.join(baselineSource, "server/pipeline.mjs"))
);
const config = {
  ...(await modelConfig(root)),
  timeoutMs: 300000,
  maxOutputTokens: 32768,
};
const budget = {
  maxElapsedMs: 600000,
  maxCandidates: 3,
  maxModelCalls: 3,
  maxCompletionTokens: 98304,
  perCallCompletionTokens: 32768,
  maxInputCharacters: 180000,
};

const targetSet = confirmed
  ? [
      ["aktan-vural", "b4cc00a1-1818-47d5-bf6f-b3cc8fd9c7be"],
      ["yang-zhu", "da738981-5c54-46e2-bdae-43182d967500"],
    ]
  : [
      ["aktan-vural", "6a502e43-43a9-4d81-b8ec-50f1017d5444"],
      ["yang-zhu", "9068d18e-5e8a-461e-8f5b-cdbe6b4bbdfe"],
    ];
const authorization = confirmed
  ? JSON.parse(await readFile(path.join(output, "authorization.json"), "utf8"))
  : null;
for (const [name, id] of targetSet) {
  const historical = JSON.parse(
    await readFile(
      confirmed
        ? path.join(output, `${name}-before.json`)
        : path.join(root, ".runtime/runs", `${id}.json`),
      "utf8",
    ),
  );
  const contract = validateContract(historical.contract);
  if (
    confirmed &&
    !authorization.targets.some(
      (t) => t.id === id && t.hash === contract.targetHash,
    )
  )
    throw Error("Target does not match explicit confirmation");
  const pdf = await readFile(
    path.join(root, ".runtime/real-papers-20261017", `${name}.pdf`),
  );
  if (sha256(pdf) !== contract.paperSha256)
    throw Error("Paper identity mismatch");
  for (const arm of arms) {
    const filename = path.join(output, `${name}-${arm}.json`);
    const reservation = await writeFile(
      filename + ".started",
      new Date().toISOString(),
      { flag: "wx" },
    );
    const events = [];
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget.maxElapsedMs);
    const store = new EvidenceStore(
      path.join(root, ".runtime/prover-benchmark", experiment, name, arm),
    );
    await store.init();
    const task = async (kind, title, action) => {
      const at = Date.now();
      try {
        const value = await action();
        events.push({ kind, title, elapsedMs: Date.now() - at, value });
        return value;
      } catch (e) {
        events.push({
          kind,
          title,
          elapsedMs: Date.now() - at,
          error: e.message,
          model: e.modelRecord || null,
        });
        throw e;
      }
    };
    let result,
      failure = null;
    try {
      if (arm === "integrated") {
        result = await new ProvingEngine({ model: callModel }).prove(contract, {
          config,
          context: historical.context,
          mode: "proof",
          signal: controller.signal,
          budget,
          step: task,
        });
      } else {
        const run = {
          id: randomUUID(),
          mode: "model",
          contract,
          context: historical.context,
          semanticReview: historical.semanticReview,
          tasks: [],
          semanticApproval: false,
        };
        const pipeline = new Baseline({
          store,
          getConfig: () => config,
          model: callModel,
          repairBudget: budget,
          // Both arms use the identical trusted checker at its real installed
          // path. Relocating it behind a .tools symlink violates its sandbox.
          checker: checkProof,
          knowledge: retrieveKnowledge,
        });
        // Keep the frozen proof algorithm. Only replace its bookkeeping adapter
        // so experimental searches cannot create a semantic-approval artifact.
        pipeline.task = async (r, role, title, type, inputs, action) => {
          const value = await task(role, title, action);
          const output = await store.put(
            "experimental:" + role,
            value,
            inputs.filter(Boolean),
          );
          r.tasks.push({ id: randomUUID(), role, title, type, output });
          return value;
        };
        await pipeline.proveWithRepair(
          run,
          { proofMode: "proof" },
          config,
          controller,
          { text: historical.context?.text || contract.quote },
        );
        result = {
          check: run.check || null,
          report: run.repair,
          attempts: run.attempts,
          proof: run.proofArtifact
            ? (await store.get(run.proofArtifact)).payload
            : null,
        };
      }
    } catch (e) {
      failure = e.message;
    } finally {
      clearTimeout(timer);
    }
    const candidate = result?.candidate || result?.proof;
    let replay = null;
    if (result?.check?.status === "verified" && candidate?.proof)
      replay = await checkProof(contract, candidate.proof, {
        mode: candidate.mode,
      });
    const record = {
      experiment,
      name,
      arm,
      historicalRun: id,
      contract,
      semanticApproval: false,
      confirmedScopeDocument: confirmed ? authorization.reviewedDocument : null,
      paperVerdict: "not_established",
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      executionAdapter:
        "shared_unchanged_checker_and_knowledge_at_real_install_path",
      budget,
      elapsedMs: Date.now() - started,
      events,
      result: result || null,
      replay,
      failure,
    };
    await writeFile(filename, JSON.stringify(record, null, 2), { flag: "wx" });
    console.log(
      JSON.stringify({
        name,
        arm,
        status: result?.check?.status || "no_candidate",
        direction: result?.check?.mode || null,
        stop: result?.report?.stopReason || failure,
        replay: replay?.status || null,
        elapsedMs: record.elapsedMs,
      }),
    );
  }
}
