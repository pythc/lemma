import { writeFile, mkdir } from "node:fs/promises";
import {
  moduleManifest,
  ensureDomainModules,
} from "../server/domain-library.mjs";
import { createContract } from "../server/contracts.mjs";
import { inspectTarget } from "../server/lean-query.mjs";
import { MATHLIB_COMMIT } from "../shared/library-profiles.mjs";
const destination = new URL(
  "../evidence/domain-expansion-20261017/" +
    (process.argv.includes("--recheck")
      ? "cache-recheck.json"
      : "cache-acquisition.json"),
  import.meta.url,
);
const modules = await moduleManifest([
  "Mathlib.Analysis.Convex.Function",
  "Mathlib.MeasureTheory.Integral.IntervalIntegral.AbsolutelyContinuousFun",
]);
console.log("Preparing two pinned mathlib modules; no model request.");
const acquisition = await ensureDomainModules(modules);
console.log(`Cache ready: ${acquisition.acquisition}`);
const contract = createContract(
  {
    paperSha256: "a".repeat(64),
    pageIndex: 0,
    artifact: "b".repeat(64),
    text: "Environment probe only; not a paper review.",
  },
  {
    label: "Environment probe",
    quote: "Environment probe only; not a paper review.",
    statement: "只检查新模块中的定义可用性",
    assumptions: [],
    leanTarget: "True",
    ambiguity: "",
  },
  "analysis-continuity-v1",
  { contextArtifact: "c".repeat(64), translationArtifact: "d".repeat(64) },
  {
    context: {
      schemaVersion: "lemma.domain.v1",
      revision: MATHLIB_COMMIT,
      modules,
      definitions: [],
      lemmas: [],
    },
    artifact: "e".repeat(64),
  },
);
const inspection = await inspectTarget(contract, {
  names: ["ConvexOn", "AbsolutelyContinuousOnInterval"],
  definitions: ["ConvexOn", "AbsolutelyContinuousOnInterval"],
});
await mkdir(
  new URL("../evidence/domain-expansion-20261017/", import.meta.url),
  { recursive: true },
);
await writeFile(
  destination,
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      purpose: "module_availability_only_not_real_paper_verification",
      acquisition,
      inspection,
    },
    null,
    2,
  ) + "\n",
);
if (inspection.status !== "well_typed")
  throw new Error(JSON.stringify(inspection));
console.log("Both actual definition signatures were returned by Lean.");
