import { OriginalProofWorkflow } from "./OriginalProofWorkflow.jsx";
import { TeamWorkflow } from "./TeamWorkflow.jsx";
import { useState } from "react";
import { ArrowRight, GitBranch } from "@phosphor-icons/react";
import { AdaptiveWorkflow } from "./AdaptiveWorkflow.jsx";
import { LIBRARY_PROFILES } from "../shared/library-profiles.mjs";
import { dependencyTasks, RUN_LABELS } from "./reader-model.js";

export function ReviewWorkflow(props) {
  if (props.run?.engine === "team-v1") return <TeamWorkflow {...props} />;
  if (props.run?.engine === "original-proof-v1")
    return <OriginalProofWorkflow {...props} />;
  if (props.run?.engine === "langgraph-v1")
    return <AdaptiveWorkflow {...props} />;
  if (props.run) {
    const run = {
      ...props.run,
      tasks: props.run.tasks.map((t) => ({
        ...t,
        reason: t.reason || t.title,
        parents: dependencyTasks(props.run, t).map((v) => v.id),
        agent: t.agent || (t.type === "model" ? `${t.role} Agent` : t.role),
        anchors: props.run.contract
          ? [
              {
                pageIndex: props.run.contract.pageIndex,
                quote: props.run.contract.quote,
              },
            ]
          : [],
      })),
    };
    return <AdaptiveWorkflow {...props} run={run} legacy />;
  }
  return <ReviewSetup {...props} />;
}
function ReviewSetup({
  paper,
  runs,
  pageIndex,
  onStart,
  onSelectRun,
  starting,
  error,
  focusedPassage,
}) {
  const [profile, setProfile] = useState(
    paper.libraryProfile || "analysis-continuity-v1",
  );
  return (
    <section className="workflow-page workflow-embedded" aria-label="开始评审">
      <div className="workflow-topline">
        <span>
          <GitBranch size={17} />
          评审路径
        </span>
      </div>
      <div className="workflow-heading">
        <div>
          <h2>{focusedPassage ? "论证选中的原文" : "开始新一轮评审"}</h2>
          <p>
            {focusedPassage
              ? "固定这一段原文，确认命题后继续核验。"
              : "先阅读全文，再根据实际发现决定下一步检查。"}
          </p>
        </div>
      </div>
      {error && (
        <div className="workflow-error" role="alert">
          {error}
        </div>
      )}
      <form
        className="workflow-setup"
        onSubmit={(e) => {
          e.preventDefault();
          onStart({ pageIndex, ...(focusedPassage ? { profile } : {}) });
        }}
      >
        {focusedPassage && (
          <label>
            形式化知识库
            <select
              aria-label="工作流数学方向"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            >
              {LIBRARY_PROFILES.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {focusedPassage && <blockquote>{focusedPassage.quote}</blockquote>}
        <button className="button primary" disabled={starting}>
          {starting
            ? "正在创建…"
            : focusedPassage
              ? "开始局部论证"
              : "开始全文评审"}
          <ArrowRight size={16} />
        </button>
      </form>
      {!!runs.length && (
        <details className="workflow-controls">
          <summary>已有评审记录</summary>
          <select
            aria-label="工作流评审记录"
            defaultValue=""
            onChange={(e) => onSelectRun(e.target.value)}
          >
            <option value="" disabled>
              选择记录
            </option>
            {runs.map((r) => (
              <option value={r.id} key={r.id}>
                {RUN_LABELS[r.status]} ·{" "}
                {new Date(r.createdAt).toLocaleString("zh-CN")}
              </option>
            ))}
          </select>
        </details>
      )}
    </section>
  );
}
