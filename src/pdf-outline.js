// Only PDF-supplied bookmarks belong in the outline. Never infer page headings.
export function outlineEntries(items, parent = "outline") {
  return (Array.isArray(items) ? items : []).map((item, index) => {
    const id = `${parent}-${index}`;
    return {
      id,
      title:
        typeof item.title === "string" && item.title.trim()
          ? item.title
          : "未命名书签",
      dest: item.dest,
      url: safeOutlineUrl(item.url),
      children: outlineEntries(item.items, id),
    };
  });
}

export function safeOutlineUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export async function resolveOutlineDestination(pdf, destination) {
  const dest =
    typeof destination === "string"
      ? await pdf.getDestination(destination)
      : destination;
  if (!Array.isArray(dest) || !dest.length)
    throw new Error("此书签的目标位置不可用。");
  const ref = dest[0];
  const pageIndex = Number.isInteger(ref)
    ? ref
    : ref && Number.isInteger(ref.num) && Number.isInteger(ref.gen)
      ? await pdf.getPageIndex(ref)
      : NaN;
  if (
    !Number.isInteger(pageIndex) ||
    pageIndex < 0 ||
    pageIndex >= pdf.numPages
  )
    throw new Error("此书签的目标页不存在。");
  // Respect an intra-page bookmark without changing the reader's zoom preference.
  const kind = dest[1]?.name;
  const top =
    kind === "XYZ"
      ? dest[3]
      : ["FitH", "FitBH"].includes(kind)
        ? dest[2]
        : kind === "FitR"
          ? dest[5]
          : null;
  let fraction = 0;
  if (typeof top === "number" && Number.isFinite(top)) {
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const left =
      ["XYZ", "FitR"].includes(kind) && Number.isFinite(dest[2])
        ? dest[2]
        : page.view[0];
    fraction = Math.max(
      0,
      Math.min(
        1,
        viewport.convertToViewportPoint(left, top)[1] / viewport.height,
      ),
    );
  }
  return { pageIndex, fraction };
}
