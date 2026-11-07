import { createHash } from "node:crypto";
import { digest } from "./evidence.mjs";
import {
  jsonSyntaxTree,
  parseUniqueJson,
  assertJsonTreeBounds,
} from "./unique-json.mjs";
import {
  privateProviderField,
  privateProviderBlock,
  sensitiveProviderField,
  publicCounter,
  publicMetadataName,
  opaqueProviderToken,
  PUBLIC_MODEL_VIEW_PROTOCOL,
  RESPONSE_TREE_LIMITS,
} from "./public-model-view.mjs";
import { validateStrictResponseShape as oldShape } from "./strict-response-v1.mjs";
import { verifyStrictResponseReceipt as verifyV2Receipt } from "./strict-response-v2.mjs";
export const STRICT_RESPONSE_PROTOCOL = "lemma.model-public-response.v3";
const hash = (t) => createHash("sha256").update(t).digest("hex");
const metadataRoots = new Set([
  "usage",
  "continuation",
  "recovery",
  "lifecycle",
  "gateway_budget",
]);
function metadataNode(text, node) {
  if (node.type !== "object") return opaqueProviderToken(text, node);
  const out = {};
  for (const p of (node.children || []).slice(0, 32)) {
    const [k, v] = p.children,
      key = k.value;
    const name = publicMetadataName(key);
    Object.defineProperty(out, name, {
      value: publicCounter(key, v.value)
        ? v.value
        : opaqueProviderToken(
            text,
            v,
            privateProviderField(key)
              ? "private"
              : sensitiveProviderField(key)
                ? "sensitive"
                : "metadata",
          ),
      enumerable: true,
    });
  }
  if (node.children.length > 32)
    out.omittedMetadata = opaqueProviderToken(text, node);
  return out;
}
function childScope(scope, key) {
  if (scope === "envelope")
    return key === "choices"
      ? "choices"
      : [
            "id",
            "object",
            "created",
            "model",
            "system_fingerprint",
            "thinking_effort",
          ].includes(key)
        ? "scalar"
        : null;
  if (scope === "choice")
    return key === "message"
      ? "message"
      : ["index", "finish_reason"].includes(key)
        ? "scalar"
        : null;
  if (scope === "message")
    return key === "tool_calls"
      ? "tools"
      : key === "content"
        ? "content"
        : ["role", "channel"].includes(key)
          ? "scalar"
          : null;
  if (scope === "tool")
    return key === "function"
      ? "function"
      : key === "index"
        ? "toolIndex"
        : ["id", "type"].includes(key)
          ? "scalar"
          : null;
  if (scope === "function")
    return ["name", "arguments"].includes(key) ? "scalar" : null;
  if (scope === "content")
    return ["type", "text"].includes(key) ? "scalar" : null;
  return null;
}
export function captureStrictResponse(text, credential) {
  const receipt = {
    protocol: STRICT_RESPONSE_PROTOCOL,
    publicViewProtocol: PUBLIC_MODEL_VIEW_PROTOCOL,
    originalBodySha256: hash(text),
    retentionScope: "digest_only_invalid_json",
    privateFields: [],
    metadataFields: [],
  };
  let tree;
  try {
    tree = jsonSyntaxTree(text, { limits: RESPONSE_TREE_LIMITS });
  } catch (error) {
    if (error.code === "model_response_structure_limit") throw error;
    return receipt;
  }
  assertJsonTreeBounds(tree, RESPONSE_TREE_LIMITS);
  const pending = [{ node: tree, scope: "envelope" }],
    edits = [];
  let credentialEcho = false;
  const replace = (node, value, kind) => {
    const info = {
      offset: node.offset,
      length: node.length,
      sha256: hash(text.slice(node.offset, node.offset + node.length)),
      kind,
    };
    (kind === "private" ? receipt.privateFields : receipt.metadataFields).push(
      info,
    );
    edits.push({
      offset: node.offset,
      length: node.length,
      replacement: JSON.stringify(value),
    });
  };
  while (pending.length) {
    const { node, scope } = pending.pop();
    // Only the accepted protocol value is public. Malformed index metadata can
    // contain unrelated sensitive strings even on a rejected response.
    if (scope === "toolIndex" && (node.type !== "number" || node.value !== 0)) {
      replace(node, opaqueProviderToken(text, node), "metadata");
      continue;
    }
    if (
      node.type === "string" &&
      credential &&
      node.value.includes(credential)
    ) {
      credentialEcho = true;
      replace(node, "[REDACTED]", "sensitive");
      continue;
    }
    if (node.type === "object") {
      if (scope === "content") {
        const type = node.children?.find((p) => p.children[0].value === "type")
          ?.children[1]?.value;
        if (privateProviderBlock({ type })) {
          replace(node, opaqueProviderToken(text, node, "private"), "private");
          continue;
        }
      }
      const hidden = (node.children || []).some(
        (p) =>
          (p.children[0].value === "channel" &&
            p.children[1]?.value !== "final") ||
          (p.children[0].value === "role" &&
            ["analysis", "reasoning"].includes(p.children[1]?.value)),
      );
      for (const p of node.children || []) {
        const [k, v] = p.children,
          key = k.value;
        if (credential && key.includes(credential)) {
          credentialEcho = true;
          replace(k, `[field:${hash(key)}]`, "sensitive");
        } else if (
          (privateProviderField(key) || sensitiveProviderField(key)) &&
          publicMetadataName(key) !== key
        ) {
          replace(k, publicMetadataName(key), "metadata");
        }
        if (privateProviderField(key) || (hidden && key === "content"))
          replace(v, opaqueProviderToken(text, v, "private"), "private");
        else if (sensitiveProviderField(key))
          replace(v, opaqueProviderToken(text, v, "sensitive"), "sensitive");
        else if (scope === "envelope" && metadataRoots.has(key))
          replace(v, metadataNode(text, v), "metadata");
        else {
          const next = childScope(scope, key);
          if (next) pending.push({ node: v, scope: next });
          else {
            if (publicMetadataName(key) !== key)
              replace(k, publicMetadataName(key), "metadata");
            replace(v, opaqueProviderToken(text, v), "metadata");
          }
        }
      }
    } else if (node.type === "array") {
      const next =
        scope === "choices"
          ? "choice"
          : scope === "tools"
            ? "tool"
            : scope === "content"
              ? "content"
              : null;
      if (!next) replace(node, opaqueProviderToken(text, node), "metadata");
      else
        for (const c of node.children || [])
          pending.push({ node: c, scope: next });
    }
  }
  let publicJson = "",
    cursor = 0;
  for (const e of edits.sort(
    (a, b) => a.offset - b.offset || b.length - a.length,
  )) {
    if (e.offset < cursor) continue;
    publicJson += text.slice(cursor, e.offset) + e.replacement;
    cursor = e.offset + e.length;
  }
  publicJson += text.slice(cursor);
  return {
    ...receipt,
    retentionScope: "public_wire_metadata_projected",
    publicJson,
    credentialEcho,
  };
}
export function validateStrictResponseShape(response) {
  // Validate the entire envelope, retaining the optional provider index in both
  // the public receipt and returned tool call. Only this documented extension
  // is projected for the frozen base validator; unknown fields still fail.
  let base = response;
  const call = response?.choices?.[0]?.message?.tool_calls?.[0];
  if (call && Object.hasOwn(call, "index")) {
    if (!Number.isInteger(call.index) || call.index !== 0)
      throw Error("Strict tool index must be integer zero");
    const { index, ...withoutIndex } = call;
    base = {
      ...response,
      choices: response.choices.map((choice, i) =>
        i === 0
          ? {
              ...choice,
              message: {
                ...choice.message,
                tool_calls: choice.message.tool_calls.map((tool, j) =>
                  j === 0 ? withoutIndex : tool,
                ),
              },
            }
          : choice,
      ),
    };
  }
  oldShape(base);
  if (
    response.usage !== undefined &&
    response.usage !== null &&
    (typeof response.usage !== "object" || Array.isArray(response.usage))
  )
    throw Error("Strict usage metadata must be an object");
  return response.choices[0];
}
export function verifyStrictResponseReceipt(record) {
  const r = record?.strictResponse;
  if (r?.protocol === "lemma.model-public-response.v2")
    return verifyV2Receipt(record);
  if (
    record?.error ||
    !r ||
    r.protocol !== STRICT_RESPONSE_PROTOCOL ||
    r.publicViewProtocol !== PUBLIC_MODEL_VIEW_PROTOCOL ||
    r.retentionScope !== "public_wire_metadata_projected" ||
    r.credentialEcho ||
    r.originalBodySha256 !== record.http?.bodySha256
  )
    throw Error("Missing or invalid complete strict response receipt");
  const choice = validateStrictResponseShape(
    parseUniqueJson(r.publicJson, { limits: RESPONSE_TREE_LIMITS }),
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
