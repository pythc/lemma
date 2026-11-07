import { digest } from "./evidence.mjs";

const knownScopeFailure = (error) =>
  /(?:选区|片段|selectedQuote).*(?:完整|缺少|截断|不足)|(?:缺少|截断).*(?:命题|结论)/s.test(
    error || "",
  );
export function recoveryState(child, claim) {
  const last = [...(child.tasks || [])]
    .reverse()
    .find((t) => ["blocked", "failed"].includes(t.status));
  const native =
    child.check ||
    child.nativeTargetCheck ||
    child.semanticReview?.targetCheck ||
    child.targetType ||
    null;
  const body = {
    paperSha256: child.paperSha256 || child.contract?.paperSha256 || null,
    source: claim.formalScope?.spans
      ? digest({
          paperSha256: child.paperSha256 || child.contract?.paperSha256 || null,
          spans: claim.formalScope.spans.map((s) => ({
            pageIndex: s.pageIndex ?? null,
            quote: s.quote || "",
            start: s.start ?? null,
            sourceTextHash: s.sourceTextHash || null,
          })),
        })
      : claim.formalScope?.scopeHash || digest(claim.anchor || {}),
    target: child.contract
      ? digest({
          leanTarget: child.contract.leanTarget || null,
          assumptions: child.contract.assumptions || [],
          allowedAxioms: child.contract.allowedAxioms || [],
        })
      : null,
    environment: {
      profile: child.libraryProfile || claim.libraryProfile || null,
      imports: child.contract?.imports || [],
      libraryRevision: child.contract?.libraryRevision || null,
      executionEnvironment: child.contract?.executionEnvironment || null,
      externalLibraries: child.contract?.externalLibraries || [],
      definitions: child.contract?.domainContext
        ? {
            definitions: (child.contract.domainContext.definitions || []).map(
              (d) => ({
                name: d.name || null,
                type: d.type || null,
                value: d.value || null,
                dependsOn: d.dependsOn || [],
              }),
            ),
            lemmas: (child.contract.domainContext.lemmas || []).map((d) => ({
              name: d.name || null,
              target: d.target || null,
              proof: d.proof || null,
              dependsOn: d.dependsOn || [],
            })),
          }
        : null,
    },
    stage: knownScopeFailure(child.error)
      ? "incomplete_source_scope"
      : last?.role || child.domainRecovery?.stage || "unresolved",
    diagnostic: native
      ? {
          status: native.status || null,
          failureKind: native.failureKind || null,
          stdout: native.stdout || "",
          stderr: native.stderr || "",
        }
      : null,
    unknownExternalOutcome: Boolean(
      child.domainRecovery?.externalOutcomeUnknown ||
      child.provingSearch?.stopReason === "external_outcome_unknown",
    ),
  };
  return { ...body, fingerprint: digest(body) };
}

export function reserveRecovery(run, child, claim, kind) {
  const state = recoveryState(child, claim);
  run.recoveryAttempts ||= [];
  if (state.unknownExternalOutcome) throw Error("外部结果未知，未自动重发。");
  if (
    run.recoveryAttempts.some(
      (x) =>
        x.claimId === claim.id &&
        x.fingerprint === state.fingerprint &&
        x.kind === kind,
    )
  ) {
    claim.formalizationStalled = {
      fingerprint: state.fingerprint,
      targetHash: child.contract?.targetHash || null,
      sourceScope: claim.formalScope?.scopeHash || null,
      reason: "相同原文、目标、环境和失败状态未改变，停止重复恢复。",
    };
    throw Object.assign(Error(claim.formalizationStalled.reason), {
      recoveryStop: "unchanged_failure_state",
    });
  }
  run.recoveryAttempts.push({
    claimId: claim.id,
    fingerprint: state.fingerprint,
    kind,
    childRunId: child.id,
    state,
    createdAt: new Date().toISOString(),
  });
  return state;
}
