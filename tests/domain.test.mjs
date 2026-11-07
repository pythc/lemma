import test from "node:test";
import assert from "node:assert/strict";
import {
  createAnnotation,
  demoAnnotations,
  identifyPdf,
  reportFor,
  validateAnchor,
} from "../src/domain.js";

const paper = {
  id: "version-a",
  pageCount: 3,
  isDemo: false,
  title: "Paper A",
};
const anchor = {
  pageIndex: 2,
  quote: "theorem",
  rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
};

test("PDF identity uses file bytes, not user-controlled file name", async () => {
  const a = new TextEncoder().encode("%PDF-1.7 content A").buffer,
    b = new TextEncoder().encode("%PDF-1.7 content B").buffer;
  assert.equal(await identifyPdf(a), await identifyPdf(a.slice(0)));
  assert.notEqual(await identifyPdf(a), await identifyPdf(b));
  await assert.rejects(
    identifyPdf(new TextEncoder().encode("renamed text file.pdf").buffer),
    /不是 PDF/,
  );
  await assert.rejects(identifyPdf(new ArrayBuffer(0)), /25 MB/);
  await assert.rejects(
    identifyPdf(new ArrayBuffer(25 * 1024 * 1024 + 1)),
    /25 MB/,
  );
});
test("anchors reject nonexistent pages and out-of-bounds selections", () => {
  assert.throws(() => validateAnchor({ ...anchor, pageIndex: 3 }, 3), /页码/);
  assert.throws(
    () =>
      validateAnchor(
        { ...anchor, rects: [{ x: 0.9, y: 0.1, width: 0.3, height: 0.1 }] },
        3,
      ),
    /超出/,
  );
  assert.throws(() => validateAnchor({ ...anchor, rects: [] }, 3), /选择/);
  assert.throws(
    () =>
      validateAnchor(
        { ...anchor, rects: [{ x: NaN, y: 0, width: 0.1, height: 0.1 }] },
        3,
      ),
    /超出/,
  );
});
test("human annotation cannot assert machine validation", () => {
  const note = createAnnotation(paper, anchor, "A claim", "Evidence to review");
  assert.equal(note.status, "needs_review");
  assert.equal(note.origin, "human");
  assert.deepEqual(note.tasks, []);
  assert.deepEqual(note.evidence, []);
  assert.equal(note.paperSha256, paper.id);
});
test("demo verdicts are never generated for an imported paper", () => {
  assert.deepEqual(demoAnnotations(paper), []);
  assert.equal(demoAnnotations({ ...paper, isDemo: true }).length, 3);
});
test("report excludes another paper and stale version evidence", () => {
  const note = createAnnotation(paper, anchor, "Claim", "Reason");
  const report = reportFor(paper, [
    note,
    { ...note, id: "other", paperId: "version-b" },
    { ...note, id: "stale", paperSha256: "old" },
  ]);
  assert.equal(report.annotations.length, 1);
  assert.equal(report.paper.sha256, paper.id);
  assert.match(report.scope, /未执行/);
});
