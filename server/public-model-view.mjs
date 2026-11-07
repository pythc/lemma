import { createHash } from "node:crypto";

export const PUBLIC_MODEL_VIEW_PROTOCOL = "lemma.public-model-view.v1";
export const RESPONSE_TREE_LIMITS = Object.freeze({
  nodes: 100000,
  collection: 10000,
  depth: 256,
});
const hash = (text) => createHash("sha256").update(text).digest("hex");
const normalized = (key) =>
  String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const privateNames = new Set([
  "reasoningcontent",
  "reasoningdetails",
  "reasoningsummary",
  "reasoning",
  "analysis",
  "thoughts",
  "thinking",
  "thinkingcontent",
  "chainofthought",
]);
export const privateProviderField = (key) => privateNames.has(normalized(key));
export const privateProviderBlock = (value) =>
  value &&
  typeof value === "object" &&
  (privateProviderField(value.type) ||
    ["redactedthinking", "encryptedreasoning"].includes(
      normalized(value.type),
    ));
export const sensitiveProviderField = (key) =>
  /authorization|cookie|secret|password|token|apikey|accesskey|credential|privatekey|sessionid/.test(
    normalized(key),
  );
const counters = new Set([
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "prompt_cache_hit_tokens",
  "prompt_cache_miss_tokens",
  "reasoning_tokens",
  "cached_tokens",
  "thoughts_message_count",
  "generation_posts",
  "generation_retries",
  "snapshot_reads",
  "recovered_from_snapshot",
]);
const sensitiveNames = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "secret",
  "password",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "accesskey",
  "credential",
  "credentials",
  "clientsecret",
  "privatekey",
  "sessionid",
]);
export const publicMetadataName = (key) =>
  /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(key) &&
  (counters.has(key) ||
    privateProviderField(key) ||
    sensitiveNames.has(normalized(key)))
    ? key
    : `[field:${hash(key)}]`;
export const publicCounter = (key, value) =>
  counters.has(key) &&
  (typeof value === "boolean" || (Number.isSafeInteger(value) && value >= 0));

export function opaqueProviderValue(value, kind = "metadata") {
  const text = JSON.stringify(value) ?? "undefined";
  return {
    archivedAs: kind,
    sha256: hash(text),
    type:
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
  };
}
export function opaqueProviderToken(text, node, kind = "metadata") {
  return {
    archivedAs: kind,
    sha256: hash(text.slice(node.offset, node.offset + node.length)),
    type: node.type,
  };
}
export const publicMetadataField = (key, value) =>
  publicCounter(key, value)
    ? value
    : opaqueProviderValue(
        value,
        privateProviderField(key)
          ? "private"
          : sensitiveProviderField(key)
            ? "sensitive"
            : "metadata",
      );
export function publicProviderMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return opaqueProviderValue(value);
  const result = {};
  for (const key of Object.keys(value).slice(0, 32)) {
    // Unknown names themselves may be opaque provider data.
    const name = publicMetadataName(key);
    Object.defineProperty(result, name, {
      value: publicMetadataField(key, value[key]),
      enumerable: true,
    });
  }
  if (Object.keys(value).length > 32)
    result.omittedMetadata = opaqueProviderValue(value);
  return result;
}

const put = (object, key, value) =>
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
export function publicMessageView(message) {
  if (!message || typeof message !== "object" || Array.isArray(message))
    return opaqueProviderValue(message);
  const hidden =
    (message.channel !== undefined && message.channel !== "final") ||
    ["analysis", "reasoning"].includes(message.role);
  const result = {};
  for (const [key, value] of Object.entries(message)) {
    if (
      privateProviderField(key) ||
      sensitiveProviderField(key) ||
      (hidden && key === "content")
    )
      put(
        result,
        publicMetadataName(key),
        opaqueProviderValue(
          value,
          privateProviderField(key) || hidden ? "private" : "sensitive",
        ),
      );
    else if (key === "content") put(result, key, publicContentView(value));
    else if (key === "tool_calls") put(result, key, publicToolCalls(value));
    else if (["role", "channel", "tool_call_id"].includes(key))
      put(
        result,
        key,
        typeof value === "string" ? value : opaqueProviderValue(value),
      );
    else put(result, publicMetadataName(key), opaqueProviderValue(value));
  }
  return result;
}
function publicContentView(value) {
  if (Array.isArray(value))
    return value
      .slice(0, RESPONSE_TREE_LIMITS.collection)
      .map(publicContentView);
  if (!value || typeof value !== "object") return value;
  if (privateProviderBlock(value)) return opaqueProviderValue(value, "private");
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 32)
      .map(([k, v]) => [
        ["type", "text"].includes(k) ? k : publicMetadataName(k),
        ["type", "text"].includes(k) && typeof v === "string"
          ? v
          : publicMetadataField(k, v),
      ]),
  );
}
export function publicToolCalls(value) {
  if (!Array.isArray(value)) return opaqueProviderValue(value);
  return value.slice(0, RESPONSE_TREE_LIMITS.collection).map((call) => {
    if (!call || typeof call !== "object") return opaqueProviderValue(call);
    const out = {};
    for (const [key, v] of Object.entries(call).slice(0, 32)) {
      if (["id", "type"].includes(key))
        put(out, key, typeof v === "string" ? v : opaqueProviderValue(v));
      else if (key === "index" && Number.isSafeInteger(v) && v >= 0)
        put(out, key, v);
      else if (key === "function" && v && typeof v === "object")
        put(
          out,
          key,
          Object.fromEntries(
            Object.entries(v)
              .slice(0, 32)
              .map(([k, x]) => [
                ["name", "arguments"].includes(k) ? k : publicMetadataName(k),
                ["name", "arguments"].includes(k) && typeof x === "string"
                  ? x
                  : publicMetadataField(k, x),
              ]),
          ),
        );
      else put(out, publicMetadataName(key), publicMetadataField(key, v));
    }
    return out;
  });
}
export function publicProviderError(value, redact, depth = 0) {
  if (depth > 5 || !value || typeof value !== "object" || Array.isArray(value))
    return opaqueProviderValue(value);
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 32)
      .map(([k, v]) => {
        if (["error", "detail"].includes(k) && v && typeof v === "object")
          return [k, publicProviderError(v, redact, depth + 1)];
        if (
          ["code", "error", "type"].includes(k) &&
          typeof v === "string" &&
          /^[a-zA-Z0-9_.:-]{1,100}$/.test(v)
        )
          return [k, redact(v)];
        if (k === "retryable" && typeof v === "boolean") return [k, v];
        return [publicMetadataName(k), publicMetadataField(k, v)];
      }),
  );
}
export const publicRequestView = (request) =>
  JSON.parse(
    JSON.stringify({
      ...request,
      messages: request.messages?.map(publicMessageView),
    }),
  );

// The raw message is never an enumerable/string property of a result. A token
// survives transport/result spreads, but JSON/canonical/structured exports only
// see safe public fields. The WeakMap owns the in-memory provider context.
const PRIVATE_TOKEN = Symbol("lemma.sdk.private-message-token");
const messages = new WeakMap();
export function withPublicModelMessage(result, rawMessage) {
  const token = Object.freeze({});
  messages.set(token, rawMessage);
  return {
    ...result,
    message: publicMessageView(rawMessage),
    [PRIVATE_TOKEN]: token,
  };
}
export function privateModelMessage(result) {
  const raw = messages.get(result?.[PRIVATE_TOKEN]);
  if (raw) return raw;
  const contentSummarized = (value) =>
    Array.isArray(value)
      ? value.some(contentSummarized)
      : value &&
        typeof value === "object" &&
        ["private", "metadata", "sensitive"].includes(value.archivedAs) &&
        /^[a-f0-9]{64}$/.test(value.sha256);
  if (
    result?.message &&
    (contentSummarized(result.message.content) ||
      Object.entries(result.message).some(
        ([k, v]) => privateProviderField(k) && v?.archivedAs === "private",
      ))
  )
    throw Error(
      "Private provider context is unavailable in this process; request not sent",
    );
  return result?.message;
}
export function publicModelResult(result) {
  // Explicit public archive API also drops opaque SDK tokens. Safe .message is
  // authoritative; mathematical parsed payloads and receipts are unchanged.
  const { parsed, record, message } = result;
  return {
    ...(parsed === undefined ? {} : { parsed }),
    record,
    ...(message === undefined ? {} : { message }),
  };
}
