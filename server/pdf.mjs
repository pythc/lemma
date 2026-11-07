import { DOMMatrix, Path2D, ImageData, createCanvas } from "@napi-rs/canvas";
import {
  textVisibility,
  legacyTextVisibility,
  geometryDiagnosticValue,
} from "./pdf-visibility.mjs";
import { sha256 } from "./evidence.mjs";
Object.assign(globalThis, { DOMMatrix, Path2D, ImageData });
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

async function withPdf(base64, action) {
  if (
    typeof base64 !== "string" ||
    base64.length > 36 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  )
    throw new Error("论文内容无效或超过 25 MB。");
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.length > 25 * 1024 * 1024 ||
    bytes.subarray(0, 5).toString() !== "%PDF-"
  )
    throw new Error("不是有效大小的 PDF。");
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 500) throw new Error("页数超出本次处理范围。");
    return await action(pdf, {
      paperSha256: sha256(bytes),
      pageCount: pdf.numPages,
      pdfBase64: base64,
    });
  } finally {
    await task.destroy();
  }
}

async function pageText(pdf, pageIndex) {
  const content = await (await pdf.getPage(pageIndex + 1)).getTextContent();
  return content.items.map((item) => item.str || "").join(" ");
}
export async function extractPage(base64, pageIndex) {
  if (!Number.isInteger(pageIndex) || pageIndex < 0)
    throw new Error("页码无效。");
  return withPdf(base64, async (pdf, source) => {
    if (pageIndex >= pdf.numPages) throw new Error("页数超出本次处理范围。");
    const text = await pageText(pdf, pageIndex);
    if (!text.trim())
      throw new Error("此页没有文本层，需要先提供可核对的文字或 OCR 材料。");
    return { ...source, pageIndex, text };
  });
}
export async function extractPaper(base64) {
  return withPdf(base64, async (pdf, source) => {
    const pages = [];
    let characters = 0;
    for (let index = 0; index < pdf.numPages; index++) {
      const text = await pageText(pdf, index);
      characters += text.length;
      if (characters > 1_000_000)
        throw new Error("全文文本超过本机百万字符预算，未建立覆盖结论。");
      pages.push({
        index,
        text,
        quality: text.trim() ? "text_layer" : "no_text",
      });
    }
    return {
      ...source,
      pages,
      extraction: "pdf_text_layer_only_not_mathematical_parsing",
    };
  });
}

// Separate versioned evidence: never replace the original joined text or its
// historical extraction protocol with inferred mathematical notation.
export async function extractPageGeometry(
  base64,
  pageIndex,
  {
    render = true,
    visibility = false,
    geometryVersion = visibility
      ? "lemma.pdf-geometry.v3"
      : "lemma.pdf-geometry.v1",
  } = {},
) {
  if (
    ![
      "lemma.pdf-geometry.v1",
      "lemma.pdf-geometry.v2",
      "lemma.pdf-geometry.v3",
    ].includes(geometryVersion)
  )
    throw Error("未知页面几何版本。");
  if (visibility !== (geometryVersion !== "lemma.pdf-geometry.v1"))
    throw Error("页面几何版本与可见性选项不符。");
  const safeGeometry = geometryVersion === "lemma.pdf-geometry.v3";
  return withPdf(base64, async (pdf, source) => {
    if (
      !Number.isInteger(pageIndex) ||
      pageIndex < 0 ||
      pageIndex >= pdf.numPages
    )
      throw Error("页码无效。");
    const page = await pdf.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.67 });
    if (
      ![viewport.width, viewport.height].every(
        (n) => Number.isFinite(n) && n > 0,
      ) ||
      viewport.width * viewport.height > 12_000_000
    )
      throw Error("页图超过本次像素预算。");
    const items = content.items
      .filter((i) => typeof i.str === "string")
      .map((i, index) => ({
        index,
        text: i.str,
        transform: i.transform,
        width: i.width,
        height: i.height,
        fontName: i.fontName,
        direction: i.dir,
        hasEOL: !!i.hasEOL,
      }));
    const text = content.items.map((i) => i.str || "").join(" ");
    let pageImage = null,
      visibilityEvidence = null;
    if (render) {
      const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport,
        canvas,
      }).promise;
      if (visibility)
        visibilityEvidence = (
          safeGeometry ? textVisibility : legacyTextVisibility
        )(
          items,
          content.styles,
          viewport,
          canvas
            .getContext("2d")
            .getImageData(0, 0, canvas.width, canvas.height),
        );
      const png = canvas.toBuffer("image/png");
      pageImage = {
        mimeType: "image/png",
        sha256: sha256(png),
        width: canvas.width,
        height: canvas.height,
        scale: 1.67,
        base64: png.toString("base64"),
      };
    }
    const fonts = new Map(
      items
        .map((i) => i.fontName)
        .filter((n, i, a) => a.indexOf(n) === i)
        .map((n, i) => [n, `font-${i}`]),
    );
    const result = {
      schemaVersion: geometryVersion,
      ...(visibility
        ? {
            visibility: {
              method: safeGeometry
                ? "bounding_box_pixel_range_v2"
                : "bounding_box_pixel_range_v1",
              items: visibilityEvidence,
              authority: "diagnostic_not_visibility_or_formula_certificate",
            },
          }
        : {}),
      paperSha256: source.paperSha256,
      pageIndex,
      text,
      textSha256: sha256(text),
      pageView: page.view,
      rotation: page.rotate,
      coordinates:
        "PDF.js text transforms in PDF user space; page image has top-left pixel origin",
      viewportTransform: viewport.transform,
      items: safeGeometry
        ? items.map((i) => ({ ...i, fontName: fonts.get(i.fontName) }))
        : items,
      ...(safeGeometry
        ? {
            fontMetrics: [...fonts].map(([name, id]) => ({
              fontName: id,
              ascent: content.styles[name]?.ascent ?? null,
              descent: content.styles[name]?.descent ?? null,
            })),
            numericDiagnostics:
              "nonfinite_values_preserved_as_tagged_objects_not_inferred_coordinates",
          }
        : {}),
      pageImage,
      quality: {
        replacementCharacters: (text.match(/\uFFFD/g) || []).length,
        mathematicalFidelity: "not_certified_by_text_geometry_or_image_hash",
      },
    };
    return safeGeometry ? geometryDiagnosticValue(result) : result;
  });
}
