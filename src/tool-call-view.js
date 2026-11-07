import { operationLabel } from "../shared/tool-operation-view.mjs";

const unfinished = new Set([
  "accepted",
  "dispatching",
  "queued",
  "running",
  "cancelling",
]);

function timestamp(value) {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// This is a display adapter. It neither revises the saved operation nor decides
// whether a statement was proved or a submission was independently accepted.
export function toolCallView(op, runStatus) {
  const startedAt = timestamp(op.startedAt);
  const endedAt = timestamp(op.endedAt);
  const duration =
    startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt
      ? endedAt - startedAt
      : undefined;
  let summary = operationLabel(op, runStatus);
  let status, statusLabel, category;
  if (op.status === "completed") {
    status = "returned";
    statusLabel = "已返回";
    category = "returned";
    if (op.resultSummary?.nativeCheckExecuted === false)
      statusLabel = "已复用回执";
  } else if (op.status === "failed") {
    status = "error";
    category = "issues";
    statusLabel =
      op.error?.dispatchState === "not_dispatched" ? "未执行" : "调用异常";
  } else if (op.status === "cancelled") {
    status = "cancelled";
    statusLabel = "已取消";
    category = "issues";
  } else if (unfinished.has(op.status) && runStatus === "running") {
    category = "unfinished";
    if (op.status === "queued" || op.phase === "queued") {
      status = "pending";
      statusLabel = "等待资源";
    } else {
      status = "running";
      statusLabel =
        op.status === "accepted"
          ? "待派发"
          : op.status === "cancelling"
            ? "正在取消"
            : op.phase === "post_verification"
              ? "执行后核验"
              : ["native_executing", "executing"].includes(op.phase)
                ? "执行中"
                : "处理中";
    }
  } else {
    status = "unknown";
    statusLabel = op.status === "unknown" ? "结果未知" : "结果待核对";
    category = "unfinished";
    if (op.status !== "unknown" && !unfinished.has(op.status))
      summary = "操作状态尚未识别，不能据此判断执行结果。";
  }
  return { status, statusLabel, category, summary, startedAt, duration };
}
