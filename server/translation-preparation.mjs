import { validateProposal } from "./contracts.mjs";
import { validateAlignment } from "./semantics.mjs";
import { validateTranslationWire } from "./translation-wire.mjs";
// Draft validation has no approval authority. Final submission is parsed again.
export function validateTranslationDraft(
  candidate,
  context,
  selectedQuote = null,
) {
  const parsed = validateTranslationWire(candidate);
  if (parsed.unavailable)
    throw Error("Preparation requires a complete candidate");
  if (selectedQuote && parsed.quote !== selectedQuote)
    throw Error("候选引句改变固定选区。");
  const matches = context.pages.filter((page) => {
    try {
      validateProposal(parsed, page);
      return true;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) throw Error("候选引句须在固定来源中唯一定位。");
  const page = matches[0];
  const proposal = validateProposal(parsed, page);
  const alignment = validateAlignment(
    parsed.alignment,
    {
      ...proposal,
      pageIndex: page.pageIndex ?? page.index,
    },
    context,
  );
  return {
    candidate: parsed,
    alignment,
    pageIndex: page.pageIndex ?? page.index,
  };
}
