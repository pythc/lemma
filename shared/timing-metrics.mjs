export function intervalUnionMs(spans) {
  const intervals = spans
    .filter(
      (s) => Number.isFinite(s.startedAtMs) && Number.isFinite(s.endedAtMs),
    )
    .map((s) => [s.startedAtMs, s.endedAtMs])
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    end = -Infinity;
  for (const [a, b] of intervals) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}

export function timingBreakdown(spans) {
  return spans.map((span) => ({
    ...span,
    exclusiveMs: Math.max(
      0,
      (span.elapsedMs || 0) -
        intervalUnionMs(spans.filter((child) => child.parentId === span.id)),
    ),
  }));
}
