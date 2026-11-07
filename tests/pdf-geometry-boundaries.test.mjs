import test from "node:test";
import assert from "node:assert/strict";
import {
  textVisibility,
  geometryDiagnosticValue,
} from "../server/pdf-visibility.mjs";
import { canonical } from "../server/evidence.mjs";
const pixels = { width: 20, height: 20, data: new Uint8Array(20 * 20 * 4) };
const viewport = { transform: [1, 0, 0, 1, 0, 0], scale: 1 };
const item = {
  index: 0,
  text: "x",
  transform: [5, 0, 0, 5, 2, 5],
  width: 4,
  height: 5,
  fontName: "font",
};
test("nonfinite and missing font geometry stays explicit without inferred coordinates", () => {
  for (const ascent of [NaN, Infinity, -Infinity, undefined]) {
    const result = textVisibility(
      [item],
      { font: { ascent, descent: -0.2 } },
      viewport,
      pixels,
    )[0];
    assert.equal(result.status, "unresolved");
    assert.equal(result.box, null);
    assert.deepEqual(result.flags, ["font_metrics_unresolved"]);
    assert.doesNotThrow(() => canonical(result));
  }
  assert.deepEqual(geometryDiagnosticValue([NaN, Infinity]), [
    { kind: "non_finite_number", value: "NaN" },
    { kind: "non_finite_number", value: "Infinity" },
  ]);
});
test("invalid transforms, overflow and overlapping large samples are bounded", () => {
  for (const transform of [
    [NaN, 0, 0, 1, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [1e308, 0, 0, 1e308, 1e308, 1e308],
  ]) {
    const r = textVisibility(
      [{ ...item, transform }],
      { font: { ascent: 0.8, descent: -0.2 } },
      viewport,
      pixels,
    )[0];
    assert.equal(r.status, "unresolved");
    assert.equal(r.box, null);
  }
  const large = {
    ...item,
    width: 2000,
    height: 2000,
    transform: [2000, 0, 0, 2000, 0, 400],
  };
  const r = textVisibility(
    [large],
    { font: { ascent: 0.8, descent: -0.2 } },
    viewport,
    { width: 2500, height: 2500, data: new Uint8Array(0) },
  )[0];
  assert.equal(r.flags[0], "visibility_sample_budget_exceeded");
  assert.equal(r.sampledPixels, 0);
});
