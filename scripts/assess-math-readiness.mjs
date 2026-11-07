import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentTree } from "../server/toolchain-tree.mjs";
import { EVALUATION_CODE_PATHS } from "../server/evaluation-registration.mjs";
import { assessMathReadiness } from "../server/math-readiness.mjs";
import { sha256 } from "../server/evidence.mjs";
const [directory, output] = process.argv.slice(2);
if (!directory || !output)
  throw Error("Expected EVIDENCE_DIRECTORY NEW_REPORT");
const receipts = [];
async function read(name, optional = false) {
  try {
    const bytes = await readFile(path.join(directory, name));
    receipts.push({ path: name, sha256: sha256(bytes) });
    return JSON.parse(bytes);
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
}
const freeze = await read("freeze.json"),
  selections = await read("readiness-selection.json");
const relative = (p) => {
  if (
    typeof p !== "string" ||
    path.isAbsolute(p) ||
    p.split(/[\\/]/).includes("..")
  )
    throw Error("Invalid readiness receipt path");
  return p;
};
const development = relative(selections.development),
  boundary = relative(selections.boundary);
const e = {
  implementation: freeze.implementation.sha256,
  currentImplementation: (
    await contentTree(process.cwd(), EVALUATION_CODE_PATHS)
  ).sha256,
  engineering: await read("engineering/result.json", true),
  engineeringVersion: selections.engineeringVersion,
  native: await read("native-readiness/result.json", true),
  development: await read(development + "/result.json", true),
  developmentVersion: (await read(development + "/plan.json", true))
    ?.implementation?.sha256,
  boundary: await read(boundary + "/report.json", true),
  formal: await read("formal/report.json", true),
  ledger: await read("ledger/ledger.json"),
  preservation: await read("preservation-check.json", true),
  startPlan: await read("raw-pdf-start-plan.json", true),
};
const report = {
  ...assessMathReadiness(e),
  createdAt: new Date().toISOString(),
  evidenceRoot: path.resolve(directory),
  evidenceReceipts: receipts,
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(
  JSON.stringify({
    ready: report.ready,
    items: report.items,
    calls: report.calls,
  }),
);
