import { writeEvidenceFile } from "../server/evidence-io.mjs";
// Real source-driven review, no hand-authored proof graph or semantic signatures.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { EvidenceStore } from "../server/evidence.mjs";
import { OriginalProofService } from "../server/original-proof-service.mjs";
import { modelConfig } from "../server/model.mjs";
const dir = "evidence/original-proof-20261019";
await mkdir(dir, { recursive: true });
const store = new EvidenceStore(".runtime/original-proof-20261019/store");
await store.init();
const sources = [
  [
    "bolzano-weierstrass",
    "evidence/anchor-scheduler-20261019/bolzano-weierstrass-evidence.json",
  ],
  ["yang-zhu", "evidence/yang-recursive-20261019/yang-zhu-proof-evidence.json"],
];
const service = new OriginalProofService({
  store,
  getConfig: () => modelConfig(process.cwd()),
});
const runs = [];
for (const [name, file] of sources) {
  const b = JSON.parse(await readFile(file));
  if (!b.artifacts.some((a) => a.kind === "review_report"))
    throw Error("Missing historical report");
}
for (const [name, file] of sources) {
  const b = JSON.parse(await readFile(file));
  for (const a of b.artifacts)
    if ((await store.put(a.kind, a.payload, a.inputs)) !== a.id)
      throw Error("Source identity changed");
  const root = b.artifacts.find((a) => a.kind === "review_report").payload;
  const parent = {
    ...root,
    id: root.runId,
    context: b.artifacts.find((a) => a.id === root.contextArtifact).payload,
    sourceArtifact: root.contract.sourceArtifact,
    createdAt: new Date().toISOString(),
    status: "completed",
    tasks: [],
  };
  await store.saveRun(parent);
  const r = await service.start({ reviewRunId: parent.id });
  runs.push({ name, id: r.id });
  await writeFile(
    `${dir}/${name}-start.json`,
    JSON.stringify({ sourceRoot: b.root, ...r }, null, 2),
  );
  console.log(JSON.stringify({ name, id: r.id, started: true }));
}
let last = "";
while (service.active.size) {
  const states = [];
  for (const { name, id } of runs) {
    const r = await store.getRun(id);
    states.push({
      name,
      status: r.status,
      stage: r.tasks.filter((t) => t.status === "running").map((t) => t.title),
      steps: r.originalProofRoute?.steps?.map((s) => [s.name, s.status]) || [],
    });
  }
  const state = JSON.stringify(states);
  if (state !== last) console.log(state);
  last = state;
  await new Promise((r) => setTimeout(r, 2000));
}
for (const { name, id } of runs) {
  const r = await store.getRun(id);
  await writeFile(`${dir}/${name}-result.json`, JSON.stringify(r, null, 2));
  if (r.root)
    await writeEvidenceFile(`${dir}/${name}-bundle.ndjson`, store, r.root);
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
    const replay = await service.replay(id);
    await writeFile(
      `${dir}/${name}-replay.json`,
      JSON.stringify(replay, null, 2),
    );
    console.log(JSON.stringify({ name, replay: replay.reproduced }));
  }
}
await writeFile(`${dir}/runs.json`, JSON.stringify(runs, null, 2));
