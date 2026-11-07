import test from "node:test";
import assert from "node:assert/strict";
import { validateTranslationDraft } from "../server/translation-preparation.mjs";
import {
  validateTranslationWire,
  ALIGNMENT_CATEGORIES,
} from "../server/translation-wire.mjs";
const quote = "Every natural number equals itself.";
const context = { pages: [{ pageIndex: 0, text: quote }], supplements: [] };
const candidate = () => ({
  label: "controlled",
  quote,
  statement: quote,
  assumptions: [],
  leanTarget: "∀ n : Nat, n = n",
  ambiguity: "",
  alignment: ALIGNMENT_CATEGORIES.map((category) => ({
    category,
    explanation: "Controlled mapping.",
    leanFragment: "n = n",
    anchors: [{ pageIndex: 0, quote }],
  })),
});
test("complete draft validation rejects pollution, missing fields and false source mappings without repair", () => {
  const good = candidate();
  assert.deepEqual(
    validateTranslationDraft(good, context, quote).candidate,
    good,
  );
  for (const mutate of [
    (p) => delete p.ambiguity,
    (p) =>
      (p.leanTarget +=
        '</leanTarget><｜｜DSML｜｜ parameter name="ambiguity">'),
    (p) => (p.quote = "Invented."),
    (p) => (p.alignment[0].leanFragment = "False"),
    (p) => (p.alignment[0].anchors = [{ pageIndex: 0, quote: "Invented." }]),
    (p) => (p.extra = true),
  ]) {
    const bad = candidate();
    mutate(bad);
    const before = JSON.stringify(bad);
    assert.throws(() => validateTranslationDraft(bad, context, quote));
    assert.equal(JSON.stringify(bad), before);
  }
  const bad = candidate();
  bad.leanTarget += "</leanTarget>";
  assert.throws(
    () => validateTranslationWire(bad),
    (e) => e.auditValidation.code === "translation_parameter_contamination",
  );
});
