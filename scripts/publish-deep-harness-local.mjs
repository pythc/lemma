import { readFile, writeFile } from "node:fs/promises";
import { EvidenceStore } from "../server/evidence.mjs";
import { evidenceArtifacts } from "../server/evidence-io.mjs";
import { inheritedHarnessTasks } from "../server/original-proof-service.mjs";
const out = "evidence/deepagents-20261019";
const main = new EvidenceStore(".runtime");
await main.init();
const records = [];
for (const [file, folder] of [
  ["external-library-final-run.json", ".runtime/deepagents-20261019/store"],
  ["yang-final-audit.json", ".runtime/original-proof-20261019/store"],
]) {
  const item = JSON.parse(await readFile(`${out}/${file}`)),
    source = new EvidenceStore(folder),
    run = await source.getRun(item.id);
  if (run.engine === "original-proof-v1" && run.continuedFrom)
    run.inheritedHarnessTasks = inheritedHarnessTasks(
      await source.getRun(run.continuedFrom),
    );
  let copied = 0;
  const harnessIds = new Set(), copiedIds = new Set(),
    taskOutputs = [...(run.tasks || []), ...(run.inheritedHarnessTasks || [])]
      .map((task) => task.output).filter(Boolean);
  // The immutable proof DAG need not use every failed historical tool attempt.
  // Preserve those separately referenced records too, so every UI link resolves.
  for (const root of new Set([run.root, ...taskOutputs])) {
    for await (const a of evidenceArtifacts(source, root)) {
      if (copiedIds.has(a.id)) continue;
      if ((await main.put(a.kind, a.payload, a.inputs)) !== a.id)
        throw Error("Import changed evidence identity");
      copiedIds.add(a.id);
      copied++;
      if (a.kind === "harness:report") harnessIds.add(a.payload.runId);
    }
  }
  for (const id of harnessIds) {
    try {
      await main.getRun(id);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      await main.saveRun(await source.getRun(id));
    }
  }
  await main.saveRun(run);
  for (const id of taskOutputs) await main.get(id);
  records.push({
    id: run.id,
    root: run.root,
    artifacts: copied,
    engine: run.engine,
    taskLinksVerified: taskOutputs.length,
  });
  console.log(JSON.stringify(records.at(-1)));
}
await writeFile(`${out}/local-import.json`, JSON.stringify(records, null, 2));
