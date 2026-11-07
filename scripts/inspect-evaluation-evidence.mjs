import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../server/evidence.mjs";
import { readEvidenceFile } from "../server/evidence-io.mjs";
import { cleanReplay } from "../server/clean-replay.mjs";
import {
  evaluationTimeline,
  evaluationClosure,
  evaluationRecordBinding,
} from "../server/evaluation-report.mjs";
const [directory, output, replayDirectory] = process.argv.slice(2);
if (!directory || !output)
  throw Error("Expected RUN_DIRECTORY NEW_REPORT [NEW_REPLAY_DIRECTORY]");
const json = async (f) =>
  JSON.parse(await readFile(path.join(directory, f), "utf8"));
const [run, input, result] = await Promise.all([
  json("run.json"),
  json("acceptance-input.json"),
  json("result.json"),
]);
if (
  !input.paperSha256 ||
  run.paperSha256 !== input.paperSha256 ||
  result.paperSha256 !== input.paperSha256
)
  throw Error("Input, run and result refer to different source papers");
const bundlePath = path.join(directory, "bundle.ndjson"),
  bundle = await readEvidenceFile(bundlePath);
const root = run.root || run.failureRoot;
const recordBinding = evaluationRecordBinding(run, bundle);
const records = await Promise.all(
  (await readdir(path.join(directory, "store/runs")))
    .filter((f) => f.endsWith(".json"))
    .map((f) => json("store/runs/" + f)),
);
const activeRecords = records
  .filter((r) =>
    ["running", "queued", "preparing", "recovering"].includes(r.status),
  )
  .map((r) => ({ id: r.id, status: r.status }));
let replay = { status: "not_run", failureBundleIntegrityChecked: true };
if (replayDirectory) {
  if (activeRecords.length) throw Error("Cannot replay live records");
  try {
    replay = await cleanReplay(bundlePath, root, path.resolve(replayDirectory));
  } catch (error) {
    replay = { status: "failed", error: error.message };
  }
}
const report = {
  directory: path.resolve(directory),
  root,
  sourceBundleSha256: sha256(await readFile(bundlePath)),
  recordBinding,
  timeline: evaluationTimeline(run, records, input, result),
  closure: evaluationClosure(run, {
    integrity: true,
    recordBound: recordBinding.bound,
    replay,
    activeRecords,
    implementationUnchanged:
      Array.isArray(result.implementationChangedDuringRun) &&
      !result.implementationChangedDuringRun.length,
  }),
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(
  JSON.stringify({
    output,
    wallMs: report.timeline.wallMs,
    selectedTargetClosed: report.closure.selectedTargetClosed,
    originalProofProvidedAndVerified:
      report.closure.originalProofProvidedAndVerified,
  }),
);
