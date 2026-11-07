// Explicit known theorem families. This is not a decision procedure for all
// mathematical equivalences; independent semantic route review is also required.
export function knownRootPolicy(contract) {
  const t = contract.leanTarget;
  const sequenceCompactness =
    /StrictMono/.test(t) && /Tendsto/.test(t) && /ℝ/.test(t) && /∀/.test(t);
  return {
    forbiddenDeclarations: [],
    forbiddenAxioms: [],
    forbiddenFamilies: sequenceCompactness
      ? [
          "tendsto_subseq",
          "IsSeqCompact",
          "BolzanoWeierstrass",
          "bolzano_weierstrass",
        ]
      : [],
  };
}
