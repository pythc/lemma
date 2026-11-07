import { writeEvidenceFile } from "../server/evidence-io.mjs";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { EvidenceStore } from "../server/evidence.mjs";
import { OriginalProofService } from "../server/original-proof-service.mjs";
import { modelConfig } from "../server/model.mjs";
const out = "evidence/original-proof-20261019";
await mkdir(out, { recursive: true });
const store = new EvidenceStore(".runtime/original-proof-20261019/store");
await store.init();
const names = [
  ["bolzano-weierstrass", "d86aa281-4a93-4786-84a5-a8e6c6a9cce2"],
  ["yang-zhu", "5df98922-c640-465d-a076-ed937f39975c"],
];
const service = new OriginalProofService({
  store,
  getConfig: () => modelConfig(process.cwd()),
});
const targets = [];
for (const [name, id] of names) {
  const previous = await store.getRun(id);
  if (previous.status === "running") {
    previous.status = "interrupted";
    previous.error =
      "迁移到压缩依赖与独立编译诊断版本；复用已完成步骤和已收到候选。已向用户明示保留未返回调用的中断记录。";
    for (const t of previous.tasks)
      if (["running", "queued"].includes(t.status)) {
        t.status = "interrupted";
        t.externalOutcome = t.modelStartedAt
          ? "unknown"
          : "not_sent_or_local_tool_only";
      }
  }
  const pairs = [];
  for (const t of previous.tasks.filter(
    (t) => t.role === "R06_ALIGN" && t.status === "succeeded",
  )) {
    const review = await store.get(t.output);
    const gtask = previous.tasks.find(
      (g) =>
        g.role === "R06_GRAPH" && g.output && review.inputs.includes(g.output),
    );
    if (gtask) {
      const g = await store.get(gtask.output);
      pairs.push({
        targetHash: previous.contract.targetHash,
        graph: g.payload.graph,
        graphArtifact: gtask.output,
        review: review.payload.review,
        reviewArtifact: t.output,
        steps: [],
      });
    }
  }
  if (
    !previous.originalProofRoute?.graph ||
    !previous.originalProofRoute?.review
  ) {
    if (!pairs.length)
      throw Error("No completed source graph/review checkpoint");
    previous.originalProofRoute = pairs.at(-1);
  }
  previous.root = await store.put(
    "original_proof_migration_checkpoint",
    {
      runId: id,
      reason: previous.error,
      route: previous.originalProofRoute,
      unknownExternalTasks: previous.tasks
        .filter((t) => t.externalOutcome === "unknown")
        .map((t) => t.id),
    },
    [
      previous.sourceArtifact,
      previous.contractArtifact,
      previous.contextArtifact,
      ...previous.tasks.map((t) => t.output).filter(Boolean),
    ],
  );
  await store.saveRun(previous);
  await writeFile(
    `${out}/${name}-diagnostics-migration.json`,
    JSON.stringify(previous, null, 2),
  );
  const run = await service.start({
    reviewRunId: previous.reviewRunId,
    continuedFrom: previous.id,
  });
  targets.push({ name, id: run.id });
  console.log(JSON.stringify({ name, id: run.id, continuedFrom: id }));
}
let last = "";
while (service.active.size) {
  const states = [];
  for (const { name, id } of targets) {
    const r = await store.getRun(id);
    states.push({
      name,
      status: r.status,
      active: r.tasks
        .filter((t) => ["running", "queued"].includes(t.status))
        .map((t) => [t.role, t.title, t.status]),
      steps: r.originalProofRoute?.steps?.map((s) => [s.name, s.status]) || [],
    });
  }
  const state = JSON.stringify(states);
  if (state !== last) console.log(state);
  last = state;
  await new Promise((r) => setTimeout(r, 2000));
}
for (const { name, id } of targets) {
  const r = await store.getRun(id);
  await writeFile(`${out}/${name}-result.json`, JSON.stringify(r, null, 2));
  await writeEvidenceFile(`${out}/${name}-bundle.ndjson`, store, r.root);
  console.log(
    JSON.stringify({
      name,
      status: r.status,
      error: r.error,
      summary: r.originalProofRoute?.summary,
      root: r.root,
    }),
  );
  if (r.status === "completed") {
    try {
      const replay = await service.replay(id);
      await writeFile(
        `${out}/${name}-replay.json`,
        JSON.stringify(replay, null, 2),
      );
      console.log(JSON.stringify({ name, replay: replay.reproduced }));
    } catch (e) {
      await writeFile(
        `${out}/${name}-replay-error.json`,
        JSON.stringify({ error: e.message }),
      );
      console.log(JSON.stringify({ name, replayError: e.message }));
    }
  }
}
await writeFile(`${out}/runs.json`, JSON.stringify(targets, null, 2));
