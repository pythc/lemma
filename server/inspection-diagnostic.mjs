// Classifies compiler/tool failures only; never infers mathematical truth.
export function nativeInspectionFailure(value) {
  if (!value || (value.exitCode === 0 && !value.termination)) return null;
  const diagnostics = `${value.stdout || ""}\n${value.stderr || ""}`;
  if (
    /memory_exception|excessive memory consumption|out of memory|bad_alloc/i.test(
      diagnostics,
    ) ||
    value.termination === "memory_limit"
  )
    return "native_resource_exhausted";
  if (value.termination) return "native_execution_interrupted";
  if (
    /failed to (?:open|read) file[^\n]*:\s*(?:Interrupted system call|Input\/output error|Resource temporarily unavailable|Too many open files)/i.test(
      diagnostics,
    )
  )
    return "native_execution_interrupted";
  return null;
}
export function inspectionErrorKind(value) {
  if (value?.status === "well_typed") return null;
  if (value?.status === "query_incomplete")
    return "declaration_query_incomplete";
  const interruption =
    value?.failureKind || nativeInspectionFailure(value?.parser || value);
  if (interruption) return interruption;
  const text = value instanceof Error ? value.message : JSON.stringify(value);
  if (/modules 仅接受|补充模块清单无效/.test(text))
    return "invalid_tool_argument";
  if (
    value?.code === "ENOENT" ||
    /unknown module|object file.*does not exist|unknown module prefix|fatal: path .* does not exist in/i.test(
      text,
    )
  )
    return "module_unavailable";
  if (/unknown (identifier|constant)/i.test(text)) return "unknown_symbol";
  if (
    /type mismatch|application type mismatch|failed to synthesize/i.test(text)
  )
    return "type_mismatch";
  return value instanceof Error
    ? "environment_inspection_error"
    : "native_target_rejected";
}
