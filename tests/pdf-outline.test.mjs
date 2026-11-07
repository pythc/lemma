import test from "node:test";
import assert from "node:assert/strict";
import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import {
  outlineEntries,
  resolveOutlineDestination,
  safeOutlineUrl,
} from "../src/pdf-outline.js";
import { makeOutlineFixture } from "./helpers/outline-fixture.mjs";
globalThis.DOMMatrix ??= DOMMatrix;
globalThis.ImageData ??= ImageData;
globalThis.Path2D ??= Path2D;
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

test("real PDF bookmarks retain hierarchy and resolve reference and named targets", async () => {
  const pdf = await getDocument({ data: await makeOutlineFixture() }).promise;
  try {
    const tree = outlineEntries(await pdf.getOutline());
    assert.deepEqual(
      tree.map((x) => x.title),
      ["1 Introduction", "2 Final section"],
    );
    assert.equal(tree[0].children[0].title, "1.1 A nested bookmark");
    assert.notEqual(tree[0].id, tree[0].children[0].id);
    assert.deepEqual(await resolveOutlineDestination(pdf, tree[0].dest), {
      pageIndex: 0,
      fraction: 0,
    });
    assert.deepEqual(
      await resolveOutlineDestination(pdf, tree[0].children[0].dest),
      { pageIndex: 1, fraction: 292 / 792 },
    );
    assert.deepEqual(await resolveOutlineDestination(pdf, tree[1].dest), {
      pageIndex: 2,
      fraction: 0,
    });
    assert.deepEqual(
      await resolveOutlineDestination(pdf, [0, { name: "Fit" }]),
      { pageIndex: 0, fraction: 0 },
    );
  } finally {
    await pdf.loadingTask.destroy();
  }
});
test("missing or invalid destinations fail instead of navigating to an invented page", async () => {
  const pdf = {
    numPages: 3,
    getDestination: async () => null,
    getPageIndex: async () => 10,
  };
  for (const dest of [
    null,
    "missing",
    [],
    [-1],
    [3],
    [1.5],
    [{ num: 9, gen: 0 }],
    [{ num: 1 }],
  ])
    await assert.rejects(resolveOutlineDestination(pdf, dest), /目标/);
});
test("outline fallback never fabricates chapters and external bookmarks accept only http(s)", () => {
  assert.deepEqual(outlineEntries(null), []);
  assert.deepEqual(outlineEntries([]), []);
  assert.equal(
    outlineEntries([{ title: "", items: [] }])[0].title,
    "未命名书签",
  );
  for (const url of [
    null,
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,test",
    "relative.pdf",
  ])
    assert.equal(safeOutlineUrl(url), null);
  assert.equal(
    safeOutlineUrl("https://example.org/paper"),
    "https://example.org/paper",
  );
});
