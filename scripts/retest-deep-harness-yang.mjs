import { mkdir, writeFile } from "node:fs/promises";
import { EvidenceStore } from "../server/evidence.mjs";
import { OriginalProofService } from "../server/original-proof-service.mjs";
import { modelConfig } from "../server/model.mjs";
import { harnessModelAdapter } from "../server/deep-harness.mjs";
const out = "evidence/deepagents-20261019";
await mkdir(out, { recursive: true });
const store = new EvidenceStore(".runtime/original-proof-20261019/store");
await store.init();
const baseline = await store.getRun("7b2f4132-40a2-4c4c-b321-4466e63b04c0");
if (baseline.status !== "completed")
  throw Error("Expected immutable completed baseline");
const service = new OriginalProofService({
  store,
  getConfig: () => modelConfig(process.cwd()),
  model: harnessModelAdapter({ store }),
});
const run = await service.start({
  reviewRunId: baseline.reviewRunId,
  continuedFrom: baseline.id,
  replayUnknown: false,
});
await writeFile(
  `${out}/yang-run.json`,
  JSON.stringify(
    {
      id: run.id,
      baseline: baseline.id,
      baselineRoot: baseline.root,
      contract: baseline.contract.targetHash,
      startedAt: run.createdAt,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ id: run.id, status: "started" }));
while (service.active.has(run.id))
  await new Promise((resolve) => setTimeout(resolve, 1000));
const result = await store.getRun(run.id);
await writeFile(
  `${out}/yang-result.json`,
  JSON.stringify(
    {
      id: result.id,
      root: result.root,
      status: result.status,
      error: result.error || null,
      summary: result.originalProofRoute?.summary,
      assembly: result.originalProofRoute?.assembly?.status,
      assemblyAudit: result.originalProofRoute?.assembly?.audit,
      tasks: result.tasks.map((t) => ({
        id: t.id,
        role: t.role,
        title: t.title,
        status: t.status,
        output: t.output,
        error: t.error || null,
      })),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    id: result.id,
    status: result.status,
    root: result.root,
    summary: result.originalProofRoute?.summary,
    assembly: result.originalProofRoute?.assembly?.status,
  }),
);
if (result.status === "completed") {
  const replay = await service.replay(result.id);
  await writeFile(`${out}/yang-replay.json`, JSON.stringify(replay, null, 2));
  console.log(JSON.stringify({ replay: replay.reproduced }));
}
