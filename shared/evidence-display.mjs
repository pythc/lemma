import { reviewErrorMessage } from "./reading-status.mjs";
const text = (v) => (typeof v === "string" ? v : "");
const description = (v) =>
  reviewErrorMessage(
    text(v) || text(v?.explanation) || text(v?.statement) || text(v?.summary),
  );

// Archived model replies may be invalid. Show mathematical content, not request
// envelopes, scheduling data, model settings or statistics.
export function evidenceDisplay(preview, kind = null) {
  const data = preview?.value || preview?.parsed || preview || {};
  return {
    description:
      [
        data.summary?.headline,
        data.summary,
        data.headline,
        data.error,
        data.reason,
        data.explanation,
      ]
        .map((v) => reviewErrorMessage(text(v)))
        .find(Boolean) || "",
    statement: text(data.statement) || text(data.contract?.leanTarget),
    lists: [
      ["前提条件", data.assumptions],
      [
        "原文依据",
        Array.isArray(data.anchors)
          ? data.anchors.map(
              (a) => `第 ${a.pageIndex + 1} 页：${text(a.quote)}`,
            )
          : [],
      ],
      [
        "证明路线复核",
        data.routeAssessment?.explanation
          ? [data.routeAssessment.explanation]
          : [],
      ],
      [
        "Lean 检查",
        kind === "original:step_result" && data.check?.status === "verified"
          ? [
              data.check.mode === "counterexample"
                ? "该精确局部命题的否定通过 Lean。"
                : data.status === "conditional"
                  ? "局部条件命题通过，前序义务尚未全部成立。"
                  : "该精确局部命题通过 Lean。",
            ]
          : [],
      ],
      ["论证步骤", data.steps],
      ["依赖", data.dependencies],
      [
        "辅助命题方案",
        Array.isArray(data.parts)
          ? data.parts.map((p) =>
              p && typeof p.name === "string" && typeof p.purpose === "string"
                ? `${p.name}：${p.purpose}`
                : "",
            )
          : [],
      ],
    ]
      .map(([label, values]) => [
        label,
        Array.isArray(values) ? values.map(description).filter(Boolean) : [],
      ])
      .filter(([, values]) => values.length),
    counterexample:
      description(data.counterexample) ||
      text(data.counterexample?.description),
    pages: (Array.isArray(data.pages) ? data.pages : [])
      .filter(
        (p) =>
          p &&
          Number.isInteger(p.index ?? p.pageIndex) &&
          (p.index ?? p.pageIndex) >= 0 &&
          text(p.text),
      )
      .map((p) => ({ pageIndex: p.index ?? p.pageIndex, text: p.text })),
  };
}
