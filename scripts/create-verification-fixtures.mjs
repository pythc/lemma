import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdir, writeFile } from "node:fs/promises";

const cases = [
  { label: "Theorem 1", quote: "For every natural number n, n + 0 = n.", statement: "对任意自然数 n，n + 0 = n。", assumptions: ["n 为自然数"],
    leanTarget: "∀ n : Nat, n + 0 = n", proof: "by\n  intro n\n  rfl", proofMode: "proof", expected: "formalized_proved",
    note: "This follows from the definition of addition by zero." },
  { label: "Theorem 2", quote: "For every natural number n, n + 1 = n.", statement: "对任意自然数 n，n + 1 = n。", assumptions: ["n 为自然数"],
    leanTarget: "∀ n : Nat, n + 1 = n", proof: "by\n  intro h\n  have bad := h 0\n  simp at bad", proofMode: "counterexample", expected: "refuted",
    note: "Deliberately false. The value n = 0 refutes the statement." },
  { label: "Theorem 3", quote: "For every natural number n, n * n >= n.", statement: "对任意自然数 n，n² ≥ n。", assumptions: ["n 为自然数"],
    leanTarget: "∀ n : Nat, n * n ≥ n", proof: "by\n  intro n\n  rfl", proofMode: "proof", expected: "unknown",
    note: "This statement is true, but the supplied rfl proof is invalid.",
    extra: "Failure of this proof attempt must not be reported as a false theorem." },
];
const pdf = await PDFDocument.create();
pdf.setTitle("Lemma Verification Infrastructure Fixtures"); pdf.setAuthor("Lemma original teaching fixtures");
pdf.setCreationDate(new Date("2026-10-17T00:00:00Z")); pdf.setModificationDate(new Date("2026-10-17T00:00:00Z"));
const roman = await pdf.embedFont(StandardFonts.TimesRoman), bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
for (const [i, item] of cases.entries()) {
  const page = pdf.addPage([612, 792]);
  page.drawText("SELF-AUTHORED TEST FIXTURE - NOT RESEARCH", { x: 60, y: 740, size: 9, font: roman });
  page.drawText(`${item.label} - Verification case ${i + 1}`, { x: 60, y: 680, size: 20, font: bold });
  page.drawText(item.quote, { x: 60, y: 625, size: 14, font: roman });
  page.drawText(item.note, { x: 60, y: 575, size: 12, font: roman });
  if (item.extra) page.drawText(item.extra, { x: 60, y: 550, size: 12, font: roman });
  page.drawText("Scope: one explicitly selected claim; no model has been invoked by this file.", { x: 60, y: 480, size: 11, font: roman });
}
await mkdir("fixtures", { recursive: true });
await writeFile("public/verification-fixtures.pdf", await pdf.save());
await writeFile("fixtures/verification-cases.json", JSON.stringify({ authored: true, cases }, null, 2) + "\n");
console.log("Created three original fixtures with separate expected outcomes.");
