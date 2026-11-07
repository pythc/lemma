import { z } from "zod";
import { digest } from "./evidence.mjs";
import { parseUniqueJson } from "./unique-json.mjs";
import { verifyStrictResponseReceipt } from "./strict-response.mjs";
import { verifyStrictResponseReceipt as verifyV3Receipt } from "./strict-response-v1.mjs";
import { RESPONSE_TREE_LIMITS } from "./public-model-view.mjs";
import {
  ANCHORED_AUDIT_PROTOCOL,
  auditTransportSchema,
  normalizeAuditBody,
} from "./audit-wire.mjs";

// A new transport contract; old content-based envelopes retain their meaning.
export const LEGACY_STRICT_AUDIT_BINDING_PROTOCOL =
  "lemma.audit-envelope.tools.v2";
export const PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL =
  "lemma.audit-envelope.tools.v3";
export const STRICT_AUDIT_BINDING_PROTOCOL = "lemma.audit-envelope.tools.v4";
export const AUDIT_SUBMISSION_TOOL = "submit_semantic_audit";
export const strictAudit = (input) =>
  [
    LEGACY_STRICT_AUDIT_BINDING_PROTOCOL,
    PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL,
    STRICT_AUDIT_BINDING_PROTOCOL,
  ].includes(input?.context?.auditBindingProtocol);
export const currentStrictAudit = (input) =>
  input?.context?.auditBindingProtocol === STRICT_AUDIT_BINDING_PROTOCOL;
export const strictAuditProtocol = (value) =>
  [
    LEGACY_STRICT_AUDIT_BINDING_PROTOCOL,
    PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL,
    STRICT_AUDIT_BINDING_PROTOCOL,
  ].includes(value);

export function strictAuditSchema(comparison = false) {
  const base = auditTransportSchema(ANCHORED_AUDIT_PROTOCOL, comparison);
  const finding = base.shape.findings.element;
  return base.extend({
    findings: z
      .array(
        finding.extend({
          // null is not in the documented supplier subset. This explicit list is
          // reversible: [] means no witness; [w] means w. Never infer a witness.
          changeWitness: z.array(finding.shape.changeWitness.unwrap()).max(1),
        }),
      )
      .max(24),
    ...(!comparison ? { probes: base.shape.probes.unwrap() } : {}),
  });
}

// Fail closed on new schema constructs. Only documented wire restrictions are
// projected away; the full Zod schema remains authoritative on receipt/replay.
export function strictSchemaProjection(schema) {
  const allowed = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "anyOf",
    "enum",
    "pattern",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "description",
  ]);
  function visit(node) {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (
        ["$schema", "minLength", "maxLength", "minItems", "maxItems"].includes(
          key,
        )
      )
        continue;
      if (!allowed.has(key))
        throw Error(`Unsupported strict schema keyword: ${key}`);
      if (
        key === "type" &&
        !["object", "array", "string", "number", "integer", "boolean"].includes(
          value,
        )
      )
        throw Error(`Unsupported strict schema type: ${value}`);
      out[key] =
        key === "properties"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, visit(v)]),
            )
          : key === "items"
            ? visit(value)
            : key === "anyOf"
              ? value.map(visit)
              : value;
    }
    if (out.type === "object") {
      const names = Object.keys(out.properties || {});
      if (
        out.additionalProperties !== false ||
        digest([...(out.required || [])].sort()) !== digest([...names].sort())
      )
        throw Error(
          "Strict schema requires every object field and forbids extra fields",
        );
    }
    return out;
  }
  return visit(z.toJSONSchema(schema));
}

export function strictAuditTool(input) {
  if (input?.context?.semanticProtocol !== ANCHORED_AUDIT_PROTOCOL)
    throw Error("Strict submission requires the v8 mathematical protocol");
  if (
    input.stage !== undefined &&
    input.stage !== "comparison_after_immutable_blind_review"
  )
    throw Error("Unknown strict audit stage");
  return {
    type: "function",
    function: {
      name: AUDIT_SUBMISSION_TOOL,
      description: [
        PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL,
        STRICT_AUDIT_BINDING_PROTOCOL,
      ].includes(input?.context?.auditBindingProtocol)
        ? "Submit exactly one stage-specific semantic audit. Comparison sees the frozen blind review; these are not statistically independent experts. changeWitness is [] for none or [witness] for one. No proof certification."
        : "Submit exactly one independent semantic audit. changeWitness is [] for none or [witness] for one. No proof certification.",
      strict: true,
      parameters: strictSchemaProjection(strictAuditSchema(!!input.stage)),
    },
  };
}

export function strictAuditRequest(input, system) {
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(input) },
    ],
    tools: [strictAuditTool(input)],
    toolChoice: "required",
    thinking: { type: "disabled" },
  };
}

export function validateStrictEndpoint(config) {
  const url = new URL(config?.endpoint);
  const local =
    url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  const beta =
    url.protocol === "https:" &&
    url.hostname === "api.deepseek.com" &&
    url.port === "" &&
    url.pathname === "/beta/chat/completions";
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!local && !beta)
  )
    throw Error(
      "Strict audit needs an explicit DeepSeek beta endpoint or a loopback fixture; request not sent",
    );
}

export function rawStrictAudit(record) {
  if (!strictAuditProtocol(record?.auditRequestBinding?.protocol))
    throw Error("Missing explicit strict response protocol");
  const current =
    record?.auditRequestBinding?.protocol === STRICT_AUDIT_BINDING_PROTOCOL;
  if (current) verifyStrictResponseReceipt(record);
  else if (
    record?.auditRequestBinding?.protocol ===
    PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL
  )
    verifyV3Receipt(record);
  const calls = record?.toolCalls;
  if (
    record?.finishReason !== "tool_calls" ||
    !Array.isArray(calls) ||
    calls.length !== 1 ||
    calls[0].type !== "function" ||
    !calls[0].id ||
    calls[0].function?.name !== AUDIT_SUBMISSION_TOOL ||
    (record.content !== null && record.content !== "")
  )
    throw Error(
      "Strict audit requires exactly one tool submission and no text answer",
    );
  // Legacy v2 archives retain their historical interpretation. New v3 uses
  // the same duplicate/shape checks during receipt and replay.
  const raw = current
    ? parseUniqueJson(calls[0].function.arguments, {
        limits: RESPONSE_TREE_LIMITS,
      })
    : record?.auditRequestBinding?.protocol ===
        PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL
      ? parseUniqueJson(calls[0].function.arguments)
      : JSON.parse(calls[0].function.arguments);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("Strict audit arguments must be an object");
  return raw;
}

export function strictRawIdentity(record) {
  return {
    content: record.content,
    toolCalls: record.toolCalls,
    finishReason: record.finishReason,
    ...([
      PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL,
      STRICT_AUDIT_BINDING_PROTOCOL,
    ].includes(record?.auditRequestBinding?.protocol)
      ? { strictResponse: record.strictResponse }
      : {}),
  };
}

export function normalizeStrictAudit(raw, input) {
  const result = strictAuditSchema(!!input.stage).safeParse(raw);
  if (!result.success)
    throw Object.assign(
      Error("Strict audit body violates the full client schema"),
      {
        auditValidation: {
          code: "audit_wire_invalid",
          issues: result.error.issues.map((i) => ({
            path: i.path.join("."),
            code: i.code,
            message: i.message,
          })),
        },
      },
    );
  const body = {
    ...result.data,
    findings: result.data.findings.map((f) => ({
      ...f,
      changeWitness: f.changeWitness[0] ?? null,
    })),
  };
  return normalizeAuditBody(
    body,
    input.context.semanticProtocol,
    !!input.stage,
  );
}
