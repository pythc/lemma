import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { mkdir, writeFile } from "node:fs/promises";

const pdf = await PDFDocument.create();
pdf.setTitle("Sequences of Continuous Functions — Teaching Example");
pdf.setAuthor("Lemma teaching materials");
pdf.setCreationDate(new Date("2026-10-17T00:00:00Z"));
pdf.setModificationDate(new Date("2026-10-17T00:00:00Z"));
const roman = await pdf.embedFont(StandardFonts.TimesRoman);
const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
const headings = [
  "Introduction",
  "Definitions and scope",
  "Limits of continuous functions",
  "Uniform convergence",
  "Proof of the corrected statement",
  "Examples and non-examples",
  "References and dependencies",
  "Review notes",
];
for (let n = 0; n < 8; n++) {
  const page = pdf.addPage([612, 792]);
  const text = (s, x, y, size = 13, font = roman) =>
    page.drawText(s, { x, y, size, font, color: rgb(0.1, 0.1, 0.12) });
  const lines = (arr, y, size = 13, font = roman) =>
    arr.forEach((s, i) => text(s, 66, y - i * 21, size, font));
  text("Sequences of Continuous Functions and Limits", 66, 752, 10, italic);
  text(String(n + 1), 539, 752, 10);
  text("TEACHING EXAMPLE - NOT A RESEARCH PAPER", 66, 730, 7, italic);
  if (n === 2) {
    text("2.   Limits of continuous functions", 66, 686, 20, bold);
    lines(
      [
        "In this section we examine pointwise limits and continuity.",
        "The proposition below is deliberately false: it is included",
        "as a teaching example for a paper-review workbench.",
      ],
      646,
    );
    text("Proposition 2.1.", 66, 594, 13, bold);
    text("The pointwise limit of continuous functions", 169, 594, 13, italic);
    text("on [0,1] is continuous.", 66, 573, 13, italic);
    lines(
      [
        "A proposed argument. Let f_n be continuous and let f_n tend",
        "to f pointwise. For each x and each epsilon > 0, there is an",
        "N = N(x, epsilon) such that the difference is small for n >= N.",
        "Choosing a single N for every x would require justification.",
      ],
      532,
    );
    text("Example 2.2.", 66, 416, 13, bold);
    text("For n >= 1, consider the continuous functions", 156, 416);
    text("f_n(x) = x^n,       x in [0,1].", 185, 377, 17, italic);
    lines(
      [
        "For 0 <= x < 1 the limit is 0; at x = 1 the limit is 1.",
        "Thus the pointwise limit f is given by",
      ],
      337,
    );
    text("f(x) = 0   if 0 <= x < 1;      f(1) = 1.", 133, 273, 17, italic);
    lines(
      [
        "The left-hand limit of f at 1 is 0, but f(1) = 1.",
        "Consequently, f is not continuous at 1.",
      ],
      229,
    );
    text("Remark 2.3.", 66, 161, 13, bold);
    text("A corrected statement uses uniform convergence.", 145, 161);
    lines(
      [
        "The uniform limit of continuous functions is continuous.",
        "This is a different theorem; see the next page for its proof.",
      ],
      134,
    );
  } else {
    text(`${n + 1}.   ${headings[n]}`, 66, 686, 20, bold);
    const bodies = {
      0: [
        "This document is an original teaching fixture for Lemma.",
        "It contains a deliberately false statement and a counterexample.",
        "No result in this document is presented as new research.",
        "",
        "Read page 3 to inspect the annotated proposition.",
      ],
      1: [
        "A sequence f_n converges pointwise to f when:",
        "for each x and each epsilon > 0, there exists N(x, epsilon)",
        "such that |f_n(x) - f(x)| < epsilon whenever n >= N.",
        "",
        "Uniform convergence requires N to be independent of x.",
      ],
      3: [
        "Theorem 3.1. Let X be a metric space. If continuous functions",
        "f_n : X -> R converge uniformly to f, then f is continuous.",
        "",
        "Unlike Proposition 2.1, this statement assumes uniform",
        "convergence. The change in hypothesis must remain explicit.",
      ],
      4: [
        "Fix a point x_0 and epsilon > 0. By uniform convergence,",
        "choose n such that |f_n(x)-f(x)| < epsilon/3 for every x.",
        "By continuity of f_n at x_0, choose delta > 0 with",
        "|f_n(x)-f_n(x_0)| < epsilon/3 if d(x,x_0) < delta.",
        "The triangle inequality gives |f(x)-f(x_0)| < epsilon.",
        "",
        "This argument verifies the corrected theorem informally.",
        "It is not a machine-checked proof.",
      ],
      5: [
        "Example: f_n(x) = x/n on [0,1] converges uniformly to 0.",
        "Non-example: f_n(x) = x^n on [0,1] is only pointwise",
        "convergent; the limit has a discontinuity at the endpoint.",
      ],
      6: [
        "This teaching fixture is self-authored.",
        "Formal statements, external citations and their hypotheses",
        "must be checked against their original sources in real reviews.",
      ],
      7: [
        "Review scope: teaching proposition and the quantifier issue.",
        "Agent handoffs shown in the application are demonstration data.",
        "Lean has not been run; there is no proof certificate.",
        "",
        "User-imported papers start with no findings.",
      ],
    };
    lines(bodies[n] || [], 636);
  }
}
await mkdir("public", { recursive: true });
await writeFile("public/demo.pdf", await pdf.save());
console.log("Created original eight-page teaching PDF.");
