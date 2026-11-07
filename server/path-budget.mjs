import { budgetSnapshot, closureTimeReserve } from "./review-budget.mjs";
const percentile = (a) =>
  a.sort((x, y) => x - y)[Math.max(0, Math.ceil(a.length * 0.9) - 1)];
export function remainingPathEstimate(
  parent,
  owner = {},
  { phase = "pre_fidelity", other = false } = {},
) {
  // Parent/sibling observations are not capacity evidence for this obligation.
  // Failed and interrupted work remains a cost floor, never a successful sample.
  const samples = [
    ...new Map(
      (owner.nativeTimings || [])
        .filter(
          (s) =>
            s.id &&
            owner.id &&
            s.ownerId === owner.id &&
            owner.contract?.targetHash &&
            s.targetHash === owner.contract.targetHash &&
            Number.isFinite(s.elapsedMs) &&
            s.elapsedMs >= 0,
        )
        .map((s) => [s.id, s]),
    ).values(),
  ];
  const estimate = (name, fallback) => {
    const rows = samples.filter((s) => s.name === name);
    const environment = rows[0]?.attributes?.environmentHash;
    const observed =
      rows.length >= 3 &&
      Boolean(environment) &&
      rows.every(
        (s) =>
          s.status === "returned" &&
          s.attributes?.environmentHash === environment,
      );
    return {
      ms: Math.max(
        observed ? 0 : fallback,
        percentile(rows.map((s) => s.elapsedMs)) ?? fallback,
      ),
      samples: rows.map((s) => s.id),
      confidence: observed ? "observed" : "capacity_unknown",
    };
  };
  const native = {
    preparation: estimate("prover.prepare", 40000),
    bootstrap: estimate("prover.bootstrap", 40000),
    kernel: estimate("native.kernel", 30000),
    archive: estimate("review.archive", 10000),
  };
  // Unknown cold costs remain explicit estimates. They cannot assert feasibility.
  const modelCalls = phase === "pre_fidelity" ? 4 : other ? 1 : 1;
  const modelMs = closureTimeReserve(parent, modelCalls);
  const nativeMs =
    phase === "pre_fidelity" || !other
      ? native.preparation.ms + native.bootstrap.ms + native.kernel.ms
      : native.kernel.ms;
  const requiredMs = modelMs + nativeMs + native.archive.ms;
  const known = Object.values(native).every((v) => v.confidence === "observed");
  const b = budgetSnapshot(parent);
  return {
    schemaVersion: "lemma.remaining-path.v1",
    phase,
    modelCalls,
    modelMs,
    native,
    requiredMs,
    capacity: !known
      ? "capacity_unknown"
      : b.remainingCalls >= modelCalls &&
          (b.remainingMs === null || b.remainingMs >= requiredMs)
        ? "estimated_feasible"
        : "estimated_insufficient",
    feasibleMinimum: known
      ? b.remainingCalls >= modelCalls &&
        b.remainingMs !== null &&
        b.remainingMs >= requiredMs
      : null,
    scope: "observed_p90_and_explicit_cold_estimates_not_SLA",
  };
}
export function preFidelityReserve(parent, owner, protectedCalls) {
  const estimate = remainingPathEstimate(parent, owner);
  // Preserve the existing mandatory semantic calls. Record the complete path,
  // and reserve native work in addition to its existing model-time allowance.
  return {
    protectedMs:
      closureTimeReserve(parent, protectedCalls) +
      (protectedCalls
        ? estimate.native.kernel.ms + estimate.native.archive.ms
        : 0),
    pathEstimate: estimate,
  };
}
