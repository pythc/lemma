// Preserve the native result variant. Syntax/environment failures never ran the
// final query, so absent query exit codes are null, not successes or undefined.
export function compactCheck(check) {
  if (!check || typeof check.status !== "string")
    throw Error("Malformed native check result: status missing");
  return {
    status: check.status,
    targetHash: check.targetHash ?? null,
    mode: check.mode ?? null,
    stage:
      check.stage ??
      (check.status === "tool_unavailable"
        ? "environment"
        : check.parser && check.exitCode === undefined
          ? "syntax"
          : "native"),
    exitCode: check.exitCode ?? null,
    axioms: check.axioms || [],
    failureKind: check.failureKind ?? null,
    termination: check.termination ?? null,
    reason: check.reason?.slice(0, 4000) || null,
    environment: check.environment ?? null,
    parser: check.parser
      ? {
          exitCode: check.parser.exitCode ?? null,
          termination: check.parser.termination ?? null,
          stdout: check.parser.stdout?.slice(-12000) || "",
          stderr: check.parser.stderr?.slice(-12000) || "",
          sourceSha256: check.parser.sourceSha256 ?? null,
        }
      : null,
    stdout:
      check.stdout
        ?.split("\n")
        .filter((l) => !l.startsWith("LEMMA_DEPENDENCIES:"))
        .join("\n")
        .slice(-24000) || "",
    stderr: check.stderr?.slice(-10000) || "",
    targetTypeStatus: check.targetTypeStatus ?? null,
    declarationQueryStatus: check.declarationQueryStatus ?? null,
    declarations: check.declarations || [],
    dependencies: check.dependencies
      ? {
          complete: check.dependencies.complete ?? false,
          binderUse: check.dependencies.binderUse ?? null,
          direct: check.dependencies.direct?.slice(0, 120) || [],
        }
      : null,
  };
}
