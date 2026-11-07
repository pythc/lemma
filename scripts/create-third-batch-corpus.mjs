import { mkdir, writeFile } from "node:fs/promises";
import { digest } from "../server/evidence.mjs";
const tuples = [
  [
    "add-zero",
    "For each natural number n (including zero), n + 0 = n.",
    "∀ n : Nat, n + 0 = n",
    "accept",
  ],
  [
    "mul-one",
    "For each natural number n (including zero), n * 1 = n.",
    "∀ n : Nat, n * 1 = n",
    "accept",
  ],
  [
    "integer-add",
    "For any integers x and y, x + y = y + x.",
    "∀ x y : Int, x + y = y + x",
    "accept",
  ],
  [
    "succ-exists",
    "For every natural number n (including zero), there exists a natural number m such that n < m.",
    "∀ n : Nat, ∃ m : Nat, n < m",
    "accept",
  ],
  ["reflexive", "For each integer z, z = z.", "∀ z : Int, z = z", "accept"],
  [
    "conditional",
    "For natural numbers a and b (including zero), if a = b then b = a.",
    "∀ a b : Nat, a = b → b = a",
    "accept",
  ],
  [
    "zero-bound",
    "For every natural number n (including zero), 0 <= n.",
    "∀ n : Nat, 0 ≤ n",
    "accept",
  ],
  [
    "false-faithful-new",
    "For every natural number n (including zero), n + 1 = n.",
    "∀ n : Nat, n + 1 = n",
    "accept",
  ],
  [
    "empty-premise-new",
    "For every natural number n (including zero), if n < 0 then n = 7.",
    "∀ n : Nat, n < 0 → n = 7",
    "accept",
  ],
  [
    "neg-involution",
    "For every integer z, -(-z) = z.",
    "∀ z : Int, -(-z) = z",
    "accept",
  ],
  [
    "change-plus",
    "For each natural number n (including zero), n + 0 = n.",
    "∀ n : Nat, n + 1 = n",
    "reject",
  ],
  [
    "change-quantifier",
    "For every natural number n (including zero), there exists a natural number m with n < m.",
    "∃ m : Nat, ∀ n : Nat, n < m",
    "reject",
  ],
  [
    "drop-conclusion",
    "For every natural number n (including zero), n = n and n + 1 > n.",
    "∀ n : Nat, n = n",
    "reject",
  ],
  [
    "change-domain",
    "For every integer z, z + 0 = z.",
    "∀ z : Nat, z + 0 = z",
    "reject",
  ],
  [
    "strengthen-premise",
    "For any integers x and y, if x <= y then x = y.",
    "∀ x y : Int, x = y → x = y",
    "reject",
  ],
  [
    "weaken-strict",
    "For every natural number n (including zero), 0 < n.",
    "∀ n : Nat, 0 ≤ n",
    "reject",
  ],
  [
    "missing-admissible",
    "Every admissible natural number n is positive. The meaning of admissible is specified in Appendix X, which is not included.",
    "∀ n : Nat, 0 < n",
    "unknown",
  ],
  [
    "missing-operation",
    "For every integer z, the operation F defined in the missing supplement satisfies F(z) = z.",
    "∀ z : Int, z = z",
    "unknown",
  ],
  [
    "missing-convention",
    "Every natural number is positive. The zero convention is defined in the unavailable notation appendix.",
    "∀ n : Nat, 0 < n",
    "unknown",
  ],
  [
    "missing-section",
    "Every regular integer z has property Q. The definitions of regular and Q are in the unavailable Section 9.",
    "∀ z : Int, z = z",
    "unknown",
  ],
];
const out = "evaluation/sets/third-batch-semantics";
await mkdir(out, { recursive: false });
const dataset = {
  schemaVersion: "lemma.semantic-cases.v1",
  provenance:
    "new_authored_cases_frozen_before_model_trials_not_independent_expert_gold",
  cases: tuples.map(([id, quote, candidate]) => ({
    id,
    pages: [{ pageIndex: 0, text: quote }],
    pageIndex: 0,
    quote,
    candidate,
  })),
};
await writeFile(out + "/inputs.json", JSON.stringify(dataset, null, 2), {
  flag: "wx",
});
await writeFile(
  out + "/evaluator-gold.json",
  JSON.stringify(
    {
      datasetHash: digest(dataset),
      independentExpertLabels: false,
      labels: tuples.map(([caseId, source, target, expectation]) => ({
        caseId,
        expectation,
        source,
        target,
        reason:
          expectation === "accept"
            ? "Literal source-preserving translation; mathematical truth is a separate obligation."
            : expectation === "reject"
              ? "The supplied target changes the stated source domain, quantifier, premise or conclusion."
              : "Required source definitions or conventions are explicitly unavailable; unknown or concern must persist.",
      })),
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    cases: tuples.length,
    expected: { accept: 10, reject: 6, unknown: 4 },
    datasetHash: digest(dataset),
    independentExpertLabels: false,
  }),
);
