import { SEMANTIC_THRESHOLDS } from "./evaluation-registration.mjs";
import { digest } from "./evidence.mjs";
const expectationStatus = {
  accept: "accepted",
  reject: "rejected",
  unknown: "unknown",
};
const replayKeys = [
  "integrity",
  "reproduced",
  "revalidated",
  "sameEnvironment",
];
export function assessMathReadiness(e) {
  const reasons = [];
  const pass = (name, value, reason) => {
    if (!value) reasons.push({ item: name, reason });
    return !!value;
  };
  const hash = e.implementation;
  const current = !!hash && e.currentImplementation === hash;
  const native = e.native;
  const engineering = !!(
    e.engineering?.passed &&
    e.engineering.implementationUnchanged &&
    e.engineering.evaluationImplementation?.sha256 === hash
  );
  const dev = e.development;
  const development = !!(
    dev?.passed &&
    dev.implementationUnchanged &&
    e.developmentVersion === hash &&
    dev.rows?.length === 6 &&
    new Set(dev.rows.map((r) => r.id)).size === 6 &&
    ["D1", "D2", "D3", "D4", "H8", "H9"].every((id) =>
      dev.rows.some((r) => r.id === id),
    ) &&
    dev.rows.every(
      (r) =>
        r.passed &&
        r.firstSubmissionStructured &&
        r.native === "well_typed" &&
        r.adjudication?.admission === "allowed" &&
        Number.isInteger(r.calls) &&
        r.calls > 0 &&
        r.calls <= 4,
    )
  );
  const boundary = e.boundary;
  const boundaries = !!(
    boundary?.developmentAccepted &&
    boundary.implementationUnchanged &&
    boundary.registrationUnchanged &&
    boundary.plan?.implementation?.sha256 === hash &&
    boundary.rows?.length === 6 &&
    new Set(boundary.rows.map((r) => r.caseId)).size === 6 &&
    boundary.rows.every(
      (r) =>
        r.complete &&
        r.firstPassComplete &&
        r.status === expectationStatus[r.reference?.expectation],
    )
  );
  const f = e.formal;
  const rows = f?.rows || [];
  const counts = {
    complete: rows.filter((r) => r.complete).length,
    firstPassComplete: rows.filter((r) => r.firstPassComplete).length,
    faithfulAccepted: rows.filter(
      (r) => r.reference?.expectation === "accept" && r.status === "accepted",
    ).length,
    falseAccepted: rows.filter(
      (r) => r.reference?.expectation === "reject" && r.status === "accepted",
    ).length,
    ambiguityFalselyCleared: rows.filter(
      (r) => r.reference?.expectation === "unknown" && r.status === "accepted",
    ).length,
    unknownCorrect: rows.filter(
      (r) => r.reference?.expectation === "unknown" && r.status === "unknown",
    ).length,
  };
  const formal = !!(
    f?.accepted &&
    f.implementationUnchanged &&
    f.registrationUnchanged &&
    f.plan?.implementation?.sha256 === hash &&
    !!f.plan.thresholds &&
    digest(f.plan.thresholds) === digest(SEMANTIC_THRESHOLDS) &&
    rows.length === 60 &&
    new Set(rows.map((r) => `${r.repeat}:${r.caseId}`)).size === 60 &&
    new Set(rows.map((r) => r.caseId)).size === 20 &&
    rows.every((r) => [0, 1, 2].includes(r.repeat)) &&
    [...new Set(rows.map((r) => r.caseId))].every(
      (id) => rows.filter((r) => r.caseId === id).length === 3,
    ) &&
    rows.filter((r) => r.reference?.expectation === "accept").length === 30 &&
    rows.filter((r) => r.reference?.expectation === "reject").length === 18 &&
    rows.filter((r) => r.reference?.expectation === "unknown").length === 12 &&
    counts.complete >= 57 &&
    counts.firstPassComplete >= 57 &&
    counts.faithfulAccepted >= 27 &&
    counts.falseAccepted === 0 &&
    counts.ambiguityFalselyCleared === 0 &&
    counts.unknownCorrect >= 11
  );
  const nativePassed = !!(
    native?.passed &&
    native.implementation === hash &&
    native.implementationUnchanged &&
    ["indexed-admission", "runtime-boundaries", "author-route"].every((n) =>
      native.steps?.some(
        (s) =>
          s.name === n && s.exitCode === 0 && s.tests > 0 && s.failures === 0,
      ),
    )
  );
  const cleanReplay = replayKeys.every(
    (k) => e.engineering?.cleanReplay?.[k] === true,
  );
  const ledger = e.ledger;
  const validBudget = !!(
    ledger?.maxCalls === 200 &&
    ledger.priorBatchCredit === 0 &&
    ledger.entries?.length <= 200 &&
    ledger.entries.every(
      (r) =>
        ["received", "failed_charged"].includes(r.state) &&
        r.delivery !== "unknown" &&
        r.delivery?.outcome !== "unknown",
    ) &&
    !!ledger.caps &&
    digest(ledger.caps) ===
      digest({
        translationDev: 24,
        translationRework: 24,
        semanticDev: 24,
        semanticBase: 120,
        semanticRepair: 8,
      }) &&
    Object.entries(ledger.caps || {}).every(
      ([key, cap]) =>
        Number.isSafeInteger(cap) &&
        cap >= 0 &&
        ledger.entries.filter((r) => r.cohort === key).length <= cap,
    ) &&
    ledger.entries.every((r) => Object.hasOwn(ledger.caps, r.cohort))
  );
  const preserved = !!(
    e.preservation?.unchanged &&
    e.preservation.globalBudgetUnchanged &&
    e.preservation.csUnchanged &&
    e.preservation.priorLedgersUnchanged
  );
  const launch = !!(
    e.startPlan?.prepared &&
    e.startPlan.inputHashVerified &&
    e.startPlan.originalPdfStarted === false &&
    e.startPlan.callsPerRun === 12 &&
    e.startPlan.minutesPerRun === 4 &&
    e.startPlan.repetitions === 2 &&
    e.startPlan.emptyStorePerRun &&
    e.startPlan.requiresReadinessNotice &&
    e.startPlan.noTargetsOrProofsSupplied
  );
  const items = {
    translation: pass(
      "translation",
      current && development && nativePassed,
      "Need same-version six-case development and actual indexed native/HTTP checks",
    ),
    semantics: pass(
      "semantics",
      current && boundaries && formal,
      "Need same-version six boundaries and unchanged six formal thresholds",
    ),
    runtime: pass(
      "runtime",
      current && engineering && nativePassed && validBudget,
      "Need actual controlled runtime checks and settled bounded ledger",
    ),
    proofEvidence: pass(
      "proofEvidence",
      current && engineering && nativePassed && cleanReplay,
      "Need exact kernel/author-route controls and all four independent replay checks",
    ),
    launchConditions: pass(
      "launchConditions",
      current && preserved && launch,
      "Need immutable implementation, preserved source/evidence and unstarted raw-PDF plan",
    ),
  };
  return {
    schemaVersion: "lemma.math-readiness.v1",
    implementation: hash,
    ready: Object.values(items).every(Boolean),
    items,
    reasons,
    formalMetrics: counts,
    calls: ledger?.entries?.length ?? null,
    scope: "mathematics_preparation_only_not_raw_pdf_or_paper_quality",
    originalPdfStarted: false,
    secondFamily: "not_accepted",
    independentExpertLabels: false,
  };
}
