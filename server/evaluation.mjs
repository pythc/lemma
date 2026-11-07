export function validateSplits(cases) {
  const ids = new Set(),
    families = new Map();
  for (const c of cases) {
    if (
      !c.id ||
      ids.has(c.id) ||
      !c.family ||
      !["development", "holdout"].includes(c.split)
    )
      throw new Error("评测样本身份或划分无效。");
    ids.add(c.id);
    if (families.has(c.family) && families.get(c.family) !== c.split)
      throw new Error("同一论文或定理家族跨越开发与保留集。");
    families.set(c.family, c.split);
  }
}

export function summarizeEvaluation(rows, semanticRows, candidates) {
  const split = (name) => {
    const selected = rows.filter((r) => r.split === name);
    return {
      total: selected.length,
      passedReferenceExpectation: selected.filter((r) => r.matchesReference)
        .length,
      provedTargets: selected.filter(
        (r) => r.check.status === "verified" && r.mode === "proof",
      ).length,
      provedNegations: selected.filter(
        (r) => r.check.status === "verified" && r.mode === "counterexample",
      ).length,
      unresolved: selected.filter((r) => r.check.status !== "verified").length,
    };
  };
  const mutations = semanticRows.filter((r) => r.expectedConcern),
    faithful = semanticRows.filter((r) => !r.expectedConcern);
  const domains = [...new Set(rows.map((r) => r.contract.libraryProfile))].map(
    (profile) => {
      const selected = rows.filter(
        (r) => r.contract.libraryProfile === profile,
      );
      return {
        profile,
        total: selected.length,
        expectationsMet: selected.filter((r) => r.matchesReference).length,
        provedTargets: selected.filter(
          (r) => r.check.status === "verified" && r.mode === "proof",
        ).length,
        provedNegations: selected.filter(
          (r) => r.check.status === "verified" && r.mode === "counterexample",
        ).length,
        unresolved: selected.filter((r) => r.check.status !== "verified")
          .length,
      };
    },
  );
  return {
    classification:
      "authored_reference_checks_and_constructed_semantic_mutations_not_research_accuracy",
    total: rows.length,
    development: split("development"),
    holdout: split("holdout"),
    semantics: {
      constructedMutations: mutations.length,
      flaggedMutations: mutations.filter((r) => r.issues.length > 0).length,
      faithfulControls: faithful.length,
      flaggedFaithfulControls: faithful.filter((r) => r.issues.length > 0)
        .length,
      observedModelAccuracy: null,
    },
    research: {
      candidates: candidates.length,
      independentlyLabelled: candidates.filter(
        (c) => c.goldStatus === "independently_reviewed",
      ).length,
      pending: candidates.filter(
        (c) => c.goldStatus !== "independently_reviewed",
      ).length,
      successRate: null,
    },
    modelRecoveryRate: null,
    domains,
    note: "参考证明检查、结构规则和真实模型评测分开。保留集未向模型提供参考证明；当前记录不是未见研究论文泛化结果。未知项保留在总数中。",
  };
}
