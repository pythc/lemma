export const MATHLIB_COMMIT = "56a005855ea17e0b0958f73ec801ae140b0a1679";
export const MATHLIB_MANIFEST_SHA256 =
  "6fcb8417bf0d6056cebf3c9f9bacd4569f21f3b9c571c60649150b9118b55147";
export const ALLOWED_AXIOMS = Object.freeze([
  "propext",
  "Classical.choice",
  "Quot.sound",
]);
export const LIBRARY_PROFILES = Object.freeze([
  Object.freeze({
    id: "std-v1",
    label: "基础数学 · Std",
    revision: "lean-4.35.0-std",
    imports: Object.freeze(["Std"]),
    scope: "基础类型与逻辑；领域支持另行验证。",
  }),
  Object.freeze({
    id: "analysis-continuity-v1",
    label: "实分析 · 连续性与紧致性",
    revision: MATHLIB_COMMIT,
    imports: Object.freeze([
      "Mathlib.Topology.UniformSpace.HeineCantor",
      "Mathlib.Topology.Instances.Real.Lemmas",
      "Mathlib.Tactic.Linarith",
    ]),
    scope: "实数上的连续性、紧致性和一致连续性；不包含整个实分析领域。",
  }),
  Object.freeze({
    id: "linear-maps-v1",
    label: "线性代数 · 线性映射",
    revision: MATHLIB_COMMIT,
    imports: Object.freeze([
      "Mathlib.Algebra.Module.LinearMap.Basic",
      "Mathlib.Topology.Instances.Real.Lemmas",
    ]),
    scope:
      "实向量空间上的线性映射、加法、数乘与复合；谱理论、秩和有限维分类尚未验收。",
  }),
  Object.freeze({
    id: "number-combinatorics-v1",
    label: "数论与组合 · 素数与有限计数",
    revision: MATHLIB_COMMIT,
    imports: Object.freeze([
      "Mathlib.Data.Nat.Prime.Basic",
      "Mathlib.Data.Finset.Card",
    ]),
    scope:
      "自然数素性、整除和有限集合计数的基础命题；不代表数论与组合研究领域整体支持。",
  }),
]);
export function libraryProfile(id = "std-v1") {
  const profile = LIBRARY_PROFILES.find((p) => p.id === id);
  if (!profile) throw new Error("不支持此数学库配置，不能自动更换目标依赖。");
  return profile;
}
export const profileForContract = (contract) =>
  libraryProfile(
    contract.schemaVersion === "lemma.contract.v1"
      ? "std-v1"
      : contract.libraryProfile,
  );
