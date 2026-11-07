import { digest } from "./evidence.mjs";

const FACTORS = new Set([
  "prompt",
  "reasoningEffort",
  "sourceAudit",
  "wireProtocol",
]);
export function controlledPlan({
  datasetHash,
  model,
  environmentHash,
  budget,
  implementationHash,
  factor,
  arms,
  repetitions = 2,
}) {
  if (
    ![datasetHash, environmentHash, implementationHash].every((s) =>
      /^[a-f0-9]{64}$/.test(s || ""),
    ) ||
    !model?.name ||
    !model.endpointHost ||
    !Number.isSafeInteger(budget?.maxCallsPerCase) ||
    budget.maxCallsPerCase < 1 ||
    !Number.isSafeInteger(budget?.outputTokens) ||
    budget.outputTokens < 1 ||
    !FACTORS.has(factor) ||
    !Array.isArray(arms) ||
    arms.length !== 2 ||
    !Number.isSafeInteger(repetitions) ||
    repetitions < 1 ||
    repetitions > 5
  )
    throw Error("受控实验配置不完整。");
  if (
    arms[0].id === arms[1].id ||
    arms.some((a) => !a.id || Object.keys(a).sort().join(",") !== "id,value") ||
    arms.some(
      (a) =>
        typeof a.value !== (factor === "sourceAudit" ? "boolean" : "string"),
    ) ||
    digest(arms[0].value) === digest(arms[1].value)
  )
    throw Error("只能声明一个有实际差异的实验因素。");
  const configuration = {
    datasetHash,
    model,
    environmentHash,
    budget,
    implementationHash,
    factor,
    arms,
    repetitions,
    protocol: "lemma.controlled-paired.v1",
    secondFamily: "not_accepted",
  };
  return { ...configuration, planHash: digest(configuration) };
}
export function pairedSchedule(plan, ids) {
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || !ids.length)
    throw Error("案例清单无效。");
  const rows = [];
  for (let repetition = 0; repetition < plan.repetitions; repetition++)
    for (const [i, caseId] of ids.entries()) {
      const arms = (i + repetition) % 2 ? [...plan.arms].reverse() : plan.arms;
      for (const arm of arms)
        rows.push({ caseId, repetition, arm: arm.id, sequence: rows.length });
    }
  return rows;
}
export function summarizeControlled(plan, ids, rows) {
  const { planHash, ...configuration } = plan;
  if (digest(configuration) !== planHash) throw Error("实验计划被改写。");
  const schedule = pairedSchedule(plan, ids),
    allowed = new Map(schedule.map((r) => [digest(r), r]));
  const received = new Map();
  let lastSequence = -1;
  for (const r of rows) {
    const key = digest({
      caseId: r.caseId,
      repetition: r.repetition,
      arm: r.arm,
      sequence: r.sequence,
    });
    if (
      !allowed.has(key) ||
      received.has(key) ||
      r.sequence <= lastSequence ||
      r.planHash !== planHash ||
      !["accepted", "rejected", "unknown", "error", "timeout"].includes(
        r.status,
      ) ||
      !Number.isInteger(r.calls) ||
      r.calls < 0 ||
      r.calls > plan.budget.maxCallsPerCase
    )
      throw Error("配对结果、执行顺序或预算不一致。");
    received.set(key, r);
    lastSequence = r.sequence;
  }
  const complete = schedule.map(
    (r) =>
      received.get(digest(r)) || {
        ...r,
        planHash,
        status: "not_run",
        calls: 0,
        cost: null,
      },
  );
  return {
    schemaVersion: "lemma.controlled-report.v1",
    plan,
    rows: complete,
    groups: plan.arms.map((a) => {
      const selected = complete.filter((r) => r.arm === a.id);
      return {
        arm: a.id,
        denominator: selected.length,
        counts: Object.fromEntries(
          [
            "accepted",
            "rejected",
            "unknown",
            "error",
            "timeout",
            "not_run",
          ].map((s) => [s, selected.filter((r) => r.status === s).length]),
        ),
        calls: selected.reduce((n, r) => n + r.calls, 0),
        resolvedCoverage:
          selected.filter((r) => ["accepted", "rejected"].includes(r.status))
            .length / selected.length,
        cost: selected.every((r) => typeof r.cost === "number")
          ? selected.reduce((n, r) => n + r.cost, 0)
          : null,
      };
    }),
    crossFamilyValidated: false,
    researchAccuracy: null,
    caveat:
      "Paired engineering observations, not an independently labelled accuracy estimate; provider revision may drift.",
  };
}
