import { durableFile } from "../durable-files.mjs";
import { readFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  exportEvidenceSegments,
  verifyEvidenceSegments,
} from "../evidence-stream.mjs";
import { writeEvidenceFile } from "../evidence-io.mjs";
import { evaluationInventoryFromStore } from "./evaluation-report.mjs";
import { operationSettled } from "./operations.mjs";
export async function atomicJson(file, data) {
  await durableFile(file, JSON.stringify(data, null, 2));
}
async function readOptional(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
// Delivery retries consume only already sealed evidence. Replay dispatch has its
// own durable intent; a lost acknowledgement is UNKNOWN, never silently rerun.
export async function finalizeTeamPaper({
  team,
  store,
  runId,
  out,
  metadata = {},
  signal,
}) {
  await mkdir(out, { recursive: true });
  const run = await team.load(runId);
  if (
    !run.root ||
    ["running", "pausing", "resuming"].includes(run.status) ||
    run.operations.some((o) => !operationSettled(o.status))
  )
    throw Error("Finalization requires settled sealed evidence");
  const stateFile = path.join(out, "finalization.json");
  let state = await readOptional(stateFile);
  if (state?.root && state.root !== run.root)
    throw Error("Finalization root changed");
  state = {
    schema: "lemma.delivery.v2",
    ...state,
    root: run.root,
    runId,
    runStopped: true,
    evidenceSealed: true,
    status: "in_progress",
  };
  const deliveryFile = path.join(store.root, "deliveries", runId + ".json");
  await mkdir(path.dirname(deliveryFile), { recursive: true });
  const save = async () => {
    await atomicJson(stateFile, state);
    await atomicJson(deliveryFile, state);
  };
  await atomicJson(path.join(out, "result.json"), run);
  await save();
  const reportFile = path.join(out, "result-report.json");
  let report = await readOptional(reportFile);
  if (!report) {
    report = {
      runId,
      root: run.root,
      status: run.status,
      model: run.model,
      conclusion: run.conclusion,
      continuations: run.continuations || [],
      account: run.account,
      objectives: run.objectives,
      submissions: run.submissions,
      paperSha256: run.paperSha256,
      wholePaperVerified: false,
      inventoryStatus: "not_run",
      exportStatus: "not_run",
      replay: { status: "not_run", results: [] },
      ...metadata,
      countingBoundary:
        "Operation invocations, receipt identities and reused results are separate; auxiliary targets are not paper propositions.",
    };
    await atomicJson(reportFile, report);
  }
  const publishReport = async () => {
    await atomicJson(reportFile, report);
    await atomicJson(path.join(out, "report-state.json"), {
      root: run.root,
      status: "generated",
    });
    await durableFile(
      path.join(out, "result-report.md"),
      `# 自主评审结果\n\n评审状态：${run.status}。数学结果按精确范围报告，不由退出状态推定整篇通过。\n\n${run.conclusion?.summary || "尚未形成完整数学结论。"}\n\n证据根：${run.root}\n\n导出：${report.exportStatus}；终态重放：${report.replay.status}。\n\n详情与继承边界见 result-report.json；工程验收不代表论文证明。\n`,
    );
  };
  await publishReport();
  state.report = "generated";
  await save();
  try {
    if (report.inventoryStatus !== "complete") {
      const inventory = await evaluationInventoryFromStore(store, run.root, {
        signal,
      });
      report.inventoryStatus = "complete";
      report.distinctReceiptInventory = inventory;
      report.exactCheckCalls = run.operations
        .filter((o) => o.name === "check_lean")
        .map((o) => ({
          id: o.id,
          status: o.status,
          resultSummary: o.resultSummary || null,
          nativeKernelSpans: (o.nativeTimings || []).filter(
            (s) => s.name === "native.kernel",
          ).length,
        }));
    }
    state.inventory = "complete";
    delete state.inventoryError;
  } catch (e) {
    state.inventory = "failed";
    state.inventoryError = e.message;
    report.inventoryStatus = "failed";
  }
  await save();
  await publishReport();
  // Inventory, byte export and mathematical replay have independent outcomes.
  // Failure to decode an oversized summary must not suppress the raw archive.
  try {
    if (state.export === "complete")
      await verifyEvidenceSegments(path.join(out, "bundle-segments"), {
        signal,
      });
    if (state.export !== "complete") {
      const manifest = await exportEvidenceSegments(
        store,
        run.root,
        path.join(out, "bundle-segments"),
        { signal },
      );
      state.exportManifest = manifest;
    }
    const bundleFile = path.join(out, "bundle.json");
    let bundleMatches = false;
    if (state.bundleSha256) {
      try {
        bundleMatches = (await fileDigest(bundleFile)) === state.bundleSha256;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    if (!bundleMatches) {
      await writeEvidenceFile(
        path.join(out, "bundle.json"),
        store,
        run.root,
        "json",
      );
      state.bundleSha256 = await fileDigest(bundleFile);
    }
    state.export = "complete";
    delete state.exportError;
    report.exportStatus = "complete";
    await save();
    await publishReport();
  } catch (e) {
    state.export = "failed";
    state.exportError = e.message;
    report.exportStatus = "failed";
    await save();
    await publishReport();
  }
  const replayFile = path.join(out, "replay-state.json");
  let replayState = (await readOptional(replayFile)) || {
    root: run.root,
    items: {},
  };
  if (replayState.root !== run.root)
    throw Error("Replay checkpoint root mismatch");
  for (const item of Object.values(replayState.items))
    if (item.status === "dispatching") {
      item.status = "unknown";
      item.reason = "Replay acknowledgement was lost; no automatic reissue";
    }
  await atomicJson(replayFile, replayState);
  const results = [];
  // Resolve accepted reuse chains without treating a reuse receipt as native.
  const pending = run.submissions
      .filter((s) => s.status === "pass" && !s.superseded)
      .flatMap((s) => s.replayIds || []),
    seen = new Set();
  while (pending.length) {
    const id = pending.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    let a;
    try {
      a = await store.get(id);
      if (
        a.kind !== "team:lean_reuse" &&
        (a.kind !== "team:lean" || a.payload.runId !== runId)
      )
        throw Error("Replay candidate is not a native receipt for this review");
    } catch (e) {
      results.push({
        previous: id,
        status: "invalid_candidate",
        nativeCheckExecuted: false,
        reason: e.message,
      });
      continue;
    }
    if (a.kind === "team:lean_reuse") {
      results.push({
        previous: id,
        nativeCheckExecuted: false,
        scope: "reuse_receipt",
        originalProofReceipt: a.payload.result.originalProofReceipt,
      });
      pending.push(a.payload.result.originalProofReceipt);
      continue;
    }
    let item = replayState.items[id];
    if (!item) {
      item = replayState.items[id] = {
        previous: id,
        status: "dispatching",
        startedAt: new Date().toISOString(),
      };
      await atomicJson(replayFile, replayState);
      try {
        signal?.throwIfAborted();
        const p = a.payload.result,
          result = await team.math.checker(p.contract, p.proof, {
            mode: p.mode,
            dependencyAudit: true,
            signal,
          });
        const artifact = await store.put(
          "team:replay",
          { runId, previous: id, result },
          [id],
        );
        Object.assign(item, {
          status: result.status,
          artifact,
          targetHash: result.targetHash,
          nativeCheckExecuted: true,
          endedAt: new Date().toISOString(),
        });
      } catch (e) {
        Object.assign(item, {
          status: "unknown",
          reason: e.message,
          nativeCheckExecuted: null,
        });
      }
      await atomicJson(replayFile, replayState);
    }
    results.push(item);
  }
  report.replay = {
    status: results.some((r) =>
      ["unknown", "invalid_candidate"].includes(r.status),
    )
      ? "incomplete"
      : "complete",
    results,
    scope: "exact_formal_targets_only",
  };
  await durableFile(
    path.join(out, "replay.jsonl"),
    results.map((item) => JSON.stringify(item) + "\n").join(""),
  );
  state.replay = report.replay.status;
  state.status =
    state.inventory === "complete" &&
    state.export === "complete" &&
    state.replay === "complete"
      ? "complete"
      : "incomplete";
  state.completedAt = new Date().toISOString();
  await publishReport();
  await save();
  return state;
}
