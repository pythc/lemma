import { resolveIndexedAnchor } from "./source-anchor-index.mjs";
import { CONTEXT_RUNTIME } from "./runtime-limits.mjs";
import { digest } from "./evidence.mjs";
import { normalize, text } from "./contracts.mjs";
import { mathContext } from "./math-extraction.mjs";

export const CONTEXT_LIMITS = CONTEXT_RUNTIME;

export function supplementsFor(input = []) {
  if (!Array.isArray(input) || input.length > CONTEXT_LIMITS.supplements)
    throw new Error(`补充材料最多 ${CONTEXT_LIMITS.supplements} 份。`);
  let size = 0;
  return input.map((item) => {
    const value = {
      name: text(item.name, 180, "材料名"),
      text: text(item.text, CONTEXT_LIMITS.supplementCharacters, "材料正文"),
      provenance: "user_supplied_unverified_source",
    };
    size += value.text.length;
    if (size > CONTEXT_LIMITS.supplementCharacters)
      throw new Error(
        `补充材料合计超过 ${CONTEXT_LIMITS.supplementCharacters} 字符。`,
      );
    return { ...value, id: digest(value) };
  });
}

// Deterministic, budgeted selection from the immutable entire-paper text. Missing
// pages/references are visible; selection is not a claim of semantic completeness.
export function buildContext(paper, pageIndex, supplements = []) {
  const selected = paper.pages?.find((p) => p.index === pageIndex);
  if (!selected?.text.trim())
    throw new Error("选中页没有可核对文本，需补充文字并人工校对原始公式。");
  const refs = [
    ...selected.text.matchAll(
      /(?:Definition|Theorem|Lemma|Proposition|Assumption|定义|定理|引理|假设)\s+(\d+(?:\.\d+)*)/gi,
    ),
  ].map((m) => m[0]);
  const terms = [
    ...new Set(selected.text.toLowerCase().match(/[a-z]{5,}/g) || []),
  ].filter(
    (w) =>
      !["theorem", "proof", "there", "which", "every", "where"].includes(w),
  );
  const ranked = paper.pages
    .map((p) => {
      const lower = p.text.toLowerCase();
      const reasons = [];
      let score = p.index === pageIndex ? 100000 : 0;
      if (p.index === pageIndex) reasons.push("selected_claim_page");
      if (Math.abs(p.index - pageIndex) <= 2) {
        score += 500 - 100 * Math.abs(p.index - pageIndex);
        reasons.push("adjacent_context");
      }
      if (p.index === 0) {
        score += 60;
        reasons.push("opening_conventions");
      }
      if (
        /definition|assumption|throughout|notation|定义|假设|记号/i.test(p.text)
      ) {
        score += 30;
        reasons.push("definitions_or_assumptions");
      }
      for (const ref of refs)
        if (lower.includes(ref.toLowerCase())) {
          score += 80;
          reasons.push(`reference:${ref}`);
        }
      score += terms.filter((t) => lower.includes(t)).length;
      return { ...p, score, reasons };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const pages = [];
  let characters = 0;
  for (const p of ranked) {
    if (
      pages.length >= CONTEXT_LIMITS.pages ||
      characters + p.text.length > CONTEXT_LIMITS.characters
    )
      continue;
    if (!p.text.trim()) continue;
    pages.push({
      pageIndex: p.index,
      text: p.text,
      textHash: digest(p.text),
      reasons: p.reasons,
    });
    characters += p.text.length;
  }
  if (!pages.some((p) => p.pageIndex === pageIndex))
    throw new Error("选中页超过上下文预算；请先拆分可核对材料。");
  pages.sort((a, b) => a.pageIndex - b.pageIndex);
  const omittedPages = paper.pages
    .filter((p) => !pages.some((v) => v.pageIndex === p.index))
    .map((p) => ({
      pageIndex: p.index,
      quality: p.quality,
      preview: p.text.slice(0, 180),
    }));
  return {
    schemaVersion: "lemma.context.v1",
    paperSha256: paper.paperSha256,
    selectedPage: pageIndex,
    pages,
    supplements,
    omittedPages,
    limits: CONTEXT_LIMITS,
    characters,
    ...(paper.mathEvidence
      ? { mathEvidence: mathContext(paper.mathEvidence) }
      : {}),
    warning:
      "PDF 文本可能损失公式排版；补充材料未经来源认证。上下文选择不保证定义、引用或全篇假设已齐全。",
    externalReferences: "not_automatically_resolved",
  };
}

export function anchorInContext(value, context) {
  value = resolveIndexedAnchor(value, context);
  if (!value || typeof value !== "object") throw new Error("原文依据缺失。");
  const quote = text(value.quote, 5000, "原文依据");
  const source = value.supplementId
    ? context.supplements.find((p) => p.id === value.supplementId)
    : context.pages.find((p) => p.pageIndex === value.pageIndex);
  if (!source) throw new Error("依据未包含在已固定的上下文中。");
  const body = normalize(source.text),
    needle = normalize(quote),
    start = body.indexOf(needle);
  if (start < 0 || body.indexOf(needle, start + 1) >= 0)
    throw new Error("上下文依据不存在或不能唯一定位。");
  return {
    ...(value.supplementId
      ? { supplementId: value.supplementId }
      : { pageIndex: value.pageIndex }),
    quote,
    start,
    sourceTextHash: digest(source.text),
  };
}

// Repair location metadata only. Never replace mathematical symbols, guess the
// nearest occurrence, or widen a search beyond the immutable context. The result
// is a unique quote accepted by the same strict checker used by evidence replay.
export function resolveContextAnchor(
  value,
  context,
  { focusAnchor, repairs } = {},
) {
  try {
    return anchorInContext(value, context);
  } catch (original) {
    if (
      !value?.supplementId &&
      (!Number.isInteger(value?.pageIndex) ||
        !context.pages.some((p) => p.pageIndex === value.pageIndex))
    )
      throw original;
    const quote = text(value?.quote, 5000, "原文依据"),
      needle = normalize(quote);
    const sources = value.supplementId
      ? context.supplements
          .filter((p) => p.id === value.supplementId)
          .map((p) => ({ ...p, supplementId: p.id }))
      : context.pages;
    const matches = [];
    for (const source of sources) {
      const body = normalize(source.text);
      for (
        let start = body.indexOf(needle);
        start >= 0;
        start = body.indexOf(needle, start + 1)
      )
        matches.push({ source, body, start });
    }
    let chosen, method;
    // An offset is meaningful only with the exact source hash. Bare offsets
    // supplied by a model cannot resolve ambiguity.
    const positioned = matches.filter(
      (m) =>
        m.start === value.start &&
        digest(m.source.text) === value.sourceTextHash &&
        (value.supplementId
          ? m.source.supplementId === value.supplementId
          : m.source.pageIndex === value.pageIndex),
    );
    if (positioned.length === 1) {
      [chosen] = positioned;
      method = "source_hash_and_offset";
    }
    if (!chosen && focusAnchor) {
      const focus = anchorInContext(focusAnchor, context);
      const scoped = matches.filter(
        (m) =>
          m.source.pageIndex === focus.pageIndex &&
          !m.source.supplementId &&
          m.start >= focus.start &&
          m.start + needle.length <=
            focus.start + normalize(focus.quote).length,
      );
      if (scoped.length === 1) {
        [chosen] = scoped;
        method = "unique_within_fixed_claim";
      }
    }
    if (!chosen && matches.length === 1) {
      [chosen] = matches;
      method = "unique_exact_span_in_context";
    }
    if (!chosen) {
      const candidates = matches.slice(0, 8).map((m) => ({
        ...(m.source.supplementId
          ? { supplementId: m.source.supplementId }
          : { pageIndex: m.source.pageIndex }),
        start: m.start,
        excerpt: m.body.slice(
          Math.max(0, m.start - 80),
          m.start + needle.length + 80,
        ),
      }));
      const error = new Error(
        `${original.message} 引句“${quote.slice(0, 100)}”有 ${matches.length} 个精确位置；请使用包含上下文的完整引句。候选：${JSON.stringify(candidates)}`,
      );
      error.code = matches.length ? "anchor_ambiguous" : "anchor_not_found";
      error.candidates = candidates;
      throw error;
    }
    const location = chosen.source.supplementId
      ? { supplementId: chosen.source.supplementId }
      : { pageIndex: chosen.source.pageIndex };
    let anchor;
    // Expand duplicate short quotes symmetrically, retaining the actual source
    // words. If no bounded unique span exists, leave it unresolved.
    for (const padding of [0, 80, 240, 1000]) {
      const left = Math.max(0, chosen.start - padding),
        right = Math.min(
          chosen.body.length,
          chosen.start + needle.length + padding,
        );
      try {
        anchor = anchorInContext(
          { ...location, quote: chosen.body.slice(left, right) },
          context,
        );
        break;
      } catch {}
    }
    if (!anchor) throw original;
    repairs?.push({ requested: value, resolved: anchor, method });
    return anchor;
  }
}
