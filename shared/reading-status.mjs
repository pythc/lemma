// Interpret coverage without changing archived runs or their evidence roots.
export function readingStatus(run) {
  const map = run.paperMap || run.conclusion?.paperMap || {};
  const gaps = run.readingGaps || map.readingGaps || [];
  const unreadPages = [...new Set(run.unreadPages || map.unreadPages || [])];
  const missingTextPages = run.missingTextPages || map.missingTextPages || [];
  const reads = (run.tasks || []).filter((t) => t.kind === "read");
  const hasRead =
    !!map.readPages?.length || reads.some((t) => t.status === "succeeded");
  const incomplete = !!(
    gaps.length ||
    unreadPages.length ||
    reads.some((t) =>
      ["failed", "unresolved", "interrupted", "cancelled"].includes(t.status),
    )
  );
  return {
    incomplete,
    failed: incomplete && !hasRead,
    unreadPages,
    missingTextPages,
    gaps,
  };
}

export function readingLimitations(run) {
  const status = readingStatus(run);
  const pages = (values) => values.map((p) => p + 1).join("、");
  const unread = status.unreadPages.filter(
    (p) => !status.missingTextPages.includes(p),
  );
  return [
    ...(status.missingTextPages.length
      ? [`未提取到文本的页面：${pages(status.missingTextPages)}`]
      : []),
    ...(unread.length ? [`尚未完成阅读的页面：${pages(unread)}`] : []),
    ...status.gaps.map((g) => `第 ${pages(g.pages)} 页：${g.reason}`),
  ];
}

export function reviewErrorMessage(error) {
  if (/原证明核验达到运行限制/.test(error || ""))
    return "本轮核验已达到运行上限，这部分尚未完成。";
  if (/HTTP (502|503|504)|upstream_error_event/.test(error || ""))
    return "模型服务暂时不可用，请稍后重试。";
  return error;
}
