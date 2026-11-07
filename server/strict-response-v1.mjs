import { digest } from "./evidence.mjs";
import { parseUniqueJson } from "./unique-json.mjs";

export const STRICT_RESPONSE_PROTOCOL = "lemma.model-public-response.v1";
const privateKey = (key) =>
  [
    "reasoning_content",
    "reasoning_details",
    "reasoning_summary",
    "reasoning",
    "analysis",
    "thoughts",
    "thinking",
    "chain_of_thought",
  ].includes(key);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Historical v3 receipt verification only. No legacy capture or dispatch.
function keys(value, allowed, label, allowPrivate = false) {
  if (
    !object(value) ||
    Object.keys(value).some(
      (k) => !allowed.includes(k) && !(allowPrivate && privateKey(k)),
    )
  )
    throw Error(`Invalid strict response ${label} shape`);
}

export function validateStrictResponseShape(response) {
  keys(
    response,
    [
      "id",
      "object",
      "created",
      "model",
      "choices",
      "usage",
      "system_fingerprint",
      "thinking_effort",
      "continuation",
      "recovery",
      "lifecycle",
      "gateway_budget",
    ],
    "envelope",
    true,
  );
  if (!Array.isArray(response.choices) || response.choices.length !== 1)
    throw Error("Strict response requires exactly one candidate");
  const choice = response.choices[0];
  keys(choice, ["index", "message", "finish_reason", "logprobs"], "candidate");
  if (Object.hasOwn(choice, "index") && choice.index !== 0)
    throw Error("Strict candidate index must be zero");
  const message = choice.message;
  keys(message, ["role", "content", "tool_calls", "channel"], "message", true);
  if (
    message.role !== "assistant" ||
    (Object.hasOwn(message, "channel") && message.channel !== "final")
  )
    throw Error("Strict response requires a final assistant message");
  if (
    !Object.hasOwn(message, "content") ||
    (message.content !== null && message.content !== "")
  )
    throw Error(
      "Strict response requires explicit null or empty-string content",
    );
  if (
    choice.finish_reason !== "tool_calls" ||
    !Array.isArray(message.tool_calls) ||
    message.tool_calls.length !== 1
  )
    throw Error(
      "Strict response requires exactly one complete tool submission",
    );
  const call = message.tool_calls[0];
  keys(call, ["id", "type", "function"], "tool");
  keys(call.function, ["name", "arguments"], "function");
  if (
    typeof call.id !== "string" ||
    !call.id ||
    call.type !== "function" ||
    typeof call.function.name !== "string" ||
    typeof call.function.arguments !== "string"
  )
    throw Error("Invalid strict tool submission");
  return choice;
}

export function verifyStrictResponseReceipt(record) {
  const receipt = record?.strictResponse;
  if (
    !receipt ||
    receipt.protocol !== STRICT_RESPONSE_PROTOCOL ||
    receipt.retentionScope !== "public_wire_private_values_hashed" ||
    receipt.credentialEcho ||
    receipt.originalBodySha256 !== record.http?.bodySha256
  )
    throw Error("Missing or invalid complete strict response receipt");
  const choice = validateStrictResponseShape(
    parseUniqueJson(receipt.publicJson),
  );
  if (
    choice.message.content !== record.content ||
    choice.finish_reason !== record.finishReason ||
    digest(choice.message.tool_calls) !== digest(record.toolCalls)
  )
    throw Error(
      "Strict response receipt was altered or normalized with information loss",
    );
  return choice;
}
