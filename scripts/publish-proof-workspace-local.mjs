import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EvidenceStore } from "../server/evidence.mjs";
import { evidenceArtifacts } from "../server/evidence-io.mjs";
import { inheritedHarnessTasks } from "../server/original-proof-service.mjs";
const out = "evidence/proof-workspace-20261019";
const { id } = JSON.parse(await readFile(`${out}/yang-final.json`));
const source = new EvidenceStore(".runtime/original-proof-20261019/store"),
  main = new EvidenceStore(".runtime");
await main.init();
const run = await source.getRun(id);
if (run.status !== "completed")
  throw Error("Cannot publish unfinished experiment");
const previous = await source.getRun(run.continuedFrom);
run.inheritedHarnessTasks = inheritedHarnessTasks(previous);
const outputs = [...(run.tasks || []), ...(run.inheritedHarnessTasks || [])]
  .map((t) => t.output)
  .filter(Boolean);
const copied = new Set(),
  harnessRuns = new Set();
let memories = 0;
await mkdir(path.join(main.root, "proof-memory"), {
  recursive: true,
  mode: 0o700,
});
for (const root of new Set([run.root, ...outputs]))
  for await (const a of evidenceArtifacts(source, root)) {
    if (copied.has(a.id)) continue;
    if ((await main.put(a.kind, a.payload, a.inputs)) !== a.id)
      throw Error("Evidence identity changed");
    copied.add(a.id);
    if (a.kind === "proof:memory") {
      try {
        await writeFile(
          path.join(main.root, "proof-memory", `${a.id}.json`),
          JSON.stringify({ artifact: a.id, scope: a.payload.scope }),
          { flag: "wx", mode: 0o600 },
        );
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      memories++;
    }
    if (a.kind === "harness:report") harnessRuns.add(a.payload.runId);
  }
for (const hid of harnessRuns) await main.saveRun(await source.getRun(hid));
await main.saveRun(previous);
await main.saveRun(run);
for (const output of outputs) await main.get(output);
const receipt = {
  id: run.id,
  root: run.root,
  artifacts: copied.size,
  memories,
  taskLinksVerified: outputs.length,
};
await writeFile(`${out}/local-import.json`, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
