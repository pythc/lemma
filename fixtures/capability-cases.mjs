import { readFile } from "node:fs/promises";
const prior = JSON.parse(
  await readFile(new URL("./analysis-cases.json", import.meta.url)),
);
const c = (
  id,
  family,
  quote,
  leanTarget,
  proof,
  expected = "verified",
  mode = "proof",
) => ({
  id,
  family,
  split: ["composition", "algebraic_continuity"].includes(family)
    ? "holdout"
    : "development",
  sourceKind: "self_authored_mathlib_based_case_not_research_paper",
  referenceReview: "authored_reference_not_independent_expert_label",
  quote,
  statement: quote,
  assumptions: [],
  leanTarget,
  proof,
  mode,
  expected,
  libraryProfile: "analysis-continuity-v1",
});
export const cases = [
  c(
    "AN01",
    "heine_cantor",
    prior.cases[0].quote,
    prior.cases[0].leanTarget,
    prior.cases[0].proof,
  ),
  c(
    "AN02",
    "heine_cantor",
    "Every continuous real-valued function on the subtype of a closed real interval is uniformly continuous.",
    "∀ (a b : ℝ) (f : Set.Icc a b → ℝ), Continuous f → UniformContinuous f",
    "by intro a b f hf; exact CompactSpace.uniformContinuous_of_continuous hf",
  ),
  c(
    "AN03",
    "heine_cantor",
    "Every real function continuous on a compact subset of the reals is uniformly continuous on that subset.",
    "∀ (s : Set ℝ) (f : ℝ → ℝ), IsCompact s → ContinuousOn f s → UniformContinuousOn f s",
    "by intro s f hs hf; exact hs.uniformContinuousOn_of_continuous hf",
  ),
  c(
    "AN04",
    "heine_cantor",
    prior.cases[1].quote,
    prior.cases[1].leanTarget,
    prior.cases[1].proof,
    "verified",
    "counterexample",
  ),
  c(
    "AN05",
    "heine_cantor",
    prior.cases[0].quote,
    prior.cases[0].leanTarget,
    "by rfl",
    "not_verified",
  ),
  c(
    "AN06",
    "composition",
    "The identity function on the real numbers is continuous.",
    "Continuous (fun x : ℝ => x)",
    "by exact continuous_id",
  ),
  c(
    "AN07",
    "composition",
    "Every constant real-valued function on the real numbers is continuous.",
    "∀ c : ℝ, Continuous (fun _ : ℝ => c)",
    "by intro c; exact continuous_const",
  ),
  c(
    "AN08",
    "composition",
    "The composition of two continuous functions from the real numbers to themselves is continuous.",
    "∀ (f g : ℝ → ℝ), Continuous f → Continuous g → Continuous (g ∘ f)",
    "by intro f g hf hg; exact hg.comp hf",
  ),
  c(
    "AN09",
    "algebraic_continuity",
    "The pointwise product of two continuous real functions is continuous.",
    "∀ (f g : ℝ → ℝ), Continuous f → Continuous g → Continuous (fun x => f x * g x)",
    "by intro f g hf hg; exact hf.mul hg",
  ),
  c(
    "AN10",
    "algebraic_continuity",
    "Every natural-number power of a continuous real function is continuous.",
    "∀ (f : ℝ → ℝ) (n : ℕ), Continuous f → Continuous (fun x => (f x) ^ n)",
    "by intro f n hf; exact hf.pow n",
  ),
  c(
    "AN11",
    "restriction",
    "A continuous real function is continuous on any subset of the real numbers.",
    "∀ (f : ℝ → ℝ) (s : Set ℝ), Continuous f → ContinuousOn f s",
    "by intro f s hf; exact hf.continuousOn",
  ),
  c(
    "AN12",
    "restriction",
    "Continuity on a set restricts to continuity on each of its subsets.",
    "∀ (f : ℝ → ℝ) (s t : Set ℝ), t ⊆ s → ContinuousOn f s → ContinuousOn f t",
    "by intro f s t hts hf; exact hf.mono hts",
  ),
  c(
    "AN13",
    "restriction",
    "Every uniformly continuous real function is continuous.",
    "∀ (f : ℝ → ℝ), UniformContinuous f → Continuous f",
    "by intro f hf; exact hf.continuous",
  ),
  c(
    "AN14",
    "restriction",
    "Uniform continuity on a real set restricts to each of its subsets.",
    "∀ (f : ℝ → ℝ) (s t : Set ℝ), t ⊆ s → UniformContinuousOn f s → UniformContinuousOn f t",
    "by intro f s t hts hf; exact hf.mono hts",
  ),
  c(
    "AN15",
    "compact_image",
    "The image of a compact real set under a continuous real function is compact.",
    "∀ (s : Set ℝ) (f : ℝ → ℝ), IsCompact s → Continuous f → IsCompact (f '' s)",
    "by intro s f hs hf; exact hs.image hf",
  ),
  c(
    "AN16",
    "compact_image",
    "A function continuous on a compact real set has a compact image of that set.",
    "∀ (s : Set ℝ) (f : ℝ → ℝ), IsCompact s → ContinuousOn f s → IsCompact (f '' s)",
    "by intro s f hs hf; exact hs.image_of_continuousOn hf",
  ),
  c(
    "AN17",
    "compact_sets",
    "The empty subset of the real numbers is compact.",
    "IsCompact (∅ : Set ℝ)",
    "by exact isCompact_empty",
  ),
  c(
    "AN18",
    "compact_sets",
    "Every compact subset of the real numbers is closed.",
    "∀ s : Set ℝ, IsCompact s → IsClosed s",
    "by intro s hs; exact hs.isClosed",
  ),
  c(
    "AN19",
    "missing_definition",
    "Every function with the paper-specific property PaperRegular is continuous.",
    "∀ f : ℝ → ℝ, PaperRegular f → Continuous f",
    "by trivial",
    "not_verified",
  ),
  c(
    "AN20",
    "algebraic_continuity",
    "The pointwise product of two continuous real functions is continuous.",
    "∀ (f g : ℝ → ℝ), Continuous f → Continuous g → Continuous (fun x => f x * g x)",
    "by rfl",
    "not_verified",
  ),
];
export const semanticCases = [
  { id: "S01", target: prior.cases[0].leanTarget, expectedConcern: false },
  { id: "S02", target: "True", expectedConcern: true },
  {
    id: "S03",
    target: prior.cases[0].leanTarget.replace("∀", "∃"),
    expectedConcern: true,
  },
  {
    id: "S04",
    target:
      prior.cases[0].leanTarget + " → UniformContinuousOn f (Set.Icc a b)",
    expectedConcern: true,
  },
  {
    id: "S05",
    target: "False → (" + prior.cases[0].leanTarget + ")",
    expectedConcern: true,
  },
  {
    id: "S06",
    target: "∀ (f : ℝ → ℝ), Continuous f → UniformContinuous f",
    expectedConcern: true,
  },
  { id: "S07", target: cases[1].leanTarget, expectedConcern: false },
].map((item) => ({
  ...item,
  source: { ...prior.cases[0], leanTarget: item.target },
  labelKind: "constructed_mutation_not_observed_model_error",
}));

export const laterDomainCases = [
  {
    ...c(
      "LA01",
      "linear_preservation",
      "Every real linear map preserves addition.",
      "∀ (f : (Fin 2 → ℝ) →ₗ[ℝ] ℝ) (x y : Fin 2 → ℝ), f (x + y) = f x + f y",
      "by intro f x y; exact f.map_add x y",
    ),
    libraryProfile: "linear-maps-v1",
  },
  {
    ...c(
      "LA02",
      "linear_preservation",
      "Every real linear map preserves scalar multiplication.",
      "∀ (f : (Fin 2 → ℝ) →ₗ[ℝ] ℝ) (c : ℝ) (x : Fin 2 → ℝ), f (c • x) = c • f x",
      "by intro f c x; exact f.map_smul c x",
    ),
    libraryProfile: "linear-maps-v1",
  },
  {
    ...c(
      "LA03",
      "linear_zero",
      "Every real linear map sends the zero vector to zero.",
      "∀ (f : (Fin 2 → ℝ) →ₗ[ℝ] ℝ), f 0 = 0",
      "by intro f; exact f.map_zero",
    ),
    libraryProfile: "linear-maps-v1",
  },
  {
    ...c(
      "LA04",
      "linear_injectivity",
      "Every real linear map from the real line to itself is injective.",
      "∀ f : ℝ →ₗ[ℝ] ℝ, Function.Injective f",
      "by\n  intro h\n  have hi := h (0 : ℝ →ₗ[ℝ] ℝ)\n  have e : (0 : ℝ) = 1 := hi (by simp)\n  exact zero_ne_one e",
      "verified",
      "counterexample",
    ),
    libraryProfile: "linear-maps-v1",
  },
  {
    ...c(
      "LA05",
      "linear_preservation",
      "Every real linear map preserves addition.",
      "∀ (f : (Fin 2 → ℝ) →ₗ[ℝ] ℝ) (x y : Fin 2 → ℝ), f (x + y) = f x + f y",
      "by rfl",
      "not_verified",
    ),
    libraryProfile: "linear-maps-v1",
  },
  {
    ...c(
      "NC01",
      "prime_bounds",
      "Every natural prime is at least two.",
      "∀ p : ℕ, Nat.Prime p → 2 ≤ p",
      "by intro p hp; exact hp.two_le",
    ),
    libraryProfile: "number-combinatorics-v1",
  },
  {
    ...c(
      "NC02",
      "prime_bounds",
      "Every natural number at least two is prime.",
      "∀ n : ℕ, 2 ≤ n → Nat.Prime n",
      "by\n  intro h\n  have hp := h 4 (by decide)\n  exact (by decide : ¬ Nat.Prime 4) hp",
      "verified",
      "counterexample",
    ),
    libraryProfile: "number-combinatorics-v1",
  },
  {
    ...c(
      "NC03",
      "prime_bounds",
      "The natural number two is prime.",
      "Nat.Prime 2",
      "by exact Nat.prime_three",
      "not_verified",
    ),
    libraryProfile: "number-combinatorics-v1",
  },
  {
    ...c(
      "NC04",
      "finite_cardinality",
      "For finite sets of natural numbers, inclusion implies the corresponding inequality of cardinalities.",
      "∀ s t : Finset ℕ, s ⊆ t → s.card ≤ t.card",
      "by intro s t h; exact Finset.card_le_card h",
    ),
    libraryProfile: "number-combinatorics-v1",
  },
  {
    ...c(
      "NC05",
      "finite_cardinality",
      "The cardinality of a union of two finite natural-number sets is at most the sum of their cardinalities.",
      "∀ s t : Finset ℕ, (s ∪ t).card ≤ s.card + t.card",
      "by intro s t; exact Finset.card_union_le s t",
    ),
    libraryProfile: "number-combinatorics-v1",
  },
  {
    ...c(
      "NC06",
      "finite_cardinality",
      "The cardinality of every union of finite natural-number sets equals the sum of their cardinalities.",
      "∀ s t : Finset ℕ, (s ∪ t).card = s.card + t.card",
      "by\n  intro h\n  have e := h {0} {0}\n  simp at e",
      "verified",
      "counterexample",
    ),
    libraryProfile: "number-combinatorics-v1",
  },
];

export const researchCandidates = [
  {
    id: "RP01",
    family: "soft_uniform_spaces_2602_19106v2",
    sourceUrl: "https://arxiv.org/html/2602.19106v2",
    locator: "Definition 26; Lemma 28; Theorem 29",
    expectedBehaviour:
      "先建立软元素、参数分量及其诱导映射的定义义务，不能把研究命题直接替换成实数闭区间命题。",
    goldStatus: "pending_independent_mathematical_review",
    scope: "out_of_current_real_analysis_profile",
    redistribution: "link_and_metadata_only",
  },
];
