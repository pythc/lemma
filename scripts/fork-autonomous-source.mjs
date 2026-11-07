// Copy a completed Agent-only source checkpoint without touching a live owner.
// There are no mathematical target/graph/proof arguments or transformations.
import { mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EvidenceStore, digest, isHash } from "../server/evidence.mjs";
import { EVIDENCE_RUNTIME } from "../server/runtime-limits.mjs";
import { validateContract } from "../server/contracts.mjs";
import { assertProofSession } from "../server/proof-autonomy.mjs";

export async function forkAutonomousSource(
  sourceDirectory,
  root,
  outputDirectory,
  ownerRunId = null,
) {
  const source = new EvidenceStore(path.resolve(sourceDirectory));
  const receipt = await source.get(root),
    p = receipt.payload;
  if (
    receipt.kind !== "original_proof_report" ||
    !p.endedAt ||
    !p.graph ||
    !p.review ||
    !p.autonomy
  )
    throw Error("A completed immutable Agent-only source report is required");
  validateContract(p.contract);
  assertProofSession(p.autonomy, { resume: p });
  if (
    p.targetHash !== p.contract.targetHash ||
    p.sourceArtifact !== p.contract.sourceArtifact
  )
    throw Error("Source checkpoint target identity changed");
  const roots = new Set([root]);
  let ownerIdentity = null,
    tasks = [];
  if (ownerRunId) {
    const owner = await source.getRun(ownerRunId);
    if (
      owner.originalProofRoute?.root !== root ||
      owner.paperSha256 !== p.paperSha256 ||
      owner.autonomy?.sessionId !== p.autonomy.sessionId
    )
      throw Error(
        "Owning source review does not match the immutable checkpoint",
      );
    ownerIdentity = {
      id: owner.id,
      sourceRoot: root,
      sourceTargetHash: p.targetHash,
      autonomy: p.autonomy,
    };
    const end = Date.parse(p.endedAt),
      start = Date.parse(p.startedAt);
    if (!Number.isFinite(end) || !Number.isFinite(start))
      throw Error("Source phase timestamps are required");
    tasks = owner.tasks.filter(
      (t) =>
        t.role?.startsWith("R06") && t.output && Date.parse(t.endedAt) <= end,
    );
    for (const t of tasks) roots.add(t.output);
    for (const file of (await readdir(path.join(source.root, "runs"))).filter(
      (f) => f.endsWith(".json"),
    )) {
      const worker = await source.getRun(file.slice(0, -5));
      if (
        worker.engine !== "deepagents-v1" ||
        worker.parentReviewId !== owner.id ||
        Date.parse(worker.createdAt) < start ||
        Date.parse(worker.createdAt) > end
      )
        continue;
      if (
        !worker.root ||
        !["completed", "blocked", "interrupted", "cancelled"].includes(
          worker.status,
        ) ||
        worker.contract?.sourceArtifact !== p.sourceArtifact ||
        (worker.contract.targetHash !== p.targetHash &&
          worker.contract.proofObligation?.rootTargetHash !== p.targetHash)
      )
        throw Error(
          "Source worker is unfinished or belongs to a different target",
        );
      const saved = await source.get(worker.root);
      if (
        !["harness:report", "harness:interrupted"].includes(saved.kind) ||
        saved.payload.runId !== worker.id ||
        saved.payload.unknownExternalOutcome
      )
        throw Error("Source worker outcome is unknown or its receipt changed");
      roots.add(worker.root);
    }
  }
  const output = path.resolve(outputDirectory);
  if (output === source.root || output.startsWith(source.root + path.sep))
    throw Error("The checkpoint copy must be outside its live source store");
  await mkdir(output, { mode: 0o700 }); // Existing output is never overwritten.
  const store = new EvidenceStore(path.join(output, "store"));
  try {
    await store.init();
    let copied = 0,
      memories = 0;
    const pending = [...roots],
      seen = new Set();
    while (pending.length) {
      const idToCopy = pending.pop();
      if (seen.has(idToCopy)) continue;
      seen.add(idToCopy);
      if (seen.size > EVIDENCE_RUNTIME.artifacts)
        throw Error("Checkpoint evidence limit exceeded");
      const a = await source.get(idToCopy);
      if (
        a.kind === "proof:memory" &&
        a.payload.branch?.autonomySession !== p.autonomy.sessionId
      )
        throw Error(
          "Source checkpoint contains proof memory from another session",
        );
      const id = await store.put(a.kind, a.payload, a.inputs);
      if (id !== a.id) throw Error("Checkpoint copy changed immutable bytes");
      copied++;
      if (a.kind === "proof:memory") {
        await mkdir(path.join(store.root, "proof-memory"), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(
          path.join(store.root, "proof-memory", id + ".json"),
          JSON.stringify({ artifact: id, scope: a.payload.scope }),
          { flag: "wx", mode: 0o600 },
        );
        memories++;
      }
      pending.push(...a.inputs);
      for (const record of [a.payload?.model, a.payload?.record])
        if (record?.source === "deepagents-js" && isHash(record.harnessRoot)) {
          roots.add(record.harnessRoot);
          pending.push(record.harnessRoot);
        }
    }
    const origin = {
      scope: "same_session_checkpoint_fork_not_a_new_fresh_sample",
      sourceStore: source.root,
      sourceRoot: root,
      sourceReportSha256: digest(p),
      paperSha256: p.paperSha256,
      targetHash: p.targetHash,
      autonomy: p.autonomy,
      copiedArtifacts: copied,
      restoredMemoryIndexes: memories,
      suppliedMathematicalEdits: 0,
      capturedAt: new Date().toISOString(),
      ownerIdentity,
      additionalReceivedRoots: [...roots].filter((r) => r !== root),
    };
    const originArtifact = await store.put(
      "autonomous_source_checkpoint_origin",
      origin,
      [...roots],
    );
    const run = {
      id: randomUUID(),
      engine: "source-checkpoint-v1",
      status: "completed",
      scope: "received_source_checkpoint_not_completed_paper_review",
      createdAt: origin.capturedAt,
      endedAt: origin.capturedAt,
      paperSha256: p.paperSha256,
      autonomy: p.autonomy,
      contract: p.contract,
      contractArtifact: p.contractArtifact,
      sourceArtifact: p.sourceArtifact,
      contextArtifact: p.contextArtifact,
      context: p.context,
      tasks: tasks.map((t) => ({
        ...t,
        originRunId: ownerRunId,
        historical: true,
      })),
      checkpointOrigin: originArtifact,
      originalProofRoute: { ...p, root },
      root: originArtifact,
    };
    await store.saveRun(run);
    const result = {
      ...origin,
      runId: run.id,
      originArtifact,
      store: store.root,
    };
    await writeFile(
      path.join(output, "checkpoint.json"),
      JSON.stringify(result, null, 2),
    );
    return result;
  } catch (error) {
    // Only this function's newly created private destination is removed.
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [source, root, output, owner] = process.argv.slice(2);
  if (!source || !root || !output)
    throw Error(
      "Usage: node scripts/fork-autonomous-source.mjs source-store source-report-root NEW-output-directory [owner-review-id]",
    );
  console.log(
    JSON.stringify(await forkAutonomousSource(source, root, output, owner)),
  );
}
