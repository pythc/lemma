import { copyArtifactFile } from "../evidence-raw.mjs";
import { durableFile } from "../durable-files.mjs";
import path from "node:path";
import { ActionJournal } from "./action-journal.mjs";
import { mkdir, lstat, writeFile, readFile } from "node:fs/promises";
import { EvidenceStore, digest, sha256 } from "../evidence.mjs";

const terminalTasks = new Set([
  "completed",
  "failed",
  "cancelled",
  "unresolved",
]);
const terminalOperations = new Set([
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);

export function validateCheckpoint(
  run,
  report,
  expectedRoot,
  { pauseAuthorization = null } = {},
) {
  if (run.engine !== "team-v1" || ![6, 7].includes(run.protocolVersion))
    throw Error("Unsupported team checkpoint protocol");
  const userPause =
    run.status === "cancelled" &&
    pauseAuthorization?.schema === "lemma.user-pause-archive.v1" &&
    pauseAuthorization.runId === run.id &&
    pauseAuthorization.root === expectedRoot &&
    ["pause_for_redesign_plan", "user_pause_checkpoint"].includes(
      pauseAuthorization.userIntent,
    ) &&
    pauseAuthorization.runnerExited === true &&
    pauseAuthorization.ownedProcessesRemaining === 0;
  if (
    !(
      run.status === "interrupted" ||
      (run.protocolVersion === 7 && run.status === "paused") ||
      userPause
    ) ||
    !expectedRoot ||
    run.root !== expectedRoot
  )
    throw Error("Resume requires the expected sealed interrupted checkpoint");
  if (report.kind !== "team:report" || report.payload.runId !== run.id)
    throw Error("Checkpoint report identity mismatch");
  for (const key of [
    "status",
    "model",
    "tasks",
    "targets",
    "objectives",
    "operations",
    "submissions",
    "turns",
    "resourcePolicy",
    "conclusion",
  ])
    if (digest(report.payload[key]) !== digest(run[key]))
      throw Error(`Checkpoint changed after sealing: ${key}`);
  if (run.protocolVersion >= 7)
    for (const key of [
      "protocolVersion",
      "account",
      "pause",
      "journalRoot",
      "journalThrough",
    ])
      if (digest(report.payload[key] ?? null) !== digest(run[key] ?? null))
        throw Error(`Checkpoint changed after sealing: ${key}`);
  if (
    run.continuations &&
    digest(report.payload.continuations) !== digest(run.continuations)
  )
    throw Error("Checkpoint continuation history changed after sealing");
  if (
    !run.tasks.every((t) => terminalTasks.has(t.status)) ||
    !run.operations.every((o) => terminalOperations.has(o.status)) ||
    run.turns.some((t) => t.status === "running")
  )
    throw Error("Checkpoint contains unsettled work");
  if (run.tasks.filter((t) => t.role === "main").length !== 1)
    throw Error("Checkpoint must have one coordinator");
  if (
    run.model.provider !== "codex-cli" ||
    typeof run.model.model !== "string" ||
    !run.model.model ||
    typeof run.model.reasoningEffort !== "string" ||
    !run.model.reasoningEffort
  )
    throw Error("Checkpoint model differs from the requested team adapter");
  if (
    !Number.isFinite(run.account?.startedAt) ||
    !Number.isInteger(run.account?.turns) ||
    run.account.turns < 0
  )
    throw Error("Checkpoint budget account is missing");
  if (run.ownerPid && run.ownerPid !== process.pid) {
    try {
      process.kill(run.ownerPid, 0);
      throw Error("Original checkpoint owner is still alive");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

// Copies immutable public artifacts, never initializes or recovers the parent.
// The logical review ID is retained; the execution segment and evidence store
// are new. A durable single-successor claim prevents duplicate model dispatch.
export async function forkCheckpoint({
  sourceRoot,
  destinationRoot,
  runId,
  paperSha256,
  claimRoot,
  pauseAuthorization = null,
}) {
  sourceRoot = path.resolve(sourceRoot);
  destinationRoot = path.resolve(destinationRoot);
  if (
    destinationRoot === sourceRoot ||
    destinationRoot.startsWith(sourceRoot + path.sep)
  )
    throw Error("Checkpoint destination must be outside the parent archive");
  const source = new EvidenceStore(sourceRoot);
  const run = await source.getRun(runId);
  const report = await source.get(run.root);
  validateCheckpoint(run, report, run.root, { pauseAuthorization });
  if (pauseAuthorization) {
    const raw = await readFile(path.join(sourceRoot, "runs", `${runId}.json`));
    if (sha256(raw) !== pauseAuthorization.publicRunSha256)
      throw Error(
        "User-pause authorization does not bind these archived bytes",
      );
    const at = Date.parse(pauseAuthorization.settledAt);
    if (!Number.isFinite(at) || at < run.account.startedAt || at > Date.now())
      throw Error("Invalid user-pause budget boundary");
  }
  const paper = await source.get(run.sourceArtifact);
  if (
    paper.kind !== "paper_source" ||
    paper.payload.paperSha256 !== paperSha256 ||
    sha256(Buffer.from(paper.payload.pdfBase64, "base64")) !== paperSha256
  )
    throw Error("Checkpoint PDF bytes differ from the requested paper");
  try {
    await lstat(destinationRoot);
    throw Error("Checkpoint destination already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const destination = new EvidenceStore(destinationRoot);
  await destination.init();
  const pending = [run.root],
    seen = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const artifact = await copyArtifactFile(
      path.join(sourceRoot, "artifacts", id + ".json"),
      path.join(destinationRoot, "artifacts", id + ".json"),
      id,
      { immutable: true },
    );
    pending.push(...artifact.inputs);
  }
  if (run.protocolVersion >= 7 && run.journalRoot) {
    const segments = [];
    let cursor = run.journalRoot;
    while (cursor) {
      const a = await source.get(cursor);
      if (a.kind !== "team:event_segment" || a.payload.runId !== runId)
        throw Error("Invalid action journal ancestry");
      segments.push(cursor);
      cursor = a.payload.previous;
    }
    const journal = new ActionJournal(destinationRoot);
    try {
      for (const id of segments.reverse()) {
        const a = await source.get(id);
        await journal.call("importEvents", { runId, events: a.payload.events });
      }
    } finally {
      await journal.close();
    }
  }
  await destination.saveRun(run);
  if (pauseAuthorization)
    await durableFile(
      path.join(destinationRoot, "pause-authorization.json"),
      JSON.stringify(pauseAuthorization),
      { immutable: true },
    );
  await mkdir(claimRoot, { recursive: true, mode: 0o700 });
  const claimFile = path.join(claimRoot, `${run.root}.json`);
  await durableFile(
    claimFile,
    JSON.stringify({
      parentRoot: run.root,
      runId,
      destinationRoot,
      ownerPid: process.pid,
      phase: "prepared_before_model_dispatch",
      at: new Date().toISOString(),
    }),
    { immutable: true },
  ).catch((error) => {
    if (error.code === "EEXIST")
      throw Error(
        `Checkpoint already has a continuation claim; inspect ${claimFile} instead of starting another model request`,
      );
    throw error;
  });
  return {
    runId,
    parentRoot: run.root,
    claimFile,
    copiedArtifacts: seen.size,
    inheritedOperationCount: run.operations.length,
    inheritedReceiptCount: run.receipts.length,
    inheritedTurnCount: run.turns.length,
    inheritedBudgetAccount: run.account,
  };
}
