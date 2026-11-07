import { parseModelFinalObject } from "./model-json.mjs";
import { digest } from "./evidence.mjs";
import {
  strictAudit,
  strictAuditRequest,
  validateStrictEndpoint,
  rawStrictAudit,
  LEGACY_STRICT_AUDIT_BINDING_PROTOCOL,
  PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL,
} from "./strict-audit.mjs";
import {
  nativeBoundAuditProtocol,
  witnessDependencyProtocol,
} from "./audit-wire.mjs";
import {
  boundAudit,
  auditBodyPrompt,
  auditRequestBinding,
  bindAuditResponse,
  verifyAuditEnvelope,
} from "./audit-envelope.mjs";

// Re-request only a completed, received object that failed its schema. Never
// infer missing mathematical text, replay a truncated call, or retry an outage.
export async function structuredReviewCall(
  model,
  config,
  request,
  validate,
  {
    maxAttempts = 2,
    reserve = async () => {},
    onAttempt = async () => {},
  } = {},
) {
  if (![1, 2].includes(maxAttempts))
    throw Error("Structured review permits at most two attempts");
  // Bind the exact JSON payload sent by the transport, including its handling
  // of optional undefined fields. Do this before dispatch, never after success.
  const input = JSON.parse(JSON.stringify(request.input));
  if (
    [
      LEGACY_STRICT_AUDIT_BINDING_PROTOCOL,
      PREVIOUS_STRICT_AUDIT_BINDING_PROTOCOL,
    ].includes(input?.context?.auditBindingProtocol)
  )
    throw Error(
      "Legacy strict v2/v3 dispatch is disabled; archived replay only",
    );
  const strict = strictAudit(input);
  if (strict) {
    // Each stage owns one submission. A failed blind audit leaves comparison
    // unstarted and the review incomplete; it cannot consume its reserved slot.
    maxAttempts = 1;
    validateStrictEndpoint(config);
  }
  const inputHash = digest(input);
  const attempts = [];
  let feedback = null;
  const persist = async (attempt) => {
    try {
      await onAttempt(attempt);
    } catch (error) {
      error.structuredAttempts = attempts;
      error.modelRecord = attempt.model;
      throw error;
    }
  };
  for (let index = 0; index < maxAttempts; index++) {
    let result;
    let binding = null;
    try {
      request.signal?.throwIfAborted();
      await reserve({ index, maxTokens: request.maxTokens });
      let system =
        request.system +
        (index
          ? "\n上一完整响应不符合结构；只修复以下格式错误，不改变原文和目标，也不消除数学疑点：" +
            JSON.stringify(feedback)
          : "");
      if (boundAudit(input)) {
        system =
          auditBodyPrompt(
            request.system,
            !!input.stage,
            input.context.semanticProtocol,
            input.context.auditBindingProtocol,
          ) +
          (index
            ? "\n仅作格式定位的校验数据：" + JSON.stringify(feedback)
            : "");
        binding = auditRequestBinding(input, system);
      }
      result = await model(config, {
        ...request,
        structuredAttempt: index,
        input,
        system,
        ...(strict ? strictAuditRequest(input, system) : {}),
        ...(binding ? { auditRequestBinding: binding } : {}),
      });
    } catch (error) {
      attempts.push({
        index,
        outcome: "call_failed",
        model: error.modelRecord || null,
        error: error.message,
      });
      await persist(attempts.at(-1));
      error.structuredAttempts = attempts;
      throw error;
    }
    let value;
    try {
      if (strict) result = { ...result, parsed: rawStrictAudit(result.record) };
      if (binding) result = bindAuditResponse(result, binding, input);
      value = validate(result.parsed);
    } catch (error) {
      feedback = {
        message: error.message.slice(0, 1000),
        validation: error.auditValidation || null,
      };
      attempts.push({
        index,
        outcome: "schema_rejected",
        model: result.record,
        response: result.parsed,
        error: error.message,
        validation: error.auditValidation || null,
      });
      await persist(attempts.at(-1));
      if (
        index + 1 === maxAttempts ||
        error.auditIdentityFailure ||
        result.record?.finishReason !== "stop" ||
        request.signal?.aborted
      ) {
        error.modelRecord = result.record;
        error.structuredAttempts = attempts;
        throw error;
      }
      continue;
    }
    attempts.push({
      index,
      outcome: "validated",
      model: result.record,
      response: result.parsed,
    });
    // Receipt persistence is not model validation: failure must not dispatch
    // another paid request or relabel an accepted response as invalid schema.
    await persist(attempts.at(-1));
    return { ...result, value, attempts, inputHash };
  }
}

export function recoveryConcerns(attempts = []) {
  const rejected = attempts.filter((a) => a.outcome === "schema_rejected");
  const checks = rejected
    .flatMap((a) =>
      Array.isArray(a.response?.checks) ? a.response.checks : [],
    )
    .filter((c) => c?.status !== "aligned")
    .map((c) => {
      const body = {
        code: "prior_invalid_response_concern",
        category: "definitions",
        detail: `先前完整响应虽未满足结构，但包含未获一致判断的条目：${String(c?.category).slice(0, 80)} / ${String(c?.status).slice(0, 80)}。必须保留，不能由格式重试消除。`,
        sourceEvidenceRequired: true,
      };
      return { ...body, id: digest(body).slice(0, 24) };
    });
  // Invalid structure can coexist with a valid warning. Preserve the entire
  // original response in the receipt, and block acceptance if source warnings
  // disappear during a formatting retry.
  const sourceWarnings = rejected
    .filter(({ response: r, model }) => {
      // v6 can fail before transport-body normalization. Preserve its source
      // warnings just like canonical responses, without accepting the body.
      let input;
      try {
        input = JSON.parse(
          model?.request?.messages?.find((m) => m.role === "user")?.content ||
            "null",
        );
      } catch {
        input = null;
      }
      const flatBlind =
        nativeBoundAuditProtocol(input?.context?.semanticProtocol) &&
        !input.stage;
      const source =
        r?.sourceAudit ||
        (r && flatBlind
          ? { ...r, fidelity: { status: r.fidelityStatus } }
          : null);
      return (
        source &&
        (source.coverage?.status !== "complete" ||
          source.fidelity?.status !== "preserved" ||
          source.missing?.length ||
          !Array.isArray(source.boundaries) ||
          source.boundaries.some(
            (b) => !["matched", "not_applicable"].includes(b?.status),
          ))
      );
    })
    .map((a) => {
      const body = {
        code: "prior_invalid_source_audit_concern",
        category: "definitions",
        responseHash: digest(a.response),
        sourceEvidenceRequired: true,
        detail:
          "先前完整但结构无效的审计包含来源、条件或忠实性疑点；格式修复不能将其消除。",
      };
      return { ...body, id: digest(body).slice(0, 24) };
    });
  // v7 findings are independent evidence. Inconsistent green status fields in
  // an invalid response cannot erase a received fidelity warning on retry.
  // Keep archived v2-v6 recovery semantics unchanged.
  const findingWarnings = rejected.flatMap(({ response, model }) => {
    let input;
    try {
      input = JSON.parse(
        model?.request?.messages?.find((m) => m.role === "user")?.content ||
          "null",
      );
    } catch {
      return [];
    }
    if (
      !witnessDependencyProtocol(input?.context?.semanticProtocol) ||
      !Array.isArray(response?.findings)
    )
      return [];
    const warnings = response.findings.filter(
      (f) => f?.kind !== "source_math_concern",
    );
    if (!warnings.length) return [];
    const body = {
      code: "prior_invalid_fidelity_finding",
      category: "definitions",
      responseHash: digest(response),
      sourceEvidenceRequired: true,
      detail:
        "先前完整但格式无效的响应含忠实性或结构对应疑点；后续绿色状态不能消除该记录。",
    };
    return [{ ...body, id: digest(body).slice(0, 24) }];
  });
  return [...checks, ...sourceWarnings, ...findingWarnings];
}

export function validateStructuredAttempts(
  attempts,
  expectedInput,
  finalResponse,
  finalRecord,
) {
  if (!Array.isArray(attempts) || attempts.length < 1 || attempts.length > 2)
    throw Error("结构修复次数无效。");
  if (strictAudit(expectedInput) && attempts.length !== 1)
    throw Error("Strict audit archives cannot contain format retries");
  for (const [index, a] of attempts.entries()) {
    if (boundAudit(expectedInput)) {
      const binding = a.model?.auditRequestBinding;
      const finalBinding = finalRecord?.auditRequestBinding;
      if (
        !binding ||
        binding.protocol !== expectedInput.context.auditBindingProtocol ||
        binding.requestId !== a.model.requestId ||
        binding.inputHash !== digest(expectedInput) ||
        binding.runId !== finalBinding?.runId ||
        binding.taskId !== finalBinding?.taskId
      )
        throw Error("Audit attempt owner/input/request binding mismatch");
      if (
        !a.model.auditEnvelope &&
        digest(
          strictAudit(expectedInput)
            ? rawStrictAudit(a.model)
            : parseModelFinalObject(a.model.content).parsed,
        ) !== digest(a.response)
      )
        throw Error("Rejected audit raw response was altered");
    }
    if (boundAudit(expectedInput) && a.model?.auditEnvelope)
      verifyAuditEnvelope(a.response, a.model, expectedInput);
    if (
      boundAudit(expectedInput) &&
      a.outcome === "validated" &&
      !a.model?.auditEnvelope
    )
      throw Error("Validated audit is missing its request envelope");
    if (
      a.index !== index ||
      a.outcome !==
        (index === attempts.length - 1 ? "validated" : "schema_rejected")
    )
      throw Error("结构修复历史被改写。");
    if (index < attempts.length - 1 && a.model?.finishReason !== "stop")
      throw Error("未知或截断结果不能自动重试。");
    if (a.model?.request?.messages) {
      const inputs = a.model.request.messages.filter((m) => m.role === "user");
      if (
        inputs.length !== 1 ||
        digest(JSON.parse(inputs[0].content)) !==
          digest(JSON.parse(JSON.stringify(expectedInput)))
      )
        throw Error("结构修复改变了固定输入。");
    }
  }
  if (
    digest(attempts.at(-1).response) !== digest(finalResponse) ||
    digest(attempts.at(-1).model) !== digest(finalRecord)
  )
    throw Error("结构修复最终响应未绑定到传输记录。");
}
