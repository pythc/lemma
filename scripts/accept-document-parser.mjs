import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractPage } from "../server/pdf.mjs";
import { pageGeometry, parseDoclingPage, mathematicalDiscrepancies, validateMathematicalSource, mathContext, MATH_DIFFERENCE_POLICY } from "../server/math-extraction.mjs";
import { sha256 } from "../server/evidence.mjs";
const [file, page, output] = process.argv.slice(2);
if (!file || !page || !output) throw Error("Usage: node scripts/accept-document-parser.mjs paper.pdf page-number NEW-output-directory");
const pageIndex = Number(page) - 1;
await mkdir(output, { recursive: false });
const report = { classification: "real_local_docling_execution_not_general_extraction_accuracy",
  input: { file: path.resolve(file), pageIndex }, executionAccepted: false, qualityAccepted: false };
try {
  const bytes = await readFile(file), base64 = bytes.toString("base64");
  const [legacy, geometry] = await Promise.all([extractPage(base64, pageIndex), pageGeometry(base64, pageIndex)]);
  assert.equal(geometry.text, legacy.text);
  await writeFile(path.join(output, "page.png"), Buffer.from(geometry.pageImage.base64, "base64"), { flag: "wx" });
  const parser = await parseDoclingPage(base64, pageIndex, { output: path.join(output, "parser") });
  const { directory: _localPath, ...portable } = parser;
  const issues = mathematicalDiscrepancies(geometry, parser);
  const source = { ...legacy, mathEvidence: { schemaVersion: "lemma.math-source.v2", differencePolicy: MATH_DIFFERENCE_POLICY, paperSha256: sha256(bytes),
    pages: [{ geometry, parser: portable, issues }], authority: "preserved_source_and_extraction_candidates_not_semantic_truth" } };
  await writeFile(path.join(output, "source.json"), JSON.stringify(source), { flag: "wx" });
  report.parserStatus = parser.status;
  report.parserError = parser.error || parser.result?.error || null;
  report.formulas = parser.result?.items?.filter((i) => i.label === "formula").map((i) => ({
    text: i.text, originalText: i.originalText, provenance: i.provenance,
    crop: i.crop ? { sha256: i.crop.sha256, width: i.crop.width, height: i.crop.height } : null,
  })) || [];
  report.issues = issues;
  report.qualityStatus = issues.some((i) => i.blocking) ? "blocked_by_extraction_conflict" : "requires_page_comparison";
  report.sourceRecheck = await validateMathematicalSource(source);
  assert.equal(parser.status, "parsed", JSON.stringify(report.parserError));
  assert.ok(report.formulas.length > 0, "Real model did not return any formula candidates");
  assert.ok(!JSON.stringify(mathContext(source.mathEvidence)).includes('"base64"'), "Text model context must not misrepresent image exposure");
  report.executionAccepted = true;
} catch (e) {
  report.error = e.message;
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, "result.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, executionAccepted: report.executionAccepted, qualityAccepted: report.qualityAccepted,
    qualityStatus: report.qualityStatus, parserStatus: report.parserStatus, formulas: report.formulas?.length, error: report.error }));
}
