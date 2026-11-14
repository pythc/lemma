import test from "node:test";
import assert from "node:assert/strict";
import { brief } from "../src/reader-model.js";

test("brief counts grapheme clusters without splitting emoji or combining marks", () => {
  assert.equal(brief("A😀B", 3), "A😀B");
  assert.equal(brief("A😀BC", 3), "A😀…");
  assert.equal(brief("😀😀😀", 2), "😀…");
  assert.equal(brief("  A\n😀 B  ", 4), "A 😀…");
  for (const cluster of ["🇨🇳", "👍🏽", "👨‍👩‍👧‍👦", "e\u0301"]) {
    assert.equal(brief(`A${cluster}B`, 3), `A${cluster}B`);
    assert.equal(brief(`A${cluster}BC`, 3), `A${cluster}…`);
  }
  assert.equal(brief("ABC", 1), "…");
  assert.equal(brief("", 3), "");
});
