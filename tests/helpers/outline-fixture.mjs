import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";

// Self-authored UI fixture with real PDF bookmark objects, not a research paper.
export async function makeOutlineFixture() {
  const pdf = await PDFDocument.create();
  pdf.setTitle("PDF outline reader test fixture");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = Array.from({ length: 3 }, (_, i) => {
    const page = pdf.addPage([612, 792]);
    page.drawText("READER TEST FIXTURE - NOT A RESEARCH PAPER", {
      x: 50,
      y: 740,
      size: 11,
      font,
    });
    page.drawText(
      ["1 Introduction", "1.1 A nested bookmark", "2 Final section"][i],
      { x: 50, y: i === 1 ? 500 : 680, size: 22, font },
    );
    return page;
  });
  const ctx = pdf.context;
  const root = ctx.nextRef(),
    first = ctx.nextRef(),
    child = ctx.nextRef(),
    last = ctx.nextRef();
  ctx.assign(
    root,
    ctx.obj({ Type: "Outlines", First: first, Last: last, Count: 3 }),
  );
  ctx.assign(
    first,
    ctx.obj({
      Title: PDFString.of("1 Introduction"),
      Parent: root,
      Next: last,
      Dest: [pages[0].ref, "Fit"],
      First: child,
      Last: child,
      Count: 1,
    }),
  );
  ctx.assign(
    child,
    ctx.obj({
      Title: PDFString.of("1.1 A nested bookmark"),
      Parent: first,
      Dest: [pages[1].ref, "XYZ", 50, 500, null],
    }),
  );
  ctx.assign(
    last,
    ctx.obj({
      Title: PDFString.of("2 Final section"),
      Parent: root,
      Prev: first,
      Dest: PDFString.of("final-section"),
    }),
  );
  pdf.catalog.set(PDFName.of("Outlines"), root);
  pdf.catalog.set(
    PDFName.of("Dests"),
    ctx.obj({ "final-section": [pages[2].ref, "Fit"] }),
  );
  return pdf.save();
}
