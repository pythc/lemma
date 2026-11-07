import { OriginalProofDetails } from "./OriginalProofDetails.jsx";
import { TeamSummary } from "./TeamWorkflow.jsx";
import { reviewOutcome, claimVerdict } from "../shared/review-outcome.mjs";
import { CsReviewSummary } from "./CsReviewPanel.jsx";
import {
  ArrowRight,
  FileText,
  CheckCircle,
  WarningCircle,
} from "@phosphor-icons/react";

import {
  readingStatus,
  readingLimitations,
  reviewErrorMessage,
} from "../shared/reading-status.mjs";

export function ReviewSummary({
  run,
  onLocate,
  onDetails,
  onCoverage,
  onAnnotations,
  onRetry,
  onOriginalReview,
  onEvidence,
  onReplay,
  busy,
}) {
  const result = run.conclusion || {};
  if (run.engine === "team-v1")
    return <TeamSummary run={run} onDetails={onDetails} onLocate={onLocate} />;
  if (run.engine === "cs-review-v1")
    return <CsReviewSummary run={run} onReplay={onReplay} busy={busy} />;
  if (run.engine === "langgraph-v1") {
    const reading = readingStatus(run);
    const outcome = reviewOutcome(run);
    const limitations = [
      ...(!reading.failed
        ? ["评审仅覆盖已检查内容，AI 判断不等于数学证明。"]
        : []),
      ...(result.limitations || []).filter(
        (v) =>
          !/^(阅读全部可提取文本|模型意见与独立复核|原证明未逐步机器形式化|缺少文本的页面|未提取到文本的页面|尚未完成阅读的页面|第 \d.* 页：)/.test(
            v,
          ),
      ),
      ...readingLimitations(run),
    ];
    return (
      <section className="result-summary" aria-label="本次评审结论">
        <h2>
          {reading.failed || outcome.interrupted
            ? "评审未完成"
            : reading.incomplete
              ? "部分评审结果"
              : "评审结果"}
        </h2>
        <p className="result-scope">
          {reading.failed
            ? "正文阅读失败，尚未生成评审结论。"
            : outcome.interrupted
              ? outcome.message
              : "各项结论及其依据如下。"}
        </p>
        {reading.incomplete && (
          <p className="result-reading-warning" role="status">
            <WarningCircle size={18} />
            {reading.failed
              ? reviewErrorMessage(
                  reading.gaps[0]?.reason || "请检查论文文本后重试。",
                )
              : "部分页面尚未完成阅读，以下结果仅覆盖已检查内容。"}
          </p>
        )}
        {outcome.unresolved.length > 0 && (
          <details className="result-more">
            <summary>尚未完成的核查</summary>
            <ul>
              {outcome.unresolved.map((o, i) => (
                <li key={i}>
                  {run.claims?.find((c) => c.id === o.claimId)?.label ||
                    "所选目标"}{" "}
                  ·{" "}
                  {{
                    fidelity: "原文忠实性",
                    theorem: "目标证明或否定",
                    author_route: "作者证明路线",
                    selected_scope: "核查范围",
                  }[o.kind] || o.kind}
                </li>
              ))}
            </ul>
          </details>
        )}
        {!reading.failed && !(run.claims || []).length && (
          <p>
            {reading.incomplete
              ? "已读部分暂未识别到可核查命题。"
              : "已读取文本中未识别到可核查命题。"}
          </p>
        )}
        {(run.claims || []).map((c) => (
          <section key={c.id}>
            <h3>{c.label}</h3>
            <p>{c.statement}</p>
            <p className="claim-verdict">{claimVerdict(c)}</p>
            <button
              className="source-locate"
              onClick={() => onLocate(c.anchor.pageIndex, c.anchor.quote)}
            >
              查看原文 · 第 {c.anchor.pageIndex + 1} 页
            </button>
            <OriginalProofDetails
              route={c.formalResult?.originalProofRoute}
              onEvidence={onEvidence}
              onLocate={onLocate}
            />
            {c.formalResult?.id && !c.formalResult.originalProofRoute && (
              <button onClick={() => onOriginalReview?.(c.formalResult.id)}>
                核验原证明
              </button>
            )}
            <details className="result-more">
              <summary>判断依据</summary>
              {c.independentReview && <p>{c.independentReview.summary}</p>}
              {result.coverage?.find((v) => v.claimId === c.id) && (
                <p>{result.coverage.find((v) => v.claimId === c.id).reason}</p>
              )}
              <p>
                Lean 核验：
                {c.formalResult?.check &&
                ("exitCode" in c.formalResult.check ||
                  c.formalResult.check.parser)
                  ? c.formalResult.check.status === "verified"
                    ? "该目标已通过"
                    : "已执行，未取得证明"
                  : "未执行"}
              </p>
            </details>
          </section>
        ))}
        {reading.failed && (
          <div className="result-actions">
            <button className="button primary" onClick={onRetry}>
              重新评审
            </button>
          </div>
        )}
        <details className="result-more">
          <summary>{reading.failed ? "失败详情" : "评审范围与说明"}</summary>
          <ul>
            {limitations.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
          <a
            className="source-locate"
            href={`/api/reviews/${run.id}/bundle?format=ndjson`}
            download
          >
            导出评审依据
          </a>
        </details>
      </section>
    );
  }

  return (
    <section className="result-summary" aria-label="本次评审结论">
      <p className="result-eyebrow">
        {reviewOutcome(run).interrupted ? (
          <WarningCircle size={17} />
        ) : (
          <CheckCircle size={17} />
        )}
        {reviewOutcome(run).interrupted
          ? "本次核查未完成，部分结果已保存"
          : "本次范围核查已完成"}
      </p>
      <h2>
        {run.originalProofRoute?.summary?.headline ||
          result.headline ||
          "本次评审结果待核查"}
      </h2>
      <p className="result-scope">
        核查范围：第 {run.pageIndex + 1} 页 ·{" "}
        {run.contract?.label || "选定命题"}。不代表整篇论文已验证。
      </p>
      <dl className="result-dimensions">
        <div>
          <dt>原文与命题是否一致</dt>
          <dd>
            {run.originalProofRoute?.review ||
            run.approval?.authority ===
              "autonomous_agent_semantic_assessment_not_human"
              ? "Agent 已复核"
              : run.approval
                ? "人工已确认"
                : "尚未确认"}
          </dd>
        </div>
        <div>
          <dt>原论文的证明</dt>
          <dd>
            {run.originalProofRoute?.summary
              ? {
                  verified_route: "所选路线已核验",
                  verified_with_completion: "所选路线补全后通过",
                  has_problem: "局部命题有已核验反例",
                  source_proof_missing: "所选来源未提供作者证明",
                  route_conflict: "生成的证明路线存在冲突",
                  partial: "已部分核验，尚未闭环",
                }[run.originalProofRoute.summary.status] || "尚未完成核验"
              : run.originalProof?.status === "gap_candidate"
                ? "存在候选疑点，需要复核"
                : "尚未机器验证"}
          </dd>
        </div>
        <div>
          <dt>形式化命题</dt>
          <dd>
            {{
              formalized_proved: "形式化已证明",
              refuted: "原命题的否定已证明",
            }[result.theorem] || "尚无确定结论"}
          </dd>
        </div>
      </dl>
      <OriginalProofDetails
        route={run.originalProofRoute}
        tasks={[...(run.inheritedHarnessTasks || []), ...(run.tasks || [])]}
        onEvidence={onEvidence}
        onLocate={onLocate}
      />
      {run.contract && !run.originalProofRoute && (
        <button onClick={() => onOriginalReview?.(run.id)}>核验原证明</button>
      )}
      {run.contract && (
        <section>
          <h3>对应原文</h3>
          <blockquote>{run.contract.quote}</blockquote>
          <button
            className="source-locate"
            onClick={() => onLocate(run.contract.pageIndex, run.contract.quote)}
          >
            <FileText size={16} />
            定位到第 {run.contract.pageIndex + 1} 页<ArrowRight size={15} />
          </button>
        </section>
      )}
      {!!result.limitations?.length && (
        <section>
          <h3>仍需留意</h3>
          <ul>
            {result.limitations.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </section>
      )}
      <button className="button primary" onClick={onAnnotations}>
        查看原文旁批注
        <ArrowRight size={17} />
      </button>
      <button className="button outline" onClick={onDetails}>
        查看完整依据与核验记录
      </button>
      <details className="result-more">
        <summary>更多核查信息</summary>
        <p>查看论文中哪些结论和依赖还需要核查。</p>
        <button className="button outline" onClick={onCoverage}>
          核查覆盖
        </button>
      </details>
    </section>
  );
}
