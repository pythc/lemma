import { randomUUID } from "node:crypto";
import { z } from "zod";
import { digest } from "./evidence.mjs";
import { parseModelFinalObject } from "./model-json.mjs";
import {
  auditTransportSchema,
  normalizeAuditBody,
  nativeBoundAuditProtocol,
} from "./audit-wire.mjs";
import { executionContext } from "./execution-context.mjs";
import {
  STRICT_AUDIT_BINDING_PROTOCOL,
  PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL,
  strictAuditProtocol,
  currentStrictAudit,
  strictAudit,
  strictAuditSchema,
  strictAuditTool,
  rawStrictAudit,
  strictRawIdentity,
  normalizeStrictAudit,
} from "./strict-audit.mjs";

export const AUDIT_BINDING_PROTOCOL = "lemma.audit-envelope.v1";
export const boundAudit = (input) =>
  input?.context?.auditBindingProtocol === AUDIT_BINDING_PROTOCOL ||
  strictAudit(input);
export function auditBodyPrompt(system, comparison, protocol, bindingProtocol) {
  const strict = strictAuditProtocol(bindingProtocol);
  const schema = strict
    ? strictAuditSchema(comparison)
    : auditTransportSchema(protocol, comparison);
  let instructions = system.split("\nJSON Schema:")[0];
  if (strict)
    instructions = instructions
      .replaceAll("只输出 Schema 的 JSON", "仅用指定工具提交符合 Schema 的参数")
      .replace(/changeWitness=\{([^{}\n]*)\}/g, "changeWitness=[{$1}]")
      .replaceAll("changeWitness=null", "changeWitness=[]")
      .replaceAll("changeWitness 仍为 null", "changeWitness 为 []");
  return (
    instructions +
    "\n本次正文协议由可信调用层绑定来源与目标身份。不要输出 targetHash，也不要复制其他长摘要；仍逐项核对固定输入中的目标与原文。\nJSON Schema: " +
    JSON.stringify(z.toJSONSchema(schema)) +
    (strict
      ? "\n只调用一次 submit_semantic_audit 提交正文，不另写文本。changeWitness 必须为 []（无见证）或 [一个见证]；盲审 probes 必须显式提供。仅一次提交，无自动格式修复。"
      : "")
  );
}
export function auditRequestBinding(input, system) {
  const owner = executionContext.getStore();
  return {
    protocol: input.context.auditBindingProtocol,
    requestId: randomUUID(),
    runId: owner?.run?.id || null,
    taskId: owner?.task?.id || null,
    targetHash: input.contract.targetHash,
    inputHash: digest(input),
    systemHash: digest(system),
    systemLength: system.length,
  };
}
export function bindAuditResponse(result, binding, input) {
  const record = result.record;
  if (
    record?.requestId !== binding.requestId ||
    digest(record.auditRequestBinding) !== digest(binding)
  )
    throw Object.assign(
      Error("Audit response belongs to a different request"),
      { auditIdentityFailure: true },
    );
  const strict = strictAudit(input);
  const raw = strict
    ? rawStrictAudit(record)
    : parseModelFinalObject(record.content).parsed;
  if (digest(raw) !== digest(result.parsed))
    throw Object.assign(Error("Audit raw/parsed response mismatch"), {
      auditIdentityFailure: true,
    });
  if (Object.hasOwn(raw, "targetHash"))
    throw Error("Bound audit body must not contain or rewrite targetHash");
  const envelope = {
    ...binding,
    requestHash: digest(record.request),
    rawResponseHash: digest(
      strict ? strictRawIdentity(record) : record.content,
    ),
    bodyHash: digest(raw),
    authority: "transport_binding_not_model_attestation",
    ...(nativeBoundAuditProtocol(input.context.semanticProtocol)
      ? {
          bodyNormalization: strict
            ? currentStrictAudit(input)
              ? "lemma.audit-body.tool.v4"
              : input.context.auditBindingProtocol ===
                  PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL
                ? "lemma.audit-body.tool.v3"
                : "lemma.audit-body.tool.v2"
            : "lemma.audit-body.flat.v1",
        }
      : {}),
    ...(strict
      ? { submissionPolicy: "one_call_per_stage_no_format_retry" }
      : {}),
  };
  const normalized = {
    ...(strict
      ? normalizeStrictAudit(raw, input)
      : normalizeAuditBody(raw, input.context.semanticProtocol, !!input.stage)),
    targetHash: binding.targetHash,
  };
  const boundRecord = { ...record, auditEnvelope: envelope };
  verifyAuditEnvelope(normalized, boundRecord, input);
  return { ...result, parsed: normalized, record: boundRecord };
}
export function verifyAuditEnvelope(response, record, input, expectedOwner) {
  if (!boundAudit(input)) return;
  const envelope = record?.auditEnvelope;
  const binding = record?.auditRequestBinding;
  const messages = record?.request?.messages || [];
  const users = messages.filter((m) => m.role === "user");
  const systems = messages.filter((m) => m.role === "system");
  const strict = strictAudit(input);
  const body = strict
    ? rawStrictAudit(record)
    : parseModelFinalObject(record?.content || "").parsed;
  const { targetHash, ...normalizedBody } = response;
  if (
    !envelope ||
    !binding ||
    envelope.protocol !== input.context.auditBindingProtocol ||
    binding.protocol !== input.context.auditBindingProtocol ||
    record.requestId !== binding.requestId ||
    envelope.requestId !== binding.requestId ||
    (expectedOwner &&
      (envelope.runId !== expectedOwner.runId ||
        envelope.taskId !== expectedOwner.taskId)) ||
    envelope.targetHash !== input.contract.targetHash ||
    targetHash !== input.contract.targetHash ||
    binding.targetHash !== targetHash ||
    envelope.inputHash !== digest(input) ||
    binding.inputHash !== digest(input) ||
    envelope.systemHash !== binding.systemHash ||
    envelope.runId !== binding.runId ||
    envelope.taskId !== binding.taskId ||
    users.length !== 1 ||
    digest(JSON.parse(users[0].content)) !== digest(input) ||
    systems.length !== 1 ||
    envelope.systemLength !== binding.systemLength ||
    digest(systems[0].content.slice(0, binding.systemLength)) !==
      binding.systemHash ||
    envelope.requestHash !== digest(record.request) ||
    envelope.rawResponseHash !==
      digest(strict ? strictRawIdentity(record) : record.content) ||
    Object.hasOwn(body, "targetHash") ||
    envelope.bodyHash !== digest(body) ||
    (nativeBoundAuditProtocol(input.context.semanticProtocol) &&
      envelope.bodyNormalization !==
        (strict
          ? currentStrictAudit(input)
            ? "lemma.audit-body.tool.v4"
            : input.context.auditBindingProtocol ===
                PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL
              ? "lemma.audit-body.tool.v3"
              : "lemma.audit-body.tool.v2"
          : "lemma.audit-body.flat.v1")) ||
    (strict &&
      (envelope.submissionPolicy !== "one_call_per_stage_no_format_retry" ||
        digest(record.request.tools) !== digest([strictAuditTool(input)]) ||
        record.request.tool_choice !== "required" ||
        record.request.thinking?.type !== "disabled" ||
        Object.hasOwn(record.request, "response_format"))) ||
    digest(normalizedBody) !==
      digest(
        strict
          ? normalizeStrictAudit(body, input)
          : normalizeAuditBody(
              body,
              input.context.semanticProtocol,
              !!input.stage,
            ),
      )
  )
    throw Object.assign(
      Error("Audit envelope/source/target/raw response binding mismatch"),
      { auditIdentityFailure: true },
    );
}
