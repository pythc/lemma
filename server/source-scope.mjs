import { digest } from "./evidence.mjs";
import { normalize, text } from "./contracts.mjs";
import { anchorInContext } from "./context.mjs";

export function scopeFailureFingerprint(proposal, locator, error) {
  const anchors = (values) =>
    Array.isArray(values)
      ? values.map((a) => ({
          pageIndex: a?.pageIndex ?? null,
          quote: typeof a?.quote === "string" ? normalize(a.quote) : null,
        }))
      : null;
  return digest({
    error,
    locator: anchors([locator]),
    spans: anchors(proposal?.spans),
    premises: anchors(proposal?.premises),
    conclusion: anchors(proposal?.conclusion),
  });
}

// A locator identifies a proposition; it is not the proposition's complete text.
// Scope changes are versioned before formalization, never edits to a fixed goal.
export function propositionScope(proposal, context, locator, previous = null) {
  if (
    !proposal ||
    !Array.isArray(proposal.spans) ||
    !proposal.spans.length ||
    proposal.spans.length > 16
  )
    throw Error("完整命题范围须提供一至十六段逐字原文。");
  const anchors = proposal.spans.map((a) => anchorInContext(a, context));
  let last = null,
    size = 0;
  for (const a of anchors) {
    size += a.quote.length;
    if (
      last &&
      (a.pageIndex < last.pageIndex ||
        (a.pageIndex === last.pageIndex &&
          a.start < last.start + normalize(last.quote).length))
    )
      throw Error("命题范围必须按原文顺序排列，且不得重叠。");
    last = a;
  }
  if (size > 24000) throw Error("命题范围过长，需定位到完整单条命题。");
  const fixedLocator = anchorInContext(locator, context);
  if (
    !anchors.some(
      (a) =>
        a.pageIndex === fixedLocator.pageIndex &&
        a.start <= fixedLocator.start &&
        a.start + normalize(a.quote).length >=
          fixedLocator.start + normalize(fixedLocator.quote).length,
    )
  )
    throw Error("完整命题范围必须包含原始定位片段，不能换成另一条命题。");
  const within = (values, label, required = true) => {
    if (
      !Array.isArray(values) ||
      values.length > 24 ||
      (required && !values.length)
    )
      throw Error(`${label}缺少原文依据。`);
    return values.map((value) => {
      const a = anchorInContext(value, context);
      if (
        !anchors.some(
          (s) =>
            a.pageIndex === s.pageIndex &&
            a.start >= s.start &&
            a.start + normalize(a.quote).length <=
              s.start + normalize(s.quote).length,
        )
      )
        throw Error(`${label}不在固定命题范围内。`);
      return a;
    });
  };
  const body = {
    schemaVersion: "lemma.proposition-scope.v1",
    paperSha256: context.paperSha256,
    locator: fixedLocator,
    spans: anchors,
    premises: within(proposal.premises || [], "前提", false),
    conclusion: within(proposal.conclusion, "结论"),
    explanation: text(proposal.explanation, 2400, "范围选择依据"),
    previousScope: previous?.scopeHash || null,
    authority: "agent_selected_source_spans_not_semantic_or_kernel_certificate",
  };
  return { ...body, scopeHash: digest(body) };
}

export function reviewPropositionScope(value, scope, context) {
  if (
    value?.scopeHash !== scope.scopeHash ||
    !["complete", "incomplete"].includes(value.decision)
  )
    throw Error("范围复核未对应当前命题范围。");
  const explanation = text(value.explanation, 2400, "独立范围复核依据");
  if (!Array.isArray(value.anchors) || !value.anchors.length)
    throw Error("范围复核缺少逐字原文依据。");
  const anchors = value.anchors.map((a) => anchorInContext(a, context));
  if (
    anchors.some(
      (a) =>
        !scope.spans.some(
          (s) =>
            a.pageIndex === s.pageIndex &&
            a.start >= s.start &&
            a.start + normalize(a.quote).length <=
              s.start + normalize(s.quote).length,
        ),
    )
  )
    throw Error("复核引用不在命题范围内。");
  return {
    scopeHash: scope.scopeHash,
    decision: value.decision,
    explanation,
    anchors,
    authority: "independent_agent_not_human_or_kernel",
  };
}

export function validateStoredScope(scope, context) {
  const { scopeHash, ...body } = scope || {};
  if (digest(body) !== scopeHash || scope.paperSha256 !== context.paperSha256)
    throw Error("命题范围身份或摘要不一致。");
  const checked = propositionScope(
    { ...scope, spans: scope.spans },
    context,
    scope.locator,
    scope.previousScope ? { scopeHash: scope.previousScope } : null,
  );
  if (checked.scopeHash !== scopeHash) throw Error("命题范围与原文不一致。");
  return scope;
}

export function bindScopeEvidence(
  context,
  scope,
  evidence,
  selected,
  reviewed,
) {
  validateStoredScope(scope, context);
  if (
    !evidence ||
    !selected ||
    !reviewed ||
    selected.id !== evidence.selection ||
    reviewed.id !== evidence.review ||
    selected.kind !== "adaptive:resolve_scope" ||
    reviewed.kind !== "adaptive:review_scope" ||
    digest(selected.payload.value) !== digest(scope) ||
    !reviewed.inputs.includes(selected.id) ||
    !reviewed.payload.model ||
    reviewPropositionScope(reviewed.payload.value, scope, context).decision !==
      "complete"
  )
    throw Error("完整命题范围缺少对应的独立复核证据链。");
  return {
    ...context,
    propositionScope: scope,
    propositionScopeEvidence: { selection: selected.id, review: reviewed.id },
  };
}

export const SCOPE_PROMPT = `定位片段不是完整命题。读取固定全文，找出包含 locator 的同一条命题的完整陈述，可以跨页；保留全部前提、公式、量词和结论，不包含后面的证明或另一条命题。必要时调用 read_source 分页读取原文。返回 JSON {spans:[{pageIndex:0,quote:"逐字完整片段，每段最多5000字"}],premises:[{pageIndex:0,quote:"范围内的前提依据"}],conclusion:[{pageIndex:0,quote:"范围内的结论依据"}],explanation:"范围选择理由"}。前提确无独立文字时 premises 可为空。不要生成 Lean、数学答案或重写论文。原文不足或公式含混时返回 {unavailable:"原因"}，禁止猜测补写。`;
