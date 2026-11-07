// Generic versioned continuation of Agent-only source-route checkpoints.
// This accepts identities, never mathematical targets, graphs or proof terms.
import { readFile, writeFile, mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { sha256, digest } from "../server/evidence.mjs";
import { writeEvidenceFile } from "../server/evidence-io.mjs";
import { assertProofSession } from "../server/proof-autonomy.mjs";
import {
  replayOriginalProof,
  ROUTE_LIMITS,
} from "../server/original-proof.mjs";

const [storePath, previousId, outputPath, ...flags] = process.argv.slice(2);
let mode = null,
  modelCallLimit = ROUTE_LIMITS.maxCalls,
  budgetSpecified = false;
for (const flag of flags) {
  if (flag === "--verify-only" && !mode) mode = flag;
  else if (/^--model-calls=\d+$/.test(flag) && !budgetSpecified) {
    const value = Number(flag.split("=")[1]);
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > ROUTE_LIMITS.maxCalls
    )
      throw Error(
        "Invalid model call limit: use 1 through the shared runtime ceiling",
      );
    modelCallLimit = value;
    budgetSpecified = true;
  } else throw Error("Invalid continuation option");
}
if (!storePath || !previousId || !outputPath)
  throw Error(
    "Usage: node scripts/continue-autonomous-source.mjs store previous-id NEW-output-directory [--verify-only] [--model-calls=N]",
  );
const dataRoot = path.resolve(storePath),
  out = path.resolve(outputPath);
if (out === dataRoot || out.startsWith(dataRoot + path.sep))
  throw Error("Continuation output must be outside the evidence store");
await mkdir(out, { recursive: true });
if ((await readdir(out)).length)
  throw Error("Use a new empty continuation output directory");
const implementation = {};
for (const folder of ["server", "shared"])
  for (const name of (await readdir(folder))
    .filter((f) => f.endsWith(".mjs"))
    .sort())
    implementation[`${folder}/${name}`] = sha256(
      await readFile(`${folder}/${name}`),
    );
// createApp performs crash recovery on startup. Never point an offline
// continuation process at another process's live review store.
for (const file of (await readdir(path.join(dataRoot, "runs"))).filter((f) =>
  f.endsWith(".json"),
)) {
  const run = JSON.parse(
    await readFile(path.join(dataRoot, "runs", file), "utf8"),
  );
  if (["preparing", "running", "awaiting_confirmation"].includes(run.status))
    throw Error(
      `Store contains an unfinished review ${run.id}; drain its owning service before offline continuation`,
    );
}
const app = await createApp({
  dataRoot,
  originalProofOptions: { limits: { maxCalls: modelCallLimit } },
});
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
try {
  const previous = await app.store.getRun(previousId);
  const reviewRunId =
    previous.engine === "original-proof-v1"
      ? previous.reviewRunId
      : previous.id;
  const parent = await app.store.getRun(reviewRunId);
  if (!parent.autonomy || !previous.originalProofRoute)
    throw Error("An existing Agent-only source route is required");
  assertProofSession(parent.autonomy, { resume: previous.originalProofRoute });
  const input = {
    scope: "versioned_same_session_continuation_not_a_new_fresh_sample",
    previousId,
    previousRoot: previous.root,
    previousRunSha256: digest(previous),
    reviewRunId,
    paperSha256: parent.paperSha256,
    targetHash: parent.contract.targetHash,
    autonomy: parent.autonomy,
    verificationOnly: mode === "--verify-only",
    modelCallLimit,
    replayUnknown: false,
    suppliedMathematicalEdits: 0,
    implementation,
    startedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(out, "acceptance-input.json"),
    JSON.stringify(input, null, 2),
  );
  const response = await fetch(base + "/api/original-proofs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reviewRunId,
      continuedFrom: previousId,
      verificationOnly: input.verificationOnly,
      replayUnknown: false,
    }),
  });
  const started = await response.json();
  if (!response.ok) throw Error(started.error || "Continuation did not start");
  await writeFile(
    path.join(out, "started.json"),
    JSON.stringify(
      { id: started.id, serverPort: app.server.address().port },
      null,
      2,
    ),
  );
  let run = started,
    last = "";
  while (true) {
    run = await app.store.getRun(started.id);
    const progress = JSON.stringify({
      id: run.id,
      status: run.status,
      summary: run.originalProofRoute?.summary || null,
      active: run.tasks
        .filter((t) => ["running", "queued"].includes(t.status))
        .map((t) => ({ role: t.role, tool: t.tool || null, title: t.title })),
    });
    if (progress !== last) {
      console.log(progress);
      last = progress;
    }
    if (run.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const route = run.originalProofRoute;
  let replay = null;
  if (route?.root && route.steps?.some((s) => s.check?.status === "verified")) {
    const result = await replayOriginalProof(
      await app.store.bundle(route.root),
      route.root,
    );
    replay = {
      root: result.root,
      reproduced: result.reproduced,
      allStepsVerified: result.allStepsVerified,
      replayedChecks: result.replayedChecks,
      uncheckedSteps: result.uncheckedSteps,
      steps: result.steps.map((s) => ({
        name: s.name,
        reproduced: s.reproduced,
        sameAudit: s.sameAudit,
        status: s.check?.status,
      })),
      assembly: result.assembly
        ? {
            reproduced: result.assembly.reproduced,
            status: result.assembly.check?.status || null,
          }
        : null,
    };
  }
  const drift = [];
  for (const [file, hash] of Object.entries(implementation))
    if (sha256(await readFile(file)) !== hash) drift.push(file);
  const summary = {
    ...input,
    implementationChangedDuringRun: drift,
    id: run.id,
    status: run.status,
    error: run.error || null,
    root: run.root,
    conclusion: run.conclusion || null,
    summary: route?.summary || null,
    assembly: route?.assembly?.status || null,
    theoremCheck: run.check
      ? {
          status: run.check.status,
          mode: run.check.mode,
          targetHash: run.check.targetHash,
        }
      : null,
    steps:
      route?.steps?.map((s) => ({
        name: s.name,
        title: s.title,
        status: s.status,
        leanStatus: s.check?.status || null,
        routeStatus: s.routeAssessment?.status || null,
        attempts: s.attempts,
        unknownExternalOutcome: s.unknownExternalOutcome || false,
      })) || [],
    replay,
    endedAt: new Date().toISOString(),
  };
  await writeFile(path.join(out, "run.json"), JSON.stringify(run, null, 2));
  if (run.root)
    await writeEvidenceFile(
      path.join(out, "bundle.ndjson"),
      app.store,
      run.root,
    );
  if (run.check?.status === "verified" && run.check.source)
    await writeFile(path.join(out, "exact-output.lean"), run.check.source);
  await writeFile(
    path.join(out, "result.pending.json"),
    JSON.stringify(summary, null, 2),
  );
  await rename(
    path.join(out, "result.pending.json"),
    path.join(out, "result.json"),
  );
  console.log(
    JSON.stringify({
      id: run.id,
      status: run.status,
      summary: route?.summary,
      replay,
      implementationChangedDuringRun: drift,
    }),
  );
} finally {
  await app.adaptive.close();
  await app.harness.close();
  await new Promise((resolve) => app.server.close(resolve));
}
