import { reviewCompletion, terminalRun } from "./review-completion.mjs";
// View interpretation does not rewrite historical records.
export function reviewOutcome(run) {
  const accountBlocked =
    run.infrastructureFailure?.kind === "provider_account_blocked" ||
    run.conclusion?.executionOutcome === "provider_account_blocked";
  const failed =
    accountBlocked ||
    !!run.infrastructureFailure ||
    run.conclusion?.executionOutcome === "infrastructure_interrupted" ||
    /协调未产生有效新计划.*模型.*(传输|超时|连接|HTTP)/.test(
      run.stopReason || "",
    );
  const budget =
    !!run.budgetStop ||
    run.conclusion?.executionOutcome === "budget_exhausted" ||
    /达到本轮预算/.test(run.stopReason || run.conclusion?.reason || "");
  const completion = reviewCompletion(run);
  const incomplete = terminalRun(run) && !completion.reviewComplete;
  return {
    ...completion,
    interrupted: failed || budget || incomplete,
    budgetExhausted: budget,
    headline: budget
      ? "本轮预算已用尽，核查未完成"
      : accountBlocked
        ? "模型供应商账户受限，评审未完成"
        : failed
          ? "模型连接异常，评审未完成"
          : incomplete
            ? "评审已停止，核查未完成"
            : null,
    hasReport:
      !!run.root &&
      terminalRun(run) &&
      (run.status === "completed" || !!run.conclusion),
    message: accountBlocked
      ? "模型供应商返回 HTTP 402，账户或余额受限。已停止后续请求并保存收到的结果。"
      : failed
        ? "模型连接异常，评审未完成。已保存收到的结果。"
        : budget
          ? "本轮预算已用尽，核查未完成。已保存收到的结果和待核查事项。"
          : incomplete
            ? "部分结果已保存；所选范围仍有未解决义务。"
            : "",
  };
}

export function claimVerdict(claim) {
  if (claim.formalResult?.conclusion?.headline)
    return claim.formalResult.conclusion.headline;
  if (claim.status === "concern") return "存在待核查疑点";
  if (claim.independentReview?.status === "unresolved")
    return "初步分析已保存，独立复核未完成";
  return (
    {
      unreviewed: "尚未检查",
      unresolved: "尚无确定结论",
      no_issue_found: "暂未发现问题，尚未证明",
    }[claim.status] || "尚无确定结论"
  );
}
