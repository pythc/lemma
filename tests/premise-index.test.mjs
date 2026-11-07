import test from "node:test";
import assert from "node:assert/strict";
import {
  premiseTerms,
  rankPremiseDeclarations,
  searchPremises,
} from "../server/premise-index.mjs";
const entry = (name, file, line = 1) => ({
  name,
  file,
  line,
  snippet: `theorem ${name} : StrictMono φ ∧ Tendsto (x ∘ φ) atTop (nhds a)`,
  module: file.slice(0, -5).replaceAll("/", "."),
});
test("declaration token matching repairs word order without preferring unrelated long substring matches", () => {
  const entries = [
    entry(
      "tendsto_div_of_monotone_of_exists_subseq_tendsto_div",
      "Mathlib/FloorPow.lean",
    ),
    entry("IsCompact.tendsto_subseq", "Mathlib/Topology/Sequences.lean"),
    entry(
      "LowerHemicontinuousAt.exists_subseq_tendsto",
      "Mathlib/Hemicontinuity.lean",
    ),
  ];
  const result = rankPremiseDeclarations(
    entries,
    ["Function.exists_subseq_tendsto"],
    "StrictMono φ ∧ Tendsto (x ∘ φ) atTop (nhds a)",
    3,
  );
  assert.equal(result[0].name, "IsCompact.tendsto_subseq");
  assert.equal(result[0].module, "Mathlib.Topology.Sequences");
});
test("separate query concepts retain result slots and camel case is normalized", () => {
  assert.deepEqual(premiseTerms("IsSeqCompact"), ["seq", "compact"]);
  const result = rankPremiseDeclarations(
    [
      entry("UniformContinuous", "Mathlib/U.lean"),
      entry("ConvexOn", "Mathlib/C.lean"),
    ],
    ["uniform continuity", "ConvexOn"],
    "",
    2,
  );
  assert.equal(result.length, 2);
  assert.ok(result.some((e) => e.name === "ConvexOn"));
});
test("empty searches do not invent premises and malformed queries never reach Git", async () => {
  assert.deepEqual((await searchPremises([])).matches, []);
  await assert.rejects(searchPremises(["unsafe\nquery"]));
  await assert.rejects(searchPremises(["ConvexOn"], { limit: 0 }));
});
test("a namespace token alone cannot masquerade as a match for a missing qualified declaration", () => {
  const entries = [
    entry("IsComplex", "Mathlib/Unrelated.lean"),
    entry("Complex.arg", "Mathlib/ComplexArg.lean"),
  ];
  assert.deepEqual(rankPremiseDeclarations(entries, ["Complex.dilog"]), []);
  assert.equal(
    rankPremiseDeclarations(entries, ["Complex.arg"])[0].name,
    "Complex.arg",
  );
});
