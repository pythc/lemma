import {
  privateModelMessage,
  publicMessageView,
} from "./public-model-view.mjs";
import { randomUUID } from "node:crypto";
import { ContextOverflowError } from "@langchain/core/errors";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { callModel } from "./model.mjs";

export function wireMessages(messages, privateContexts) {
  return messages.map((m) => {
    const privateContext = privateContexts?.get(m.id);
    if (
      (m.response_metadata?.private_context_memory_only && !privateContext) ||
      m.additional_kwargs?.reasoning_content
    )
      throw Object.assign(
        Error(
          "Private provider context is unavailable in this process; request not sent",
        ),
        { code: "provider_private_context_unavailable" },
      );
    const type = m._getType();
    const role = {
      human: "user",
      ai: "assistant",
      system: "system",
      tool: "tool",
    }[type];
    if (!role) throw Error(`Unsupported harness message: ${type}`);
    const sourceContent =
      privateContext && Object.hasOwn(privateContext, "content")
        ? privateContext.content
        : m.content;
    const content =
      typeof sourceContent === "string" || Array.isArray(sourceContent)
        ? sourceContent
        : JSON.stringify(sourceContent);
    return {
      role,
      content,
      ...(role === "tool" ? { tool_call_id: m.tool_call_id } : {}),
      ...(role === "assistant" && m.tool_calls?.length
        ? {
            tool_calls: m.tool_calls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
        : {}),
      ...(role === "assistant" && privateContext?.reasoning_content
        ? { reasoning_content: privateContext.reasoning_content }
        : {}),
    };
  });
}

/** Uses the application's transport, resource pool and receipts; no SDK retries. */
export class HarnessChatModel extends BaseChatModel {
  #privateContexts = new Map();
  constructor({
    config,
    invoke = callModel,
    onRecord = async () => {},
    reserve = async () => {},
    signal,
    maxTokens,
    role = "HARNESS_TOOL_MODEL",
    maxContextCharacters = null,
    onContextOverflow = async () => {},
    thinking,
    fixedMessages = async () => [],
  }) {
    super({ maxRetries: 0, callbacks: [] });
    Object.assign(this, {
      config,
      invokeModel: invoke,
      onRecord,
      reserve,
      runSignal: signal,
      maxTokens,
      requestRole: role,
      maxContextCharacters,
      onContextOverflow,
      thinking,
      fixedMessages,
    });
    this.pendingGenerations = new Set();
    this.failedModelRecords = [];
    this.closing = false;
  }
  _llmType() {
    return "lemma-openai-tools";
  }
  bindTools(tools, options = {}) {
    return this.withConfig({
      ...options,
      tools: tools.map((t) => convertToOpenAITool(t)),
    });
  }
  async _generate(messages, options = {}) {
    if (this.closing)
      throw Error("Model worker already closed; no request dispatched");
    const pending = this.generateRecorded(messages, options).catch((error) => {
      if (error.modelRecord) this.failedModelRecords.push(error.modelRecord);
      throw error;
    });
    this.pendingGenerations.add(pending);
    try {
      return await pending;
    } finally {
      this.pendingGenerations.delete(pending);
    }
  }
  async closeAndDrain() {
    this.closing = true;
    while (this.pendingGenerations.size)
      await Promise.allSettled([...this.pendingGenerations]);
    this.#privateContexts.clear();
  }
  async generateRecorded(messages, options = {}) {
    // Add mandatory inputs AFTER SDK summarization/offload, at the last adapter
    // boundary. They never enter compressible working history.
    const fixed = await this.fixedMessages();
    if (
      this.maxContextCharacters &&
      JSON.stringify(fixed).length > this.maxContextCharacters
    )
      throw Object.assign(
        Error(
          "Mandatory translation source/preparation exceeds the request capacity; no request sent",
        ),
        {
          code: "translation_source_capacity_exceeded",
        },
      );
    const wire = [...wireMessages(messages, this.#privateContexts), ...fixed];
    const characters = JSON.stringify(wire).length;
    if (this.maxContextCharacters && characters > this.maxContextCharacters) {
      await this.onContextOverflow(characters);
      const error = new ContextOverflowError(
        "Local harness working context needs compaction before transport",
      );
      error.localContextCompaction = true;
      throw error;
    }
    await this.reserve(wire);
    try {
      const r = await this.invokeModel(this.config, {
        role: this.requestRole,
        messages: wire,
        tools: options.tools,
        toolChoice: options.tool_choice,
        thinking: options.thinking ?? this.thinking,
        logicalStage: options.logicalStage,
        phaseDecision: options.phaseDecision,
        signal:
          options.signal && this.runSignal
            ? AbortSignal.any([options.signal, this.runSignal])
            : options.signal || this.runSignal,
        maxTokens: this.maxTokens || 16000,
      });
      await this.onRecord(r.record);
      const m = privateModelMessage(r);
      const visible = publicMessageView(m);
      const privateContent =
        JSON.stringify(m.content) !== JSON.stringify(visible.content);
      const message = new AIMessage({
        content: visible.content || "",
        tool_calls: (visible.tool_calls || []).map((c) => ({
          name: c.function.name,
          args: JSON.parse(c.function.arguments),
          id: c.id,
          type: "tool_call",
        })),
        id: randomUUID(),
        additional_kwargs: {},
        response_metadata: {
          finish_reason: r.record.finishReason,
          model_name: r.record.responseModel,
          ...(m.reasoning_content || privateContent
            ? { private_context_memory_only: true }
            : {}),
        },
      });
      if (m.reasoning_content || privateContent)
        this.#privateContexts.set(message.id, {
          ...(m.reasoning_content
            ? { reasoning_content: m.reasoning_content }
            : {}),
          ...(privateContent ? { content: m.content } : {}),
        });
      return {
        generations: [
          {
            message,
            text: typeof visible.content === "string" ? visible.content : "",
          },
        ],
        llmOutput: { tokenUsage: r.record.usage },
      };
    } catch (e) {
      if (e.modelRecord) await this.onRecord(e.modelRecord);
      throw e;
    }
  }
}
