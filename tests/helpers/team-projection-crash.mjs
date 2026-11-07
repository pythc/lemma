import { TeamRuntime } from "../../server/team/runtime.mjs";
import { TeamResources } from "../../server/resources/team-resources.mjs";
import { EvidenceStore, sha256 } from "../../server/evidence.mjs";
import { randomUUID } from "node:crypto";
const runtime = new TeamRuntime({
  store: new EvidenceStore(process.argv[2]),
  resources: new TeamResources(),
  executor: {},
  mathTools: { run: async () => ({ value: "known result" }) },
  extract: async () => ({
    paperSha256: sha256("crash"),
    pageCount: 1,
    pages: [{ index: 0, text: "Engineering crash fixture" }],
  }),
});
runtime.pump = () => {};
await runtime.init();
const saved = await runtime.start({ pdfBase64: "fixture" });
const run = runtime.runs.get(saved.id),
  actor = run.tasks[0];
actor.status = "running";
const session = {
  runId: run.id,
  actorId: actor.id,
  signal: runtime.active.get(run.id).controller.signal,
  pending: new Set(),
};
const first = await runtime.operations.start(session, {
  operationId: randomUUID(),
  name: "lean_draft",
  arguments: { code: "-- controlled fixture" },
});
await runtime.operations.jobs.get(first.operationId);
// Deliberately leave the public JSON older than the acknowledged WAL state.
await runtime.store.saveRun(saved);
process.stdout.write(
  JSON.stringify({ runId: run.id, operationId: first.operationId }) + "\n",
);
process.kill(process.pid, "SIGKILL");
