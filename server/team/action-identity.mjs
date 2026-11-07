import { digest } from "../evidence.mjs";
import { validateToolCall } from "./tool-catalog.mjs";
import { resolveArguments } from "./references.mjs";

const deterministic = new Set(["check_lean", "lean_draft", "inspect_target"]);
export function actionIdentity(run, actor, name, args) {
  const { _execution = {}, ...input } = args;
  validateToolCall(name, args);
  if (_execution.mode === "new" && !_execution.reason?.trim())
    throw Error(
      "A new execution needs an explicit reason; querying an old result never reruns it",
    );
  if (_execution.actionId && !/^[a-f0-9-]{36}$/.test(_execution.actionId))
    throw Error("actionId must be a complete UUID");
  const resolved = resolveArguments(run, validateToolCall(name, input), input);
  if (name === "check_lean") resolved.mode ||= "proof";
  if (["lean_draft", "lean_explore"].includes(name)) {
    resolved.profile ||= "std-v1";
    resolved.modules ||= [];
  }
  if (name === "inspect_target") {
    resolved.names ||= [];
    resolved.definitions ||= [];
  }
  const target = resolved.targetId
    ? run.targets.find((t) => t.id === resolved.targetId)
    : null;
  const fingerprint = digest({ name, arguments: resolved });
  return {
    input,
    resolved,
    fingerprint,
    coalesce: deterministic.has(name),
    forceNew: _execution.mode === "new",
    actionId: _execution.actionId || null,
    reason: _execution.reason || null,
    logicalKey: digest({
      runId: run.id,
      actorId: actor.id,
      version: actor.version,
      name,
      arguments: resolved,
      target: target || null,
      protocol: run.protocolVersion,
    }),
  };
}

export const navigationTools = new Set([
  "read_board",
  "read_object",
  "get_operation",
  "list_operations",
  "discover_tools",
  "read_execution_history",
  "read_resume_context",
  "find_operation",
  "read_evidence",
  "read_source",
  "read_page",
]);
