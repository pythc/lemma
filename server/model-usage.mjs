// A dedicated numeric allowlist. Do not recursively copy provider usage objects:
// providers may attach credentials or private text even under a known key.
const fields = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "prompt_cache_hit_tokens",
  "prompt_cache_miss_tokens",
  "reasoning_tokens",
  "cached_tokens",
  "thoughts_message_count",
];
const number = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
export function modelUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    ...Object.fromEntries(fields.map((key) => [key, number(raw[key])])),
    prompt_tokens_details: {
      cached_tokens: number(raw.prompt_tokens_details?.cached_tokens),
    },
    completion_tokens_details: {
      reasoning_tokens: number(raw.completion_tokens_details?.reasoning_tokens),
    },
  };
}
export function modelFinishCategory(record) {
  if (record.finishReason === "length") return "generation_limit";
  if (record.error?.code === "model_response_limit")
    return "response_body_limit";
  if (
    record.error?.delivery?.outcome === "not_sent" ||
    record.resource?.executionStarted === false
  )
    return "not_sent";
  if (record.error?.code === "model_timeout") return "timeout";
  if (record.error?.code === "model_cancelled") return "cancelled";
  if (record.error?.code === "model_transport_error")
    return "transport_unknown";
  if (record.error) return record.error.code;
  return record.finishReason || "unknown";
}
