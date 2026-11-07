import { PROOF_RUNTIME } from "./runtime-limits.mjs";
import { digest } from "./evidence.mjs";

export const REPAIR_BUDGET = PROOF_RUNTIME;
export function diagnose(check) {
  const message = [
    check?.parser?.stdout,
    check?.parser?.stderr,
    check?.stdout,
    check?.stderr,
    check?.reason,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 16000);
  let category = "proof_gap",
    repairable = true;
  if (check?.status === "verified") {
    category = "verified";
    repairable = false;
  } else if (
    check?.status === "cancelled" ||
    check?.termination === "cancelled"
  ) {
    category = "cancelled";
    repairable = false;
  } else if (
    check?.status === "tool_unavailable" ||
    check?.failureKind === "driver_failed"
  ) {
    category = "environment";
    repairable = false;
  } else if (
    check?.termination ||
    check?.parser?.termination ||
    ["budget_exhausted", "execution_failed"].includes(check?.failureKind)
  ) {
    category = "resource_limit";
    repairable = false;
  } else if (check?.failureKind === "syntax_rejected") category = "syntax";
  else if (
    /Unknown (constant|identifier)|unknown (constant|identifier)|environment does not contain/.test(
      message,
    )
  )
    category = "unknown_declaration";
  else if (
    /type mismatch|Type mismatch|application.*mismatch|failed to synthesize/i.test(
      message,
    )
  )
    category = "type_or_conditions";
  else if (/unsolved goals/i.test(message)) category = "unsolved_goals";
  return {
    category,
    repairable,
    message,
    fingerprint: digest({ category, message }),
  };
}
export function proofDiff(before = "", after = "") {
  const a = before.split("\n"),
    b = after.split("\n");
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return {
    startLine: start + 1,
    removed: a.slice(start, a.length - end).join("\n"),
    added: b.slice(start, b.length - end).join("\n"),
  };
}
