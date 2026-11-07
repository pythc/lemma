import { resolveContextAnchor } from "./context.mjs";
import { sourceAnchors } from "./autonomy-schema.mjs";
// Exact Latin line-break recovery. No mathematical sign, digit or Greek
// character is substituted, and the resulting quote must pass the strict
// source checker. Ambiguous matches remain unresolved.
function dehyphenated(text) {
  let value = "",
    offsets = [];
  for (let i = 0; i < text.length; i++) {
    if (
      text[i] === "-" &&
      /[A-Za-z]{3,}$/.test(text.slice(Math.max(0, i - 40), i))
    ) {
      const tail = text.slice(i + 1).match(/^\s+([a-z]{2,})/);
      if (tail) {
        i += tail[0].length - tail[1].length;
        continue;
      }
    }
    if (/\s/.test(text[i])) {
      if (value.endsWith(" ") || !value) continue;
      value += " ";
      offsets.push(i);
    } else {
      value += text[i];
      offsets.push(i);
    }
  }
  return { value: value.trimEnd(), offsets };
}
export function originalAnchors(a, context) {
  try {
    return [resolveContextAnchor(a, context)];
  } catch (original) {
    try {
      return sourceAnchors(a, {
        pages: context.pages.map((p) => ({ index: p.pageIndex, text: p.text })),
      }).map((v) => resolveContextAnchor(v, context));
    } catch {
      /* uniquely mapped Latin hyphenation below */
    }
    if (
      a.supplementId ||
      typeof a.quote !== "string" ||
      a.quote.length < 16 ||
      !context.pages.some((p) => p.pageIndex === a.pageIndex)
    )
      throw original;
    const needle = dehyphenated(a.quote).value,
      matches = [];
    for (const p of context.pages) {
      const mapped = dehyphenated(p.text);
      let start = mapped.value.indexOf(needle);
      while (start >= 0) {
        matches.push({ p, mapped, start });
        start = mapped.value.indexOf(needle, start + 1);
      }
    }
    if (matches.length !== 1) throw original;
    const { p, mapped, start } = matches[0];
    const quote = p.text.slice(
      mapped.offsets[start],
      mapped.offsets[start + needle.length - 1] + 1,
    );
    return [resolveContextAnchor({ pageIndex: p.pageIndex, quote }, context)];
  }
}
