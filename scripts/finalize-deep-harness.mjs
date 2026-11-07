import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { EvidenceStore } from "../server/evidence.mjs";
import { checkProof } from "../server/lean.mjs";
import { replayHarness } from "../server/deep-harness.mjs";
import { OriginalProofService } from "../server/original-proof-service.mjs";
import { modelConfig } from "../server/model.mjs";
const out = "evidence/deepagents-20261019";
const external = new EvidenceStore(".runtime/deepagents-20261019/store");
const accepted = JSON.parse(
  await readFile(`${out}/external-library-acceptance.json`),
);
const old = await external.getRun(accepted.record.harnessRunId),
  original = await external.get(old.root);
const f = original.payload.finalCheck;
const fresh = await checkProof(f.contract, f.proof, { dependencyAudit: true });
const id = randomUUID();
const evidence = await external.put(
  "harness:kernel_recheck",
  { contract: f.contract, proof: f.proof, check: fresh, originRoot: old.root },
  [old.root],
);
const root = await external.put(
  "harness:report",
  {
    ...original.payload,
    runId: id,
    finalCheck: { ...f, check: fresh },
    modelCalls: 0,
    strategy: "received_candidate_current_audit_no_model_replay",
    originRoot: old.root,
  },
  [old.root, evidence],
);
await external.saveRun({
  ...old,
  id,
  root,
  status: "completed",
  continuedFrom: old.id,
  createdAt: new Date().toISOString(),
  tasks: [],
  modelCalls: 0,
});
const externalReplay = await replayHarness(external, id);
await writeFile(
  `${out}/external-library-final-replay.json`,
  JSON.stringify(externalReplay, null, 2),
);
await writeFile(
  `${out}/external-library-final-run.json`,
  JSON.stringify(
    {
      id,
      root,
      origin: old.id,
      verified: fresh.status,
      reproduced: externalReplay.reproduced,
      actualExternalUse:
        fresh.dependencies.direct.includes("Real.sin_sq_lt_one"),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    external: id,
    verified: fresh.status,
    reproduced: externalReplay.reproduced,
  }),
);
const store = new EvidenceStore(".runtime/original-proof-20261019/store");
const started = JSON.parse(await readFile(`${out}/yang-run.json`));
let parent;
do {
  parent = await store.getRun(started.id);
  if (parent.status === "running")
    await new Promise((r) => setTimeout(r, 1000));
} while (parent.status === "running");
if (parent.status !== "completed")
  throw Error(
    "Retest did not complete; preserve its failure before continuing",
  );
let unexpectedCalls = 0;
const service = new OriginalProofService({
  store,
  getConfig: () => modelConfig(process.cwd()),
  model: async () => {
    unexpectedCalls++;
    throw Error("Verification-only audit must not send a model request");
  },
});
const run = await service.start({
  reviewRunId: parent.reviewRunId,
  continuedFrom: parent.id,
  verificationOnly: true,
  replayUnknown: false,
});
console.log(JSON.stringify({ finalAudit: run.id, status: "started" }));
while (service.active.has(run.id))
  await new Promise((r) => setTimeout(r, 1000));
const result = await store.getRun(run.id);
await writeFile(
  `${out}/yang-final-audit.json`,
  JSON.stringify(
    {
      id: result.id,
      root: result.root,
      previousRun: parent.id,
      previousRoot: parent.root,
      status: result.status,
      summary: result.originalProofRoute?.summary,
      assembly: result.originalProofRoute?.assembly,
      unexpectedModelCalls: unexpectedCalls,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    finalAudit: result.id,
    status: result.status,
    assembly: result.originalProofRoute?.assembly?.status,
    unexpectedModelCalls: unexpectedCalls,
  }),
);
if (result.status === "completed")
  await writeFile(
    `${out}/yang-final-replay.json`,
    JSON.stringify(await service.replay(result.id), null, 2),
  );
