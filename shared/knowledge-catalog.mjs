// Explanatory metadata is authored guidance. Every returned declaration is
// looked up in the pinned Lean environment before it reaches a proof agent.
const entry = (name, file, keywords, conditions) => ({
  name,
  file: `Mathlib/${file}.lean`,
  keywords,
  conditions,
});
export const ANALYSIS_KNOWLEDGE = [
  {
    ...entry(
      "Continuous",
      "Topology/Defs/Basic",
      "定义 连续 Continuous",
      "全域拓扑连续的定义；注意与 ContinuousOn 的定义域区别。",
    ),
    kind: "definition",
  },
  {
    ...entry(
      "ContinuousOn",
      "Topology/Defs/Filter",
      "定义 连续 子集 ContinuousOn",
      "逐点在集合内连续；必须保留同一个集合。",
    ),
    kind: "definition",
  },
  {
    ...entry(
      "UniformContinuous",
      "Topology/UniformSpace/Defs",
      "定义 一致连续 UniformContinuous",
      "一致连续的邻域条件统一作用于所有输入对。",
    ),
    kind: "definition",
  },
  {
    ...entry(
      "UniformContinuousOn",
      "Topology/UniformSpace/Defs",
      "定义 集合 一致连续 UniformContinuousOn",
      "一致连续条件只对指定集合内的输入对要求成立。",
    ),
    kind: "definition",
  },
  entry(
    "IsCompact.uniformContinuousOn_of_continuous",
    "Topology/UniformSpace/HeineCantor",
    "一致连续 紧致 闭区间 UniformContinuousOn ContinuousOn Icc Heine Cantor",
    "集合紧致，且函数在同一集合上连续；不能从任意域上的连续性直接得到一致连续性。",
  ),
  entry(
    "CompactSpace.uniformContinuous_of_continuous",
    "Topology/UniformSpace/HeineCantor",
    "一致连续 紧致 子类型 UniformContinuous Continuous CompactSpace",
    "定义域具有 CompactSpace 实例，并且函数连续。",
  ),
  entry(
    "isCompact_Icc",
    "Topology/Order/Compact",
    "闭区间 紧致 Icc IsCompact",
    "有序空间具有 CompactIccSpace；空区间也允许。",
  ),
  entry(
    "Continuous.comp",
    "Topology/Continuous",
    "复合 连续 Continuous comp composition",
    "内外两函数都连续；注意复合的方向。",
  ),
  entry(
    "ContinuousOn.comp",
    "Topology/ContinuousOn",
    "复合 连续 ContinuousOn comp MapsTo",
    "两段分别连续，而且内函数将源集合映入外函数的连续域。",
  ),
  entry(
    "continuous_id",
    "Topology/Continuous",
    "恒等 连续 Continuous identity",
    "同一拓扑空间上的恒等映射。",
  ),
  entry(
    "continuous_const",
    "Topology/Continuous",
    "常数 连续 Continuous constant",
    "常值函数在其定义域上连续。",
  ),
  entry(
    "Continuous.continuousOn",
    "Topology/ContinuousOn",
    "限制 子集 连续 ContinuousOn Continuous",
    "全域连续可限制到任意子集，反方向不自动成立。",
  ),
  entry(
    "ContinuousOn.mono",
    "Topology/ContinuousOn",
    "限制 子集 连续 ContinuousOn subset mono",
    "新定义域必须是原定义域的子集。",
  ),
  entry(
    "UniformContinuous.continuous",
    "Topology/UniformSpace/Basic",
    "一致连续 连续 UniformContinuous Continuous",
    "一致连续蕴含连续，不能直接反向应用。",
  ),
  entry(
    "UniformContinuousOn.mono",
    "Topology/UniformSpace/Basic",
    "一致连续 子集 UniformContinuousOn subset",
    "限制到原定义域的子集。",
  ),
  entry(
    "uniformContinuousOn_iff_restrict",
    "Topology/UniformSpace/Basic",
    "一致连续 子类型 UniformContinuousOn restrict",
    "把集合上的性质转换为受限函数的全域性质。",
  ),
  entry(
    "IsCompact.image",
    "Topology/Compactness/Compact",
    "紧致 像 IsCompact image Continuous",
    "紧致集合经连续映射的像紧致。",
  ),
  entry(
    "IsCompact.image_of_continuousOn",
    "Topology/Compactness/Compact",
    "紧致 像 IsCompact image ContinuousOn",
    "只需在该紧致集合上连续。",
  ),
  entry(
    "isCompact_empty",
    "Topology/Compactness/Compact",
    "空集 紧致 IsCompact empty",
    "空集是紧致集，不要求非空。",
  ),
  entry(
    "isCompact_iff_compactSpace",
    "Topology/Compactness/Compact",
    "紧致 子类型 IsCompact CompactSpace",
    "集合紧致与该集合子类型作为紧致空间相对应。",
  ),
  entry(
    "IsCompact.isClosed",
    "Topology/Separation/Hausdorff",
    "紧致 闭集 IsCompact IsClosed Hausdorff",
    "需要 Hausdorff/T2 分离条件，不能在任意拓扑空间中省略。",
  ),
  entry(
    "Continuous.mul",
    "Topology/Algebra/Monoid/Defs",
    "乘积 连续 Continuous mul product",
    "乘法运算连续，且两个因子函数连续。",
  ),
  entry(
    "Continuous.pow",
    "Topology/Algebra/Monoid",
    "幂 连续 Continuous pow square",
    "自然数次幂，函数连续并具有相应连续乘法结构。",
  ),
  entry(
    "Continuous.prodMk",
    "Topology/Constructions/SumProd",
    "乘积空间 连续 Continuous prodMk pair",
    "两个分量函数连续。",
  ),
];
export const LINEAR_KNOWLEDGE = [
  entry(
    "LinearMap.map_add",
    "Algebra/Module/LinearMap/Defs",
    "线性 加法 LinearMap add",
    "映射已具有线性映射结构，两个输入属于同一向量空间。",
  ),
  entry(
    "LinearMap.map_smul",
    "Algebra/Module/LinearMap/Defs",
    "线性 数乘 LinearMap smul",
    "底层标量环相同；半线性映射需要额外的标量环映射。",
  ),
  entry(
    "LinearMap.map_zero",
    "Algebra/Module/LinearMap/Defs",
    "线性 零 LinearMap zero",
    "线性映射保持零向量，仿射映射不自动满足此条件。",
  ),
  entry(
    "LinearMap.comp_apply",
    "Algebra/Module/LinearMap/Defs",
    "线性 复合 LinearMap comp",
    "映射的中间空间匹配，且注意外层与内层次序。",
  ),
  entry(
    "LinearMap.id_apply",
    "Algebra/Module/LinearMap/Defs",
    "线性 恒等 LinearMap id",
    "指定标量环和向量空间的恒等线性映射。",
  ),
];
export const NUMBER_KNOWLEDGE = [
  entry(
    "Nat.Prime.two_le",
    "Data/Nat/Prime/Defs",
    "素数 Nat Prime prime two",
    "素数在自然数中至少为二；零和一不是素数。",
  ),
  entry(
    "Nat.prime_two",
    "Data/Nat/Prime/Defs",
    "素数 Nat Prime two",
    "自然数二为素数。",
  ),
  entry(
    "Nat.not_prime_one",
    "Data/Nat/Prime/Defs",
    "素数 Nat Prime one",
    "自然数一不是素数。",
  ),
  entry(
    "Nat.Prime.dvd_mul",
    "Data/Nat/Prime/Basic",
    "素数 整除 Nat Prime dvd mul",
    "对素数成立的积整除析取；不能直接改成任意自然数。",
  ),
  entry(
    "Finset.card_le_card",
    "Data/Finset/Card",
    "有限集合 计数 Finset card subset",
    "有子集包含关系时，基数具有单调性。",
  ),
  entry(
    "Finset.card_union_le",
    "Data/Finset/Card",
    "并集 计数 Finset card union",
    "并集基数至多为两者基数之和；等号需要额外的不交条件。",
  ),
  entry(
    "Finset.card_insert_of_notMem",
    "Data/Finset/Card",
    "插入 计数 Finset card insert",
    "插入元素不在原集合中时，基数才增加一。",
  ),
];
export const DOMAIN_KNOWLEDGE = {
  "analysis-continuity-v1": ANALYSIS_KNOWLEDGE,
  "linear-maps-v1": LINEAR_KNOWLEDGE,
  "number-combinatorics-v1": NUMBER_KNOWLEDGE,
};
