import { ReviewPipeline } from "../server/pipeline.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { modelConfig } from "../server/model.mjs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const store = new EvidenceStore(path.resolve(".runtime/capability-acceptance"));
const pipeline = new ReviewPipeline({
  store,
  getConfig: () => modelConfig(process.cwd()),
});
await pipeline.init();
let id;
if (["prepare", "manual-model"].includes(process.argv[2])) {
  const bytes = await readFile("public/analysis-fixtures.pdf");
  const run = await pipeline.start({
    mode: process.argv[2] === "manual-model" ? "manual" : "model",
    proofStrategy: "model",
    ...(process.argv[2] === "manual-model"
      ? {
          proposal: {
            label: "A1 · 人工翻译 / 模型修复实测",
            quote:
              "A continuous real function on a closed bounded interval is uniformly continuous on that interval.",
            statement:
              "对任意实数 a、b 和实函数 f，f 在闭区间 Icc(a,b) 连续则在该区间一致连续。允许空区间。",
            assumptions: ["定义域是同一个实数闭区间", "f 在该区间连续"],
            leanTarget:
              "∀ (a b : ℝ) (f : ℝ → ℝ), ContinuousOn f (Set.Icc a b) → UniformContinuousOn f (Set.Icc a b)",
            ambiguity: "人工翻译，用于核验模型证明修复；不计为模型翻译成功。",
          },
        }
      : {}),
    libraryProfile: "analysis-continuity-v1",
    pageIndex: 0,
    paperSha256: sha256(bytes),
    pdfBase64: bytes.toString("base64"),
    seedProof: { mode: "proof", proof: "by rfl" },
  });
  id = run.id;
  await writeFile(
    "evidence/capability-live-id.json",
    JSON.stringify(
      {
        runId: id,
        dataRoot: store.root,
        classification:
          "live_model_with_deliberately_invalid_human_seed_not_natural_failure_rate",
      },
      null,
      2,
    ),
  );
} else if (process.argv[2] === "retry") {
  const reference = JSON.parse(
    await readFile("evidence/capability-live-id.json"),
  );
  const run = await pipeline.retryTranslation(reference.runId);
  id = run.id;
  await writeFile(
    "evidence/capability-live-id.json",
    JSON.stringify(
      { ...reference, runId: id, continuedFrom: reference.runId },
      null,
      2,
    ),
  );
} else if (process.argv[2] === "execute") {
  const reference = JSON.parse(
    await readFile("evidence/capability-live-id.json"),
  );
  id = reference.runId;
  const run = await store.getRun(id);
  // The approval JSON is written only after inspecting the actual draft. No
  // automatic semantic approval or hidden waiver of model concerns here.
  const approval = JSON.parse(
    await readFile("evidence/capability-live-approval.json"),
  );
  if (approval.runId !== id) throw new Error("Approval belongs to another run");
  await pipeline.approve(id, approval.input);
} else
  throw new Error(
    "Usage: node scripts/run-capability-acceptance.mjs prepare|manual-model|retry|execute",
  );
console.log(JSON.stringify({ started: id }));
while (pipeline.active.has(id))
  await new Promise((resolve) => setTimeout(resolve, 1000));
const run = await store.getRun(id);
await writeFile(
  `evidence/capability-live-${process.argv[2]}.json`,
  JSON.stringify(run, null, 2),
);
if (run.root)
  await writeFile(
    "evidence/capability-live-bundle.json",
    JSON.stringify(await store.bundle(run.root), null, 2),
  );
console.log(
  JSON.stringify({
    status: run.status,
    error: run.error,
    target: run.contract?.leanTarget,
    statement: run.contract?.statement,
    issues: run.semanticReview?.issues,
    checks: run.semanticReview?.checks,
    type: run.semanticReview?.targetCheck?.status,
    attempts: run.attempts?.map((a) => ({
      number: a.number,
      status: a.status,
      diagnostic: a.diagnostic?.category,
    })),
    conclusion: run.conclusion,
    stop: run.repair?.stopReason,
  }),
);
