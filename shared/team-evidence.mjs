// Show the accepted certificate itself. Later diagnostic or summary replays do
// not revoke that receipt, and must not inherit its acceptance status either.
export function selectTeamCertificate(run, targetId) {
  const checks = (run.machineChecks || []).filter(
    (check) => check.targetId === targetId && !check.superseded,
  );
  return (
    checks.findLast(
      (check) => check.status === "verified" && check.independentlyAccepted,
    ) || checks.at(-1)
  );
}
