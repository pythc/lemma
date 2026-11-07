import { digest } from "../evidence.mjs";
export function sourceSpan(source, pageIndex, start, end) {
  const page = source.pages.find((p) => p.index === pageIndex);
  if (
    !page ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > page.text.length
  )
    throw Object.assign(Error("Invalid page or UTF-16 source offsets"), {
      code: "source_range_invalid",
      dispatchState: "not_dispatched",
      navigation: {
        tool: "locate_source",
        field: !page ? "pageIndex" : "start/end",
        pageIndex,
        validRange: page
          ? {
              start: 0,
              end: page.text.length,
              units: "UTF-16",
              endExclusive: true,
            }
          : null,
        availablePages: source.pages.map((p) => p.index),
      },
    });
  const quote = page.text.slice(start, end);
  if (!quote.trim()) throw Error("Source selection is empty");
  return {
    pageIndex,
    start,
    end,
    quote,
    sourceRef: digest({
      paperSha256: source.paperSha256,
      pageIndex,
      start,
      end,
      quote,
    }),
  };
}
export function resolveSourceSpans(source, spans) {
  if (!Array.isArray(spans))
    throw Error("sourceSpans must be an array of source selections");
  return spans.map((s) => {
    if (s.start !== undefined || s.end !== undefined || s.sourceRef) {
      const exact = sourceSpan(source, s.pageIndex, s.start, s.end);
      if (
        (s.quote !== undefined && s.quote !== exact.quote) ||
        (s.sourceRef && s.sourceRef !== exact.sourceRef)
      )
        throw Error(
          "Source selection identity or text changed; retrieve original offsets again",
        );
      return exact;
    }
    const page = source.pages.find((p) => p.index === s.pageIndex);
    if (
      typeof s.quote !== "string" ||
      !s.quote.trim() ||
      !page?.text.includes(s.quote)
    )
      throw Error(
        "Source span not found exactly. Use locate_source for candidate offsets, then read_source_span. Matching whitespace does not establish semantic equivalence.",
      );
    return { pageIndex: s.pageIndex, quote: s.quote };
  });
}
export function locateSource(
  source,
  { query, pageIndex, ignoreWhitespace = false, offset = 0, limit = 20 },
) {
  if (typeof query !== "string" || !query.trim())
    throw Error("Nonempty source query required");
  const results = [];
  for (const page of source.pages.filter(
    (p) => pageIndex === undefined || p.index === pageIndex,
  )) {
    const mapping = [],
      chars = [];
    for (let i = 0; i < page.text.length; i++)
      if (!ignoreWhitespace || !/\s/.test(page.text[i])) {
        chars.push(page.text[i]);
        mapping.push(i);
      }
    const haystack = chars.join(""),
      needle = ignoreWhitespace ? query.replace(/\s/g, "") : query;
    for (
      let i = haystack.indexOf(needle);
      i !== -1;
      i = haystack.indexOf(needle, i + Math.max(1, needle.length))
    )
      results.push(
        sourceSpan(
          source,
          page.index,
          mapping[i],
          mapping[i + needle.length - 1] + 1,
        ),
      );
  }
  limit = Math.min(100, Math.max(1, limit));
  return {
    selections: results.slice(offset, offset + limit),
    total: results.length,
    nextOffset: offset + limit < results.length ? offset + limit : null,
    matching: ignoreWhitespace
      ? "whitespace_candidates_original_text_preserved"
      : "literal",
    meaning:
      "Selections locate original text only; completeness and mathematical meaning require independent assessment.",
  };
}

// Selection is textual navigation only; the Agent still chooses mathematical coverage.
export function selectSource(
  source,
  { pageIndex, paragraphIndex, text, occurrence },
  within = null,
) {
  if (within && (pageIndex !== undefined || paragraphIndex !== undefined))
    throw sourceError(
      "source_selection_conflict",
      "Choose either an existing selection or a page",
    );
  const page = source.pages.find(
    (p) => p.index === (within?.pageIndex ?? pageIndex),
  );
  if (!page)
    throw sourceError(
      "source_locator_missing",
      "An existing page or selection is required",
    );
  let start = within?.start ?? 0,
    end = within?.end ?? page.text.length;
  if (paragraphIndex !== undefined) {
    const paragraphs = [
      ...page.text.matchAll(/[^\r\n](?:[\s\S]*?)(?=\r?\n\s*\r?\n|$)/g),
    ].filter((m) => m[0].trim());
    const p = paragraphs[paragraphIndex];
    if (!p)
      throw sourceError(
        "source_range_invalid",
        "Paragraph index is outside the original page",
        { paragraphCount: paragraphs.length },
      );
    start = p.index;
    end = start + p[0].length;
  }
  if (text !== undefined) {
    if (typeof text !== "string" || !text.trim())
      throw sourceError("source_text_mismatch", "Literal text is empty");
    const segment = page.text.slice(start, end),
      matches = [];
    for (
      let at = segment.indexOf(text);
      at >= 0;
      at = segment.indexOf(text, at + 1)
    )
      matches.push(start + at);
    if (!matches.length)
      throw sourceError(
        "source_text_mismatch",
        "Literal text is absent from the selected original range",
      );
    if (occurrence === undefined && matches.length !== 1)
      throw sourceError(
        "source_ambiguous",
        "Choose an occurrence of the literal text",
        {
          candidates: matches.map((at) => ({
            pageIndex: page.index,
            start: at,
            end: at + text.length,
          })),
        },
      );
    const selected = matches[occurrence ?? 0];
    if (selected === undefined)
      throw sourceError(
        "source_range_invalid",
        "Occurrence index is outside the matches",
        { matches: matches.length },
      );
    start = selected;
    end = start + text.length;
  } else if (occurrence !== undefined)
    throw sourceError(
      "source_locator_missing",
      "occurrence requires literal text",
    );
  return sourceSpan(source, page.index, start, end);
}
function sourceError(code, message, details = null) {
  return Object.assign(new Error(message), {
    code,
    dispatchState: "not_dispatched",
    details,
    navigation: {
      tool: "select_source",
      guidance:
        "Choose exact original text; no text was normalized or selected automatically.",
    },
  });
}
export async function targetSourceArguments(source, a, resolveSelection) {
  if (a.source) {
    if (
      a.pageIndex !== undefined ||
      a.locatorSelectionId !== undefined ||
      a.sourceSpans !== undefined
    )
      throw sourceError(
        "source_selection_conflict",
        "Do not mix source and legacy locator fields",
      );
    const loc = a.source.locator;
    if (loc?.kind === "selection")
      a = { ...a, locatorSelectionId: loc.ref, sourceSpans: a.source.coverage };
    else if (loc?.kind === "literal") {
      if (a.proposal?.quote !== undefined && a.proposal.quote !== loc.quote)
        throw sourceError(
          "source_selection_conflict",
          "Literal locator conflicts with proposal.quote",
        );
      a = {
        ...a,
        pageIndex: loc.pageIndex,
        sourceSpans: a.source.coverage,
        proposal: { ...a.proposal, quote: loc.quote },
      };
    } else
      throw sourceError(
        "source_locator_missing",
        "Choose a selection or literal locator",
      );
  }
  if (a.locatorSelectionId) {
    const loc = await resolveSelection({ selectionId: a.locatorSelectionId });
    if (
      (a.pageIndex !== undefined && a.pageIndex !== loc.pageIndex) ||
      (a.proposal?.quote !== undefined && a.proposal.quote !== loc.quote)
    )
      throw sourceError(
        "source_selection_conflict",
        "locatorSelectionId conflicts with supplied pageIndex or proposal.quote; pass the selection without retyping it",
      );
    a = {
      ...a,
      pageIndex: loc.pageIndex,
      proposal: { ...a.proposal, quote: loc.quote },
    };
  }
  if (!Number.isInteger(a.pageIndex))
    throw sourceError(
      "source_locator_missing",
      "Provide pageIndex with a literal quote or a selection locator",
    );
  const page = source.pages.find((p) => p.index === a.pageIndex),
    quote = a.proposal?.quote;
  if (
    !page ||
    typeof quote !== "string" ||
    !quote.trim() ||
    !page.text.includes(quote)
  )
    throw sourceError(
      "source_text_mismatch",
      "proposal.quote is not literal text on the selected page; use locatorSelectionId to pass an original selection",
    );
  if (page.text.indexOf(quote) !== page.text.lastIndexOf(quote))
    throw sourceError(
      "source_ambiguous",
      "Locator occurs more than once; select a unique original range",
    );
  const spans = resolveSourceSpans(
    source,
    await Promise.all((a.sourceSpans || []).map(resolveSelection)),
  );
  if (!spans.length)
    throw sourceError(
      "source_coverage_missing",
      "Complete source spans required",
    );
  return { ...a, sourceSpans: spans };
}

export function sourceParagraphs(page) {
  return [...page.text.matchAll(/[^\r\n](?:[\s\S]*?)(?=\r?\n\s*\r?\n|$)/g)]
    .filter((m) => m[0].trim())
    .map((m, index) => ({
      paragraphIndex: index,
      start: m.index,
      end: m.index + m[0].length,
      units: "UTF-16",
      select: {
        tool: "select_source",
        arguments: { pageIndex: page.index, paragraphIndex: index },
      },
    }));
}
