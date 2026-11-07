import { useState } from "react";
import { OriginalProofDetails } from "./OriginalProofDetails.jsx";
import { request } from "./api.js";
import { reviewErrorMessage } from "../shared/reading-status.mjs";
export function OriginalProofWorkflow({
  run,
  onLocate,
  onRefresh,
  onReveal,
  onNew,
  onSelectRun,
  onTask,
  runs = [],
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function control() {
    setBusy(true);
    try {
      if (run.status === "running")
        await request(`/api/original-proofs/${run.id}/cancel`, {});
      else {
        const next = await request("/api/original-proofs", {
          reviewRunId: run.reviewRunId,
          continuedFrom: run.id,
        });
        onSelectRun?.(next.id);
      }
      onRefresh?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="workflow-page workflow-embedded"
      aria-label="原证明核验进度"
    >
      <div className="workflow-heading">
        <h2>
          {run.status === "running"
            ? "正在核验原证明"
            : run.status === "completed"
              ? "原证明核验已结束"
              : "原证明核验未完成"}
        </h2>
      </div>
      {(run.tasks || [])
        .filter((t) => ["running", "queued"].includes(t.status))
        .map((t) => (
          <p key={t.id}>
            {t.title} · {t.status === "queued" ? "等待资源" : "正在执行"}
          </p>
        ))}
      {(error || run.error) && (
        <p role="alert">{reviewErrorMessage(error || run.error)}</p>
      )}
      <OriginalProofDetails
        route={run.originalProofRoute}
        onEvidence={onTask}
        tasks={[...(run.inheritedHarnessTasks || []), ...(run.tasks || [])]}
        showConclusion={false}
        onLocate={onLocate}
      />
      <div className="path-actions">
        {run.status === "completed" && (
          <button className="button primary" onClick={onReveal}>
            确定，查看结果
          </button>
        )}
        {(["running", "blocked", "interrupted", "cancelled"].includes(
          run.status,
        ) ||
          (run.status === "completed" &&
            ["partial", "route_conflict"].includes(
              run.originalProofRoute?.summary?.status,
            ))) && (
          <button disabled={busy} onClick={control}>
            {run.status === "running" ? "停止核验" : "继续未完成的核验"}
          </button>
        )}
        {run.status === "completed" && (
          <button onClick={onNew}>发起新评审</button>
        )}
      </div>
      {!!runs.length && (
        <details className="path-history">
          <summary>历史评审</summary>
          <select
            aria-label="工作流评审记录"
            value={run.id}
            onChange={(e) => onSelectRun?.(e.target.value)}
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.engine === "original-proof-v1"
                  ? "原证明核验"
                  : r.engine === "langgraph-v1"
                    ? "自主评审"
                    : "单条命题"}{" "}
                · {new Date(r.createdAt).toLocaleString("zh-CN")}
              </option>
            ))}
          </select>
          {run.root && (
            <a
              href={`/api/original-proofs/${run.id}/bundle?format=ndjson`}
              download
            >
              导出本轮证据包
            </a>
          )}
        </details>
      )}
    </section>
  );
}
