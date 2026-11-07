export function operationLabel(op, runStatus) {
  if (op.status === "unknown") return "结果未知；保留原操作，未自动重试";
  if (op.status === "cancelled") return "操作已取消";
  if (op.status === "failed")
    return op.error?.dispatchState === "not_dispatched"
      ? "调用被参数校验拒绝，未执行"
      : op.error?.code === "environment_changed"
        ? "环境内容变化，结果不予采用"
        : "工具操作失败";
  if (
    ["accepted", "dispatching", "queued", "running", "cancelling"].includes(
      op.status,
    )
  )
    return runStatus !== "running"
      ? "运行已停止，操作结果待核对"
      : op.phase === "post_verification"
        ? "原生执行已结束，正在复核环境或保存结果"
        : op.phase === "native_executing"
          ? "正在执行原生检查"
          : op.phase === "queued"
            ? "等待环境或执行资源"
            : op.resource === "lean-host"
              ? "正在执行原生检查"
              : "正在准备或处理工具请求";
  const r = op.resultSummary;
  if (r?.nativeCheckExecuted === false) return "已复用回执；未执行新的内核检查";
  if (r?.termination) return "执行被中断；不是数学失败结论";
  if (typeof r?.exitCode === "number")
    return r.exitCode === 0
      ? "诊断编译通过；不是论文证明"
      : "诊断编译返回失败，可继续修改";
  if (r?.status === "verified") return "精确目标内核核验通过；独立验收另计";
  return "工具已返回；证明状态另计";
}
