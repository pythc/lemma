import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractPage } from "../server/pdf.mjs";
import { sha256 } from "../server/evidence.mjs";
import {
  pageGeometry,
  mathematicalDiscrepancies,
  mathContext,
  validateMathematicalSource,
  MATH_DIFFERENCE_POLICY,
} from "../server/math-extraction.mjs";
import { semanticReview, validateResolutions } from "../server/semantics.mjs";
test("real PDF geometry retains legacy text, deterministic page pixels and source identity", async () => {
  const bytes = await readFile(
    new URL("../public/analysis-fixtures.pdf", import.meta.url),
  );
  const base64 = bytes.toString("base64"),
    legacy = await extractPage(base64, 0),
    geometry = await pageGeometry(base64, 0);
  assert.equal(geometry.text, legacy.text);
  assert.equal(geometry.paperSha256, sha256(bytes));
  assert.ok(geometry.items.some((i) => i.transform.length === 6));
  assert.equal(
    sha256(Buffer.from(geometry.pageImage.base64, "base64")),
    geometry.pageImage.sha256,
  );
  const source = {
    ...legacy,
    mathEvidence: {
      schemaVersion: "lemma.math-source.v1",
      paperSha256: legacy.paperSha256,
      pages: [{ geometry, parser: { status: "not_requested" }, issues: [] }],
    },
  };
  assert.equal(
    (await validateMathematicalSource(source)).geometryReproduced,
    true,
  );
  source.mathEvidence.pages[0].geometry.items[0].text += "changed";
  await assert.rejects(validateMathematicalSource(source), /归档/);
});
test("a constructed parser conflict remains unresolved even if a reviewer provides a generic confirmation", () => {
  const geometry = {
    pageIndex: 0,
    quality: { replacementCharacters: 0 },
    items: [],
    textSha256: "fixture",
  };
  const parser = {
    status: "parsed",
    result: {
      items: [
        {
          label: "formula",
          originalText: "z z",
          text: "z \\bar{z}",
          provenance: [{ page_no: 1, bbox: [0, 0, 1, 1] }],
        },
      ],
    },
  };
  const issues = mathematicalDiscrepancies(geometry, parser);
  assert.equal(issues.length, 1);
  const context = {
    pages: [],
    omittedPages: [],
    supplements: [],
    mathEvidence: mathContext({
      schemaVersion: "lemma.math-source.v1",
      paperSha256: "fixture",
      pages: [{ geometry, parser, issues }],
    }),
  };
  const contract = {
    targetHash: "f".repeat(64),
    leanTarget: "True",
    quote: "Fixture",
    statement: "Fixture",
    assumptions: [],
  };
  const review = semanticReview(contract, context, [], null, {
    status: "well_typed",
    targetHash: contract.targetHash,
  });
  assert.throws(
    () =>
      validateResolutions(
        review,
        review.issues.map((i) => ({
          issueId: i.id,
          decision: "confirmed_with_reason",
          reason:
            "A generic confirmation must not clear extraction uncertainty.",
        })),
      ),
    /原文抽取/,
  );
});

test("an explicitly requested parser failure cannot silently become a successful text-only extraction", () => {
  const geometry = { pageIndex: 0, quality: { replacementCharacters: 0 } };
  for (const status of ["unavailable", "timeout", "failed", "cancelled"]) {
    const issues = mathematicalDiscrepancies(geometry, { status });
    assert.equal(issues[0].code, "document_parser_incomplete");
    assert.equal(issues[0].blocking, true);
  }
  assert.deepEqual(
    mathematicalDiscrepancies(geometry, { status: "not_requested" }),
    [],
  );
});
test("unpaired visual formula delimiters block new evidence while legacy v2 remains reproducible", async () => {
  const source = JSON.parse(
    await readFile(
      new URL(
        "../fixtures/semantic-source-page-reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(source.families.includes("piecewise"), true);
  const geometry = { pageIndex: 0, quality: { replacementCharacters: 0 } };
  const parser = {
    status: "parsed",
    result: {
      items: [
        {
          label: "formula",
          originalText: "f(x)=0 if x<0; 1 otherwise",
          text: "f(x)=\\left\\{\\begin{array}{ll}0&x<0\\\\1&x>=0\\end{array}",
          provenance: [],
        },
      ],
    },
  };
  assert.deepEqual(
    mathematicalDiscrepancies(geometry, parser, {
      policy: "lemma.math-differences.v2",
    }),
    [],
  );
  assert.equal(
    mathematicalDiscrepancies(geometry, parser)[0].code,
    "formula_latex_delimiter_unpaired",
  );
  parser.result.items[0].text += "\\right.";
  assert.deepEqual(mathematicalDiscrepancies(geometry, parser), []);
});

test("new formula checks retain legacy policy while surfacing radical and malformed grouping concerns", async () => {
  const bytes = await readFile(
    new URL("../fixtures/math-source-geometry.pdf", import.meta.url),
  );
  const source = await extractPage(bytes.toString("base64"), 0);
  const geometry = await pageGeometry(source.pdfBase64, 0);
  // Regression shapes observed in a real Docling run, not an accuracy mock.
  const parser = {
    status: "parsed",
    result: {
      paperSha256: source.paperSha256,
      pageIndex: 0,
      items: [
        {
          label: "formula",
          originalText: "z z = a 2 + b 2",
          text: "z \\sqrt{z} = a^{2} + b^{2}",
          provenance: [],
        },
        {
          label: "formula",
          originalText: "x n = 1 n + 1",
          text: "\\begin{array}{rl} {x_n} & = } & {\\frac{1}{n+1}} \\end{array}",
          provenance: [],
        },
      ],
    },
  };
  const current = mathematicalDiscrepancies(geometry, parser);
  assert.deepEqual(
    current.map((i) => i.code),
    ["formula_operator_not_grounded_in_text", "formula_latex_grouping_invalid"],
  );
  const oldIssues = mathematicalDiscrepancies(geometry, parser, {
    policy: "lemma.math-differences.v1",
  });
  source.mathEvidence = {
    schemaVersion: "lemma.math-source.v1",
    paperSha256: source.paperSha256,
    pages: [{ geometry, parser, issues: oldIssues }],
  };
  assert.deepEqual(oldIssues, []);
  const legacy = await validateMathematicalSource(source);
  assert.equal(legacy.geometryReproduced, true);
  assert.equal(legacy.currentPolicyIssues.length, 2);
  source.mathEvidence.schemaVersion = "lemma.math-source.v2";
  source.mathEvidence.differencePolicy = MATH_DIFFERENCE_POLICY;
  await assert.rejects(validateMathematicalSource(source), /归档不一致/);
  source.mathEvidence.pages[0].issues = current;
  assert.equal(
    (await validateMathematicalSource(source)).geometryReproduced,
    true,
  );
  const context = {
    pages: [{ pageIndex: 0, text: source.text }],
    omittedPages: [],
    supplements: [],
    mathEvidence: mathContext(source.mathEvidence),
  };
  const contract = {
    targetHash: "f".repeat(64),
    leanTarget: "True",
    quote: source.text,
    statement: "Controlled guard check only; not a paper formalization.",
    assumptions: [],
  };
  const review = semanticReview(contract, context, [], null, {
    status: "well_typed",
    targetHash: contract.targetHash,
  });
  assert.throws(
    () =>
      validateResolutions(
        review,
        review.issues.map((i) => ({
          issueId: i.id,
          decision: "confirmed_with_reason",
          reason: "Generic approval must not dismiss the extraction failure.",
        })),
      ),
    /原文抽取/,
  );
});

test("rendered visibility catches hidden and clipped text while preserving real footnotes and legacy geometry", async () => {
  const base64 = (
    await readFile(
      new URL("../fixtures/third-batch-visibility.pdf", import.meta.url),
    )
  ).toString("base64");
  const g = await pageGeometry(base64, 0, { visibility: true }),
    old = await pageGeometry(base64, 0);
  assert.equal(g.text, old.text);
  assert.equal(old.schemaVersion, "lemma.pdf-geometry.v1");
  assert.equal(old.visibility, undefined);
  const entries = g.visibility.items.map((x) => ({
    ...x,
    text: g.items[x.itemIndex].text,
  }));
  for (const prefix of ["WHITE:", "TRANSPARENT:", "COVERED:", "TINY:", "PPED:"])
    assert.ok(
      entries.find((x) => x.text.startsWith(prefix))?.flags.length,
      prefix,
    );
  for (const prefix of ["VISIBLE:", "FOOTNOTE:", "LIGHT:", "OVERPRINT:"])
    assert.deepEqual(
      entries.find((x) => x.text.startsWith(prefix)).flags,
      [],
      prefix,
    );
  const issues = mathematicalDiscrepancies(g, null);
  assert.equal(issues.length, 5);
  assert.deepEqual(
    mathematicalDiscrepancies(g, null, { policy: "lemma.math-differences.v3" }),
    [],
  );
  const source = await extractPage(base64, 0);
  source.mathEvidence = {
    schemaVersion: "lemma.math-source.v2",
    differencePolicy: "lemma.math-differences.v3",
    paperSha256: source.paperSha256,
    pages: [{ geometry: old, parser: { status: "not_requested" }, issues: [] }],
  };
  const replay = await validateMathematicalSource(source);
  assert.equal(replay.geometryReproduced, true);
  assert.equal(replay.currentPolicyIssues.length, 5);
  const review = semanticReview(
    { leanTarget: "True", quote: g.text, assumptions: [] },
    {
      pages: [],
      omittedPages: [],
      mathEvidence: mathContext({
        ...source.mathEvidence,
        pages: [{ geometry: g, parser: { status: "not_requested" }, issues }],
      }),
    },
    [],
    null,
  );
  assert.equal(review.issues.filter((x) => x.sourceEvidenceRequired).length, 5);
});
