import test from "node:test";
import assert from "node:assert/strict";
import { brief } from "../src/reader-model.js";

test("brief counts Unicode code points and never splits surrogate pairs", () => {
  assert.equal(brief("A😀B", 3), "A😀B");
  assert.equal(brief("A😀BC", 3), "A😀…");
  assert.equal(brief("😀😀😀", 2), "😀…");
  assert.equal(brief("  A\n😀 B  ", 4), "A 😀…");
  assert.equal(brief("ABC", 1), "…");
  assert.equal(brief("", 3), "");
});
