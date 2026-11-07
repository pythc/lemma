import { reviewOutcome } from "../shared/review-outcome.mjs";
// Keep in sync with .word-comments (264px) + .paper-spread gap (24px).
export const COMMENT_MARGIN = 288;
// UI acknowledgement only: this never approves a translated mathematical target.
export function resultKey(run, paperId) {
  return !!paperId &&
    !!run &&
    run.paperSha256 === paperId &&
    (run.engine === "team-v1"
      ? run.status !== "running" && !!run.conclusion
      : reviewOutcome(run).hasReport) &&
    run.root
    ? `${run.id}:${run.root}`
    : null;
}
export function resultIsVisible(run, paperId, acknowledgements) {
  const key = resultKey(run, paperId);
  return !!key && acknowledgements?.[key] === true;
}
// Anchors are normalized PDF coordinates. Unknown anchors must not be invented.
export function placeMarginNotes(
  notes,
  rects,
  pageIndex,
  pageHeight,
  heights = {},
) {
  const placed = [],
    unplaced = [];
  for (const note of notes.filter((n) => n.anchor.pageIndex === pageIndex)) {
    const anchor = note.anchor.rects?.[0] || rects[note.id]?.[0];
    if (anchor && Number.isFinite(anchor.y) && anchor.y >= 0 && anchor.y <= 1)
      placed.push({ note, anchorTop: anchor.y * pageHeight });
    else unplaced.push(note);
  }
  placed.sort(
    (a, b) => a.anchorTop - b.anchorTop || a.note.id.localeCompare(b.note.id),
  );
  let end = 0;
  for (const item of placed) {
    item.top = Math.max(item.anchorTop, end);
    end = item.top + (heights[item.note.id] || 80) + 16;
  }
  return { placed, unplaced, height: Math.max(pageHeight, end) };
}
