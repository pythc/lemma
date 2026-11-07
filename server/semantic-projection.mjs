import { digest } from "./evidence.mjs";
import { normalize } from "./contracts.mjs";
// Full pages and immutable native evidence are retained. This only removes
// duplicate quotations/debug Expr text from model requests, never source scope.
export function projectSemanticInput(input) {
  const v = structuredClone(input);
  const full = v.context.anchorIndex || [];
  v.context.anchorIndex = full.map(({ quote, ...a }) => {
    const page = v.context.pages.find((p) => p.pageIndex === a.pageIndex);
    const start = page?.text.indexOf(quote) ?? -1;
    return start >= 0
      ? { ...a, rawStart: start, rawEnd: start + quote.length }
      : { ...a, quote };
  });
  v.projection = {
    schemaVersion: "lemma.semantic-input-projection.v1",
    sourceInputHash: digest(input),
    anchorCatalogHash: digest(full),
    offsets: {
      raw: "UTF-16 code units in unchanged pages.text",
      normalized: "UTF-16 code units after NFC, whitespace collapse and trim",
      normalization: "lemma.whitespace.v1",
    },
    targetStructureHash: input.targetStructure
      ? digest(input.targetStructure)
      : null,
  };
  if (v.targetStructure) delete v.targetStructure.expression;
  return v;
}
export function reconstructProjectedAnchors(input) {
  if (input.projection?.schemaVersion !== "lemma.semantic-input-projection.v1")
    throw Error("Unsupported input projection");
  const entries = input.context.anchorIndex.map(
    ({ rawStart, rawEnd, ...a }) => {
      const page = input.context.pages.find((p) => p.pageIndex === a.pageIndex);
      if (!page || digest(page.text) !== a.sourceTextHash)
        throw Error("Projected source identity mismatch");
      const quote = a.quote ?? page.text.slice(rawStart, rawEnd);
      const { quote: _, ...rest } = a;
      if (normalize(page.text).indexOf(normalize(quote)) !== a.start)
        throw Error("Projected normalized position mismatch");
      const entry = {
        pageIndex: a.pageIndex,
        quote,
        start: a.start,
        sourceTextHash: a.sourceTextHash,
      };
      if (
        digest({ paperSha256: input.context.paperSha256, ...entry }).slice(
          0,
          20,
        ) !== a.anchorId
      )
        throw Error("Projected anchor identity mismatch");
      return { anchorId: a.anchorId, ...entry };
    },
  );
  if (digest(entries) !== input.projection.anchorCatalogHash)
    throw Error("Projected catalog changed");
  return entries;
}
