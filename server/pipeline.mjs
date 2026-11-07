import { validateEpistemicFindings } from "./epistemic-audit.mjs";
import {
  adjudicatedAuditProtocol,
  EPISTEMIC_AUDIT_PROTOCOL,
  WITNESSED_AUDIT_PROTOCOL,
  NATIVE_BOUND_AUDIT_PROTOCOL,
  WITNESS_AUDIT_PROTOCOL,
  ANCHORED_AUDIT_PROTOCOL,
  ANCHORED_AUDIT_PROMPT,
  ANCHORED_COMPARISON_PROMPT,
  WITNESS_AUDIT_PROMPT,
  WITNESS_COMPARISON_PROMPT,
  NATIVE_BOUND_AUDIT_PROMPT,
  NATIVE_BOUND_COMPARISON_PROMPT,
  WITNESSED_AUDIT_PROMPT,
  WITNESSED_COMPARISON_PROMPT,
  epistemicAuditProtocol,
  EPISTEMIC_AUDIT_PROMPT,
  EPISTEMIC_COMPARISON_PROMPT,
} from "./audit-wire.mjs";
import {
  translationSchema,
  schemaInstruction,
  ALIGNMENT_REPAIR_PROMPT,
  validateTranslationWire,
  TRANSLATION_PROTOCOL,
} from "./translation-wire.mjs";
import { inspectSourceProofAbsence } from "./source-proof-absence.mjs";
import { obligationAllowance } from "./obligation-budget.mjs";
import {
  ADJUDICATED_AUDIT_PROTOCOL,
  ADJUDICATED_AUDIT_PROMPT,
  nativeAuditProtocol,
} from "./audit-wire.mjs";
import {
  COMPLETION_VERSION,
  reviewCompletion,
  terminationCause,
} from "../shared/review-completion.mjs";
import { NATIVE_COMPARISON_PROMPT } from "./audit-wire.mjs";
import {
  ANCHOR_PROTOCOL,
  COMPACT_AUDIT_PROMPT,
  sourceAnchorIndex,
  indexedAnchorProtocol,
} from "./source-anchor-index.mjs";
import { checkSemanticProbe } from "./semantic-probes.mjs";
import {
  SOURCE_AUDIT_PROTOCOL,
  sourceAuditProtocol,
  validateSourceAudit,
} from "./source-audit.mjs";
import {
  NATIVE_AUDIT_PROTOCOL,
  INDEXED_ANCHOR_V2,
  NATIVE_AUDIT_PROMPT,
  validateAuditWire,
} from "./audit-wire.mjs";
import {
  NETWORK_RUNTIME,
  PROOF_RUNTIME,
  PROOF_CEILINGS,
  MODEL_RUNTIME,
} from "./runtime-limits.mjs";
import { inspectDomainEvidence } from "./domain-evidence.mjs";
import { recoverDomain } from "./domain-recovery.mjs";
import { bindTranslationModules } from "./translation-modules.mjs";
import { bindScopeEvidence } from "./source-scope.mjs";
import { randomUUID } from "node:crypto";
import { executionContext } from "./execution-context.mjs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  createContract,
  deriveConclusion,
  normalize,
  text,
  validateLeanText,
  validateContract,
  validateProposal,
  MAX_PROOF_CHARACTERS,
} from "./contracts.mjs";
import { callModel, modelOutputTokens } from "./model.mjs";
import { structuredReviewCall } from "./structured-review.mjs";
import {
  BLIND_PROMPT,
  COMPARISON_PROMPT,
  blindSemanticInput,
  semanticModelIdentity,
  mergeSemanticReviews,
} from "./semantic-blind.mjs";
import { checkProof } from "./lean.mjs";
import { kernelAccepted } from "./proof-decomposition.mjs";
import { freshProofSession } from "./proof-autonomy.mjs";
import {
  digest,
  isHash,
  receivedModelRoots,
  evidenceClosure,
} from "./evidence.mjs";
import { inspectReviewEvidence } from "./review-evidence.mjs";
import {
  buildContext,
  supplementsFor,
  anchorInContext,
  resolveContextAnchor,
} from "./context.mjs";
import {
  validateAlignment,
  semanticReview,
  validateResolutions,
} from "./semantics.mjs";
import { inspectTarget } from "./lean-query.mjs";
import { retrieveKnowledge, retrieveCases } from "./knowledge.mjs";
import { REPAIR_BUDGET, diagnose, proofDiff } from "./repair.mjs";
import {
  libraryProfile,
  profileForContract,
} from "../shared/library-profiles.mjs";

export function extractInWorker(base64, pageIndex, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./pdf-worker.mjs", import.meta.url), {
      workerData: { base64, pageIndex },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const budget =
      pageIndex === null
        ? NETWORK_RUNTIME.fullExtractionMs
        : NETWORK_RUNTIME.pageExtractionMs;
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `论文解析超过 ${budget / 1000} 秒预算，未得出任何数学结论。`,
          ),
        ),
      budget,
    );
    const abort = () => finish(new Error("任务已取消。"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.on("message", (msg) => {
      // Node --watch relays dependency notifications on this channel too.
      if (msg?.type !== "lemma.pdf.result.v1") return;
      msg.ok === true
        ? finish(null, msg.value)
        : finish(
            new Error(msg?.error?.trim() || "PDF 解析器没有返回具体错误信息。"),
          );
    });
    worker.once("error", (error) =>
      finish(
        new Error(
          error?.message?.trim() || "PDF 解析进程启动失败，未能读取原文。",
          {
            cause: error,
          },
        ),
      ),
    );
    worker.once("exit", (code) => {
      if (!settled) finish(new Error(`解析进程提前结束（${code}）。`));
    });
  });
}

const extractionPrompt =
  `你负责 R03 命题语义。只从 selectedPage 指定页选择一条明确命题，使用 context 中跨页定义、约定及补充材料，不修正原命题。alignment 必须覆盖 variables、quantifiers、domain、assumptions、conclusion、definitions 六类；确实不适用可用 {category,notApplicable:true,explanation}。补充材料锚点用 supplementId 代替 pageIndex。可依赖所选库配置，以及本次 inspect_modules 实际准备且经原生核对的固定 Mathlib 模块；若需要这些额外导入，在返回对象中加入 moduleReceiptIds:["工具返回的 preparationArtifact"]，系统会校验回执归属、绑定正式环境并重新检查目标题型。读取源码或检索命中不等于导入完成；不能虚构回执。论文自定义数学对象交给领域补全，新定义不得借模块导入偷渡。Lean 标准类型使用 Nat、Int 等内核名称；仅导入 Std 时不能假定数学排版别名 ℕ、ℤ 已有解析支持，除非本次原生检查确证相同导入支持该别名。定义缺失需报告歧义，不要杜撰定义、增添假设或弱化结论。没有可忠实表达的命题时返回 {"unavailable":"具体原因"}。请输出紧凑 JSON，各项 explanation 不超过四十个汉字，anchors 优先使用固定原文索引；需要引句时必须足以唯一定位，不能为缩短输出省略必要上下文。` +
  schemaInstruction(translationSchema);
// Derived navigation is regenerated from the fixed context. It never resolves
// ambiguity by picking an occurrence or changes the stored source/contract.
const translationContext = (context) => ({
  ...context,
  translationProtocol: TRANSLATION_PROTOCOL,
  anchorIndex: indexedAnchorProtocol(context.anchorProtocol)
    ? sourceAnchorIndex(context)
    : [],
});
const auditPrompt = `你负责 R06 原证明审计。核对固定命题、原证明步骤和假设，不修改目标。输出 {"status":"gap_candidate 或 unchecked 或 source_proof_missing","quote":"存在疑点的原文片段，无则空串","pageIndex":0,"explanation":"具体前提/推理问题或无法核查原因"}。引句来自 context 中指定 pageIndex 页，页码从零开始。如果当前完整来源中只陈述命题而没有作者证明，可标 source_proof_missing，quote 必须引用所选命题，不能用遗漏的上下文冒充缺证明。模型分析不能宣称机器验证或定理为假。`;
const proofPrompt = `你负责 R09 证明构造，或 R08 反例构造。对固定目标给出 Lean 4 证明项，不改变目标或假设。只可使用合同声明的导入，不自行添加 import；仅返回 {"mode":"proof 或 counterexample","proof":"by ...","route":"original、completion 或 independent","explanation":"路线和限制"}。counterexample 模式要求证明原目标的否定。禁止 sorry/admit、新公理、unsafe、元编程及原生计算绕过；无法完成则返回 {"unavailable":"原因"}。目标之外定义或库缺失需明确报告。`;
const usesModelProof = (run) => (run.proofStrategy || run.mode) === "model";
const scopedPrompt = (prompt, profile, expandable = false) =>
  `${prompt}\n库配置 ${profile.id}；版本 ${profile.revision}；${expandable ? "初始模块" : "固定合同导入"}：${profile.imports.join(", ")}。范围：${profile.scope}${expandable ? "。这不是全库能力上限；可以经 inspect_modules 的 preparationArtifact 准备额外固定模块，并用 moduleReceiptIds 绑定正式环境。" : ""}`;

export class ReviewPipeline {
  constructor({
    store,
    getConfig,
    getSemanticConfig,
    documentExtractor = null,
    model = callModel,
    checker = checkProof,
    targetChecker = inspectTarget,
    knowledge = retrieveKnowledge,
    repairBudget = REPAIR_BUDGET,
    concurrent = false,
    prover = null,
    provingBudget = {},
    reserveProverModel = async () => {},
    originalProofEngine = null,
  }) {
    Object.assign(this, {
      store,
      getConfig,
      getSemanticConfig: getSemanticConfig || getConfig,
      documentExtractor,
      model,
      checker,
      targetChecker,
      knowledge,
      repairBudget,
      concurrent,
      prover,
      provingBudget,
      reserveProverModel,
      originalProofEngine,
    });
    this.active = new Map();
    this.completions = new Map();
    this.reserved = false;
  }
  async reserve(action) {
    if (this.concurrent) {
      // Serialize only admission and same-run state changes, not model/Lean work.
      const previous = this.admissions || Promise.resolve();
      const next = previous.catch(() => {}).then(action);
      this.admissions = next;
      return next;
    }
    if (this.active.size || this.reserved)
      throw new Error("本机已有任务在执行，请等待或取消后再开始。");
    this.reserved = true;
    try {
      return await action();
    } finally {
      this.reserved = false;
    }
  }
  launch(run, promise) {
    const controller = this.active.get(run.id);
    const job = promise
      .catch(async () => {
        run.status = "blocked";
        run.error = "执行或证据保存失败，没有生成新的通过结论。";
        if (run.contract) run.conclusion = deriveConclusion(run);
        try {
          await this.store.saveRun(run);
        } catch {
          /* Keep the last durable state for restart recovery. */
        }
      })
      .finally(() => {
        if (this.active.get(run.id) === controller) this.active.delete(run.id);
        if (this.completions.get(run.id) === job)
          this.completions.delete(run.id);
      });
    this.completions.set(run.id, job);
  }
  async init() {
    await this.store.init();
    for (const name of await readdir(path.join(this.store.root, "runs"))) {
      if (!name.endsWith(".json")) continue;
      const run = await this.store.getRun(name.slice(0, -5));
      if (
        !["langgraph-v1", "original-proof-v1", "team-v1"].includes(
          run.engine,
        ) &&
        ["preparing", "running"].includes(run.status)
      ) {
        run.status = "interrupted";
        run.error =
          "上次执行因服务停止而中断，未生成新的通过结论。请重新发起并保留旧记录。";
        run.tasks
          .filter((t) => t.status === "running")
          .forEach((t) => {
            t.status = "interrupted";
          });
        await this.store.saveRun(run);
      }
    }
  }
  taskReceipt(value) {
    const item =
      value && typeof value === "object" ? this.taskReceipts?.get(value) : null;
    if (!item) throw Error("Task result has no execution-owned receipt");
    return item;
  }
  async task(run, role, title, type, inputs, action) {
    const item = {
      id: randomUUID(),
      role,
      title,
      type,
      inputs,
      output: null,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    run.tasks.push(item);
    await this.store.saveRun(run);
    try {
      if (this.active.get(run.id)?.signal.aborted)
        throw new Error("任务已取消。");
      const value = await executionContext.run(
        {
          run,
          task: item,
          onModelQueued: async () => {
            item.resource = "model";
            item.status = "queued";
            item.queuedAt = new Date().toISOString();
            await this.store.saveRun(run);
          },
          onModelStarted: async () => {
            item.status = "running";
            item.modelStartedAt = new Date().toISOString();
            await this.store.saveRun(run);
          },
          onToolQueued: async (resource) => {
            item.resource = resource;
            item.status = "queued";
            item.queuedAt = new Date().toISOString();
            await this.store.saveRun(run);
          },
          onToolStarted: async (resource) => {
            item.resource = resource;
            item.status = "running";
            item.resourceStartedAt = new Date().toISOString();
            await this.store.saveRun(run);
          },
        },
        action,
      );
      item.inputs = [...new Set([...inputs, ...receivedModelRoots(value)])];
      item.output = await this.store.put(`task:${role}`, value, item.inputs);
      item.status = "succeeded";
      if (value && typeof value === "object") {
        const returned = Array.isArray(value) ? [...value] : { ...value };
        this.taskReceipts ||= new WeakMap();
        this.taskReceipts.set(returned, item);
        return returned;
      }
      return value;
    } catch (e) {
      item.status = "blocked";
      item.error =
        (typeof e?.message === "string" && e.message.trim()) ||
        (typeof e === "string" && e.trim()) ||
        `${title}失败：执行器没有返回具体错误信息。`;
      item.inputs = [...new Set([...inputs, ...receivedModelRoots(e)])];
      item.output = await this.store.put(
        `task:${role}:blocked`,
        {
          reason: item.error,
          ...(e?.modelRecord ? { model: e.modelRecord } : {}),
          ...(e?.structuredAttempts
            ? { structuredAttempts: e.structuredAttempts }
            : {}),
          ...(e?.domainRecord ? { domain: e.domainRecord } : {}),
        },
        item.inputs,
      );
      const failure =
        typeof e?.message === "string" && e.message.trim()
          ? e
          : new Error(item.error, { cause: e });
      failure.pipelineTaskReceipt = item;
      throw failure;
    } finally {
      item.endedAt = new Date().toISOString();
      await this.store.saveRun(run);
    }
  }
  async recoverDomain(id, input, internal = {}) {
    return recoverDomain(this, id, input, internal);
  }
  async start(input) {
    return this.reserve(() => this.startReserved(input));
  }
  async startReserved(input, internal = {}) {
    if (
      !input ||
      !isHash(input.paperSha256) ||
      !Number.isInteger(input.pageIndex) ||
      input.pageIndex < 0 ||
      typeof input.pdfBase64 !== "string" ||
      input.pdfBase64.length > 36 * 1024 * 1024
    )
      throw new Error("论文身份、页码或文件内容无效。");
    if (!["model", "manual"].includes(input.mode))
      throw new Error("评审方式无效。");
    if (input.focusQuote !== undefined)
      input.focusQuote = text(input.focusQuote, 5000, "局部论证原文");
    const profile = libraryProfile(input.libraryProfile);
    const supplements = supplementsFor(input.supplements);
    const proofStrategy = input.proofStrategy || input.mode;
    if (
      !["model", "manual"].includes(proofStrategy) ||
      (input.mode === "model" && proofStrategy !== "model")
    )
      throw new Error("证明构造方式无效。");
    let seedProof = null;
    const autonomy =
      internal.autonomy ||
      (input.mode === "model" && !input.seedProof ? freshProofSession() : null);
    if (autonomy && input.seedProof)
      throw Error("自主评审不接受预先提供的证明。");
    if (input.seedProof) {
      if (
        proofStrategy !== "model" ||
        !["proof", "counterexample"].includes(input.seedProof.mode)
      )
        throw new Error("已有证明只能提交给模型修复，且须选择固定核验方向。");
      seedProof = {
        proof: validateLeanText(
          input.seedProof.proof,
          "已有证明",
          MAX_PROOF_CHARACTERS,
        ),
        mode: input.seedProof.mode,
        origin: "human_seed",
      };
    }
    const config =
      input.mode === "model" || proofStrategy === "model"
        ? await this.getConfig()
        : null;
    if ((input.mode === "model" || proofStrategy === "model") && !config)
      throw new Error(
        "模型尚未配置。可在本机配置接口，或用高级入口提交明确的形式化目标。",
      );
    const run = {
      id: internal.runId || randomUUID(),
      ...(!internal.parentReviewId && internal.admissionBudgetId
        ? { admissionBudgetId: internal.admissionBudgetId }
        : {}),
      ...(internal.parentReviewId
        ? {
            parentReviewId: internal.parentReviewId,
            parentTaskId: internal.parentTaskId,
          }
        : {}),
      mode: input.mode,
      proofStrategy,
      libraryProfile: profile.id,
      status: "preparing",
      createdAt: new Date().toISOString(),
      pageIndex: input.pageIndex,
      focusQuote: input.focusQuote || null,
      propositionScope: input.propositionScope || null,
      scopeEvidence: internal.scopeEvidence || null,
      environmentSelection: internal.environmentSelection || null,
      paperSha256: input.paperSha256,
      tasks: [],
      contract: null,
      approval: null,
      originalProof: null,
      check: null,
      conclusion: null,
      root: null,
      seedProof,
      autonomy,
    };
    const controller = new AbortController();
    await this.store.saveRun(run);
    this.active.set(run.id, controller);
    this.launch(
      run,
      this.prepare(run, { ...input, supplements }, config, controller),
    );
    return run;
  }
  async prepare(run, input, config, controller) {
    try {
      const source = await this.task(
        run,
        "R02",
        "固定论文与原文",
        "pdf_parser",
        [],
        async () => {
          const paper = await extractInWorker(
            input.pdfBase64,
            null,
            controller.signal,
          );
          if (paper.paperSha256 !== input.paperSha256)
            throw new Error("论文摘要与页面不匹配，任务未继续。");
          const page = paper.pages.find((p) => p.index === input.pageIndex);
          if (!page?.text.trim())
            throw new Error("选中页没有可核对文本；请提供含文本层的原文。");
          const selected = {
            ...paper,
            pageIndex: input.pageIndex,
            text: page.text,
          };
          return this.documentExtractor
            ? this.documentExtractor(selected, input.pageIndex, {
                signal: controller.signal,
              })
            : selected;
        },
      );
      run.sourceArtifact = this.taskReceipt(source).output;
      if (run.seedProof)
        run.seedArtifact = await this.store.put(
          "human_proof_seed",
          run.seedProof,
          [run.sourceArtifact],
        );
      const context = await this.task(
        run,
        "R02C",
        "收集跨页定义与假设",
        "context_builder",
        [run.sourceArtifact, ...Object.values(run.scopeEvidence || {})],
        async () => {
          let context = buildContext(
            source,
            input.pageIndex,
            input.supplements,
          );
          if (run.propositionScope)
            context = bindScopeEvidence(
              context,
              run.propositionScope,
              run.scopeEvidence,
              await this.store.get(run.scopeEvidence?.selection),
              await this.store.get(run.scopeEvidence?.review),
            );
          if (run.mode === "model") {
            context.semanticProtocol =
              config.semanticProtocol ||
              (config.auditBindingProtocol
                ? ANCHORED_AUDIT_PROTOCOL
                : WITNESSED_AUDIT_PROTOCOL);
            if (!epistemicAuditProtocol(context.semanticProtocol))
              throw Error("Unsupported current semantic audit protocol");
            context.anchorProtocol = INDEXED_ANCHOR_V2;
            if (config.auditBindingProtocol)
              context.auditBindingProtocol = config.auditBindingProtocol;
          }
          return context;
        },
      );
      run.contextArtifact = this.taskReceipt(context).output;
      run.context = context;
      if (input.focusQuote)
        anchorInContext(
          { pageIndex: input.pageIndex, quote: input.focusQuote },
          context,
        );
      const proposal = await this.task(
        run,
        "R03",
        "提取并对照命题",
        run.mode === "model" ? "model" : "human_input",
        [
          run.sourceArtifact,
          run.contextArtifact,
          ...(run.environmentSelection
            ? [run.environmentSelection.artifact]
            : []),
        ],
        async () => {
          if (run.mode === "manual")
            return { proposal: input.proposal, origin: "human" };
          const result = await this.model(config, {
            role: "R03",
            outputSchema: translationSchema,
            maxTokens: 8000,
            system: scopedPrompt(
              extractionPrompt,
              libraryProfile(run.libraryProfile),
              true,
            ),
            input: {
              text: source.text,
              pageIndex: source.pageIndex,
              selectedPage: source.pageIndex,
              libraryProfile: libraryProfile(run.libraryProfile),
              selectedQuote: input.focusQuote || null,
              propositionScope: run.propositionScope,
              preparedEnvironment: run.environmentSelection
                ? (await this.store.get(run.environmentSelection.artifact))
                    .payload.value
                : null,
              context: translationContext(context),
              constraints: input.focusQuote
                ? run.propositionScope
                  ? "propositionScope.spans 是经过独立范围复核的完整原文，可能包含前页定义及跨页命题；selectedQuote 是原始命题定位片段，不是第一段定义。必须使用全部 spans 的前提和结论；返回 quote 与 selectedQuote 完全一致，不得把定位片段误作全部范围或偷换另一命题。语义仍须独立复核。"
                  : "仅分析 selectedQuote 这一完整选区；quote 必须与 selectedQuote 一致。不能把目标替换成同页其他命题。选区不足以形成命题时返回 unavailable。"
                : "仅选择一条原命题，不修正表述",
            },
            signal: controller.signal,
          });
          return { proposal: result.parsed, model: result.record };
        },
      );
      run.translationArtifact = this.taskReceipt(proposal).output;
      if (
        input.focusQuote &&
        !proposal.proposal?.unavailable &&
        normalize(proposal.proposal?.quote || "") !==
          normalize(input.focusQuote)
      )
        throw new Error("模型改变了用户选定的论证范围，未继续核验。");
      if (proposal.proposal?.unavailable) {
        run.pendingObligations = [
          {
            type: "definition",
            label: "命题表达所需材料",
            pageIndex: source.pageIndex,
            quote: source.text.slice(0, 1000),
            statement: text(proposal.proposal.unavailable, 3000, "受阻原因"),
          },
        ];
        throw new Error(proposal.proposal.unavailable);
      }
      const translationDomain =
        proposal.proposal?.moduleReceiptIds?.length || run.environmentSelection
          ? await bindTranslationModules(this.store, {
              model: proposal.model,
              ids: proposal.proposal.moduleReceiptIds || [],
              environmentSelection: run.environmentSelection,
              paperSha256: run.paperSha256,
              sourceArtifact: run.sourceArtifact,
              contextArtifact: run.contextArtifact,
              translationArtifact: run.translationArtifact,
              signal: controller.signal,
            })
          : null;
      run.contract = await this.task(
        run,
        "R05",
        "固定前提与目标版本",
        "contract_validator",
        [
          run.sourceArtifact,
          run.contextArtifact,
          run.translationArtifact,
          ...(translationDomain ? [translationDomain.artifact] : []),
        ],
        async () =>
          createContract(
            { ...source, artifact: run.sourceArtifact },
            proposal.proposal,
            run.libraryProfile,
            {
              contextArtifact: run.contextArtifact,
              translationArtifact: run.translationArtifact,
            },
            translationDomain,
          ),
      );
      run.contractArtifact = this.taskReceipt(run.contract).output;
      await this.reviewTranslation(run, proposal, config, controller);
      if (controller.signal.aborted) throw new Error("任务已取消。");
      run.status = "awaiting_confirmation";
    } catch (e) {
      run.status = controller.signal.aborted ? "cancelled" : "blocked";
      run.error = e.message;
      run.root = await this.store.put(
        "review_blocked",
        {
          runId: run.id,
          status: run.status,
          reason: run.error,
          paperSha256: run.paperSha256,
          mathematicalConclusion: "unknown",
        },
        run.tasks.map((t) => t.output).filter(Boolean),
      );
    }
    await this.store.saveRun(run);
  }
  async reviewTranslation(run, proposal, config, controller) {
    const context = run.context;
    const alignmentRepairs = [];
    const alignment = proposal.proposal.alignment
      ? validateAlignment(
          proposal.proposal.alignment,
          run.contract,
          context,
          alignmentRepairs,
        )
      : [];
    if (run.mode === "model" && !alignment.length)
      throw new Error("模型未返回六类翻译对照，不能提交确认。");
    const targetCheck = await this.task(
      run,
      "R04T",
      "检查命题类型与形式表达",
      "lean_type_checker",
      [run.contractArtifact],
      () => this.targetChecker(run.contract, { signal: controller.signal }),
    );
    const typeArtifact = this.taskReceipt(targetCheck).output;
    run.nativeTargetCheck = targetCheck;
    run.nativeTargetArtifact = typeArtifact;
    if (run.mode === "model" && targetCheck.status !== "well_typed") {
      const unavailable = targetCheck.status === "tool_unavailable";
      run.pendingObligations = [
        {
          type: unavailable ? "environment" : "translation",
          label: unavailable
            ? "原生检查不可用，目标类型仍未知"
            : "形式目标未通过原生检查",
          targetHash: run.contract.targetHash,
          nativeArtifact: typeArtifact,
        },
      ];
      throw Object.assign(
        new Error(
          unavailable
            ? "原生检查因环境或资源未完成；保留原目标及诊断，未派发语义审计。"
            : "原生目标检查未通过；保留诊断，需新目标版本，未派发语义审计。",
        ),
        {
          recoveryStop: unavailable
            ? "native_environment_unavailable"
            : "native_target_rejected",
          nativeTargetArtifact: typeArtifact,
        },
      );
    }

    const definitions =
      run.mode === "model" && targetCheck.status === "well_typed"
        ? await this.task(
            run,
            "R04K",
            "核对数学库定义与条件",
            "library_lookup",
            [run.contractArtifact, typeArtifact],
            () => this.knowledge(run.contract, { signal: controller.signal }),
          )
        : null;
    const definitionArtifact = definitions
      ? this.taskReceipt(definitions).output
      : null;
    const semanticConfig =
      run.mode === "model" ? await this.getSemanticConfig() : null;
    const blindInput = blindSemanticInput(
      run.contract,
      context,
      definitions,
      targetCheck,
    );
    const blind =
      run.mode === "model"
        ? await this.task(
            run,
            "R04B",
            "先盲审原文与形式目标",
            "model",
            [
              run.contractArtifact,
              run.contextArtifact,
              typeArtifact,
              ...(definitionArtifact ? [definitionArtifact] : []),
            ],
            async () => {
              const result = await structuredReviewCall(
                this.model.bind(this),
                semanticConfig,
                {
                  role: "R04",
                  budgetPurpose: "semantic_blind",
                  maxTokens: 8000,
                  system:
                    context.semanticProtocol === ANCHORED_AUDIT_PROTOCOL
                      ? ANCHORED_AUDIT_PROMPT
                      : context.semanticProtocol === WITNESS_AUDIT_PROTOCOL
                        ? WITNESS_AUDIT_PROMPT
                        : context.semanticProtocol ===
                            NATIVE_BOUND_AUDIT_PROTOCOL
                          ? NATIVE_BOUND_AUDIT_PROMPT
                          : context.semanticProtocol ===
                              WITNESSED_AUDIT_PROTOCOL
                            ? WITNESSED_AUDIT_PROMPT
                            : context.semanticProtocol ===
                                EPISTEMIC_AUDIT_PROTOCOL
                              ? EPISTEMIC_AUDIT_PROMPT
                              : nativeAuditProtocol(context.semanticProtocol)
                                ? adjudicatedAuditProtocol(
                                    context.semanticProtocol,
                                  )
                                  ? ADJUDICATED_AUDIT_PROMPT
                                  : NATIVE_AUDIT_PROMPT
                                : context.anchorProtocol === ANCHOR_PROTOCOL
                                  ? COMPACT_AUDIT_PROMPT
                                  : BLIND_PROMPT,
                  input: blindInput,
                  signal: controller.signal,
                },
                (response) => {
                  if (nativeAuditProtocol(context.semanticProtocol))
                    validateAuditWire(response, {
                      protocol: context.semanticProtocol,
                    });
                  if (epistemicAuditProtocol(context.semanticProtocol))
                    validateEpistemicFindings(response, run.contract, context);
                  semanticReview(
                    run.contract,
                    context,
                    [],
                    response,
                    targetCheck,
                  );
                  if (sourceAuditProtocol(context.semanticProtocol))
                    validateSourceAudit(
                      response.sourceAudit,
                      run.contract,
                      context,
                      targetCheck,
                    );
                },
              );
              try {
                // All six categories need independent source anchors, regardless of
                // which categories the translator marked not applicable.
                semanticReview(
                  run.contract,
                  context,
                  [],
                  result.parsed,
                  targetCheck,
                );
              } catch (error) {
                error.modelRecord = result.record;
                throw error;
              }
              return {
                protocol: "lemma.blind-semantic.v1",
                auditOwner: {
                  runId: run.id,
                  taskId: executionContext.getStore()?.task?.id || null,
                },
                input: blindInput,
                inputHash: digest(blindInput),
                response: result.parsed,
                model: result.record,
                structuredAttempts: result.attempts,
              };
            },
          )
        : null;
    const blindArtifact = blind ? this.taskReceipt(blind).output : null;
    const semanticProbes = [];
    const requestedProbes = blind?.response?.sourceAudit?.probes || [];
    if (!Array.isArray(requestedProbes) || requestedProbes.length > 2)
      throw Error("每次语义审计最多两个诊断目标。");
    for (const probe of requestedProbes) {
      const result = await this.task(
        run,
        "R04P",
        "核验条件或边界诊断",
        "lean_diagnostic",
        [run.contractArtifact, run.contextArtifact, blindArtifact],
        () =>
          checkSemanticProbe(run.contract, context, probe, {
            signal: controller.signal,
            checker: this.checker,
          }),
      );
      semanticProbes.push({
        artifact: this.taskReceipt(result).output,
        ...result,
      });
    }

    run.semanticReview = await this.task(
      run,
      "R04",
      "独立复核翻译差异",
      run.mode === "model" ? "model" : "semantic_rules",
      [
        run.contractArtifact,
        run.contextArtifact,
        run.translationArtifact,
        typeArtifact,
        ...(definitionArtifact ? [definitionArtifact] : []),
        ...(blindArtifact ? [blindArtifact] : []),
        ...semanticProbes.map((p) => p.artifact),
      ],
      async () => {
        if (run.mode === "manual")
          return semanticReview(
            run.contract,
            context,
            alignment,
            null,
            targetCheck,
          );
        const result = await structuredReviewCall(
          this.model.bind(this),
          semanticConfig,
          {
            role: "R04",
            budgetPurpose: "semantic_comparison",
            maxTokens: 8000,
            system:
              context.semanticProtocol === ANCHORED_AUDIT_PROTOCOL
                ? ANCHORED_COMPARISON_PROMPT
                : context.semanticProtocol === WITNESS_AUDIT_PROTOCOL
                  ? WITNESS_COMPARISON_PROMPT
                  : context.semanticProtocol === NATIVE_BOUND_AUDIT_PROTOCOL
                    ? NATIVE_BOUND_COMPARISON_PROMPT
                    : context.semanticProtocol === WITNESSED_AUDIT_PROTOCOL
                      ? WITNESSED_COMPARISON_PROMPT
                      : context.semanticProtocol === EPISTEMIC_AUDIT_PROTOCOL
                        ? EPISTEMIC_COMPARISON_PROMPT
                        : nativeAuditProtocol(context.semanticProtocol)
                          ? NATIVE_COMPARISON_PROMPT
                          : COMPARISON_PROMPT,
            input: {
              ...blindInput,
              stage: "comparison_after_immutable_blind_review",
              blindResponse: blind.response,
              alignment,
              repairFeedback: run.translationRepairFeedback || null,
              libraryDefinitions: adjudicatedAuditProtocol(
                context.semanticProtocol,
              )
                ? blindInput.libraryDefinitions
                : definitions?.entries || [],
              libraryLookup: definitions
                ? {
                    status: definitions.status,
                    unresolved: definitions.unresolved || [],
                    note: definitions.note || null,
                  }
                : null,
              addedDefinitions:
                run.domainRecovery?.components?.filter(
                  (c) => c.kind === "definition",
                ) || [],
              typeInspection: {
                status: targetCheck.status,
                ...(adjudicatedAuditProtocol(context.semanticProtocol)
                  ? { nativeReceipt: typeArtifact }
                  : { stdout: targetCheck.stdout, stderr: targetCheck.stderr }),
                parser: targetCheck.parser || null,
                reason: targetCheck.reason,
              },
            },
            signal: controller.signal,
          },
          (response) => {
            if (nativeAuditProtocol(context.semanticProtocol))
              validateAuditWire(response, {
                comparison: true,
                protocol: context.semanticProtocol,
              });
            if (epistemicAuditProtocol(context.semanticProtocol))
              validateEpistemicFindings(response, run.contract, context);
            return semanticReview(
              run.contract,
              context,
              alignment,
              response,
              targetCheck,
            );
          },
        );
        let reviewed;
        try {
          reviewed = mergeSemanticReviews(
            run.contract,
            context,
            alignment,
            blind.response,
            result.parsed,
            targetCheck,
            { blind: blind.structuredAttempts, comparison: result.attempts },
          );
        } catch (error) {
          error.modelRecord = result.record;
          error.structuredAttempts = result.attempts;
          throw error;
        }
        return {
          ...reviewed,
          auditOwner: {
            runId: run.id,
            taskId: executionContext.getStore()?.task?.id || null,
          },
          structuredAttempts: result.attempts,
          ...(semanticProbes.length ? { semanticProbes } : {}),
          blindArtifact,
          blindInputHash: blind.inputHash,
          modelRelationship: semanticModelIdentity(semanticConfig, config),
          model: result.record,
          ...(alignmentRepairs.length ? { alignmentRepairs } : {}),
        };
      },
    );
    run.semanticArtifact = this.taskReceipt(run.semanticReview).output;
    run.pendingObligations = run.semanticReview.checks
      .filter((c) => c.status !== "aligned")
      .flatMap((c) =>
        c.anchors
          .filter((a) => a.pageIndex !== undefined)
          .map((a) => ({
            type: c.category === "definitions" ? "definition" : "condition",
            label: `翻译复核 · ${c.category}`,
            pageIndex: a.pageIndex,
            quote: a.quote,
            statement: c.explanation,
          })),
      );
  }
  async retryTranslation(id, internal = {}) {
    return this.reserve(async () => {
      const previous = await this.store.getRun(id);
      if (
        previous.mode !== "model" ||
        ![
          "blocked",
          "awaiting_confirmation",
          "interrupted",
          ...(internal.reviseTarget ? ["completed"] : []),
        ].includes(previous.status) ||
        (previous.approval && !internal.reviseTarget) ||
        ![
          "lemma.contract.v3",
          "lemma.contract.v4",
          "lemma.contract.v5",
        ].includes(previous.contract?.schemaVersion)
      )
        throw new Error("目标仍在执行，或当前请求不允许创建新的翻译版本。");
      validateContract(previous.contract);
      const storedContract = await this.store.get(previous.contractArtifact),
        storedContext = await this.store.get(previous.contextArtifact);
      if (
        digest(storedContract.payload) !== digest(previous.contract) ||
        digest(storedContext.payload) !== digest(previous.context)
      )
        throw new Error("待复核记录与固定证据不一致。");
      let proposal = (await this.store.get(previous.translationArtifact))
        .payload;
      for (const task of previous.tasks)
        if (task.output) await this.store.get(task.output);
      const config = await this.getConfig();
      if (!config) throw new Error("模型尚未配置。");
      const run = {
        ...structuredClone(previous),
        id: internal.runId || randomUUID(),
        ...(internal.parentTaskId
          ? { parentTaskId: internal.parentTaskId }
          : {}),
        createdAt: new Date().toISOString(),
        continuedFrom: previous.id,
        translationRepairFeedback:
          internal.repairFeedback || previous.error || null,
        tasks: previous.tasks
          .filter(
            (t) => !internal.reviseTarget || ["R02", "R02C"].includes(t.role),
          )
          .map((t) => ({
            ...t,
            reusedFrom: t.reusedFrom || previous.id,
          })),
        status: "preparing",
        error: null,
        root: null,
        semanticReview: null,
        semanticArtifact: null,
        pendingObligations: [],
        approval: null,
        conclusion: null,
      };
      if (internal.reviseTarget) {
        for (const key of [
          "approvalArtifact",
          "check",
          "checkArtifact",
          "originalProof",
          "originalProofRoute",
          "originalProofArtifact",
          "proofArtifact",
          "repair",
          "attempts",
          "provingSearch",
          "knowledge",
          "nativeTargetCheck",
          "nativeTargetArtifact",
          "seedProof",
          "seedArtifact",
          "endedAt",
          "cancelRequested",
        ])
          delete run[key];
      }
      const controller = new AbortController();
      await this.store.saveRun(run);
      this.active.set(run.id, controller);
      this.launch(
        run,
        (async () => {
          try {
            if (internal.reviseTarget) {
              const source = (await this.store.get(run.sourceArtifact)).payload;
              const focusQuote = run.focusQuote || previous.contract.quote;
              proposal = await this.task(
                run,
                "R03",
                "根据实际诊断重新翻译未确认目标",
                "model",
                [
                  previous.contractArtifact,
                  previous.semanticArtifact,
                  run.sourceArtifact,
                  run.contextArtifact,
                  run.translationArtifact,
                ].filter(Boolean),
                async () => {
                  const result = await this.model(config, {
                    role: "R03_TARGET_REPAIR",
                    outputSchema: translationSchema,
                    maxTokens: 8000,
                    system:
                      scopedPrompt(
                        extractionPrompt,
                        {
                          ...libraryProfile(run.libraryProfile),
                          imports: previous.contract.imports,
                        },
                        true,
                      ) +
                      "\nRepair the unapproved formalization from the actual native and semantic diagnostics. Keep the selected source, original assumptions and mathematical scope. Return a new complete proposal and all six alignment categories; do not weaken the claim or fix the author's mathematics. Added definitions may only reference the unchanged domain context. A new version will undergo fresh independent checks.",
                    input: {
                      text: source.text,
                      pageIndex: source.pageIndex,
                      selectedPage: source.pageIndex,
                      selectedQuote: focusQuote,
                      context: translationContext(run.context),
                      previousContract: previous.contract,
                      previousSemanticReview: previous.semanticReview,
                      previousNativeTargetCheck:
                        previous.nativeTargetCheck || null,
                      previousError: previous.error,
                      addedDefinitions: previous.contract.domainContext || null,
                      repairFeedback: run.translationRepairFeedback,
                    },
                    signal: controller.signal,
                  });
                  if (result.parsed.unavailable)
                    throw Object.assign(Error(result.parsed.unavailable), {
                      modelRecord: result.record,
                    });
                  if (
                    normalize(result.parsed.quote || "") !==
                    normalize(focusQuote)
                  )
                    throw Object.assign(
                      Error("重新翻译改变了选定原文；必须保留原选区。"),
                      { modelRecord: result.record },
                    );
                  return { proposal: result.parsed, model: result.record };
                },
              );
              run.translationArtifact = this.taskReceipt(proposal).output;
              const repairedDomain = proposal.proposal?.moduleReceiptIds?.length
                ? await bindTranslationModules(this.store, {
                    model: proposal.model,
                    ids: proposal.proposal.moduleReceiptIds,
                    paperSha256: run.paperSha256,
                    sourceArtifact: run.sourceArtifact,
                    contextArtifact: run.contextArtifact,
                    translationArtifact: run.translationArtifact,
                    signal: controller.signal,
                    priorContract: previous.contract,
                    priorContractArtifact: previous.contractArtifact,
                  })
                : null;
              run.contract = await this.task(
                run,
                "R05",
                "固定重新翻译的新目标版本",
                "contract_validator",
                [
                  previous.contractArtifact,
                  run.sourceArtifact,
                  run.contextArtifact,
                  run.translationArtifact,
                  ...[
                    repairedDomain?.artifact ||
                      previous.contract.domainArtifact,
                  ].filter(Boolean),
                ],
                async () => {
                  const { targetHash, ...body } = previous.contract;
                  if (repairedDomain) {
                    body.domainContext = repairedDomain.context;
                    body.domainArtifact = repairedDomain.artifact;
                    body.schemaVersion = body.externalLibraries?.length
                      ? "lemma.contract.v5"
                      : "lemma.contract.v4";
                    body.imports = [
                      ...new Set([
                        ...libraryProfile(run.libraryProfile).imports,
                        ...repairedDomain.context.modules.map((m) => m.name),
                        ...(body.externalLibraries || []).flatMap(
                          (l) => l.modules,
                        ),
                      ]),
                    ];
                  }
                  Object.assign(
                    body,
                    validateProposal(proposal.proposal, source),
                    {
                      translationArtifact: run.translationArtifact,
                    },
                  );
                  return validateContract({
                    ...body,
                    targetHash: digest(body),
                  });
                },
              );
              run.contractArtifact = this.taskReceipt(run.contract).output;
              run.translationRepair = {
                previousTargetHash: previous.contract.targetHash,
                mathTargetUnchanged:
                  run.contract.leanTarget === previous.contract.leanTarget,
                sourceIdentityUnchanged:
                  run.contract.sourceArtifact ===
                  previous.contract.sourceArtifact,
                kind: "unapproved_target_retranslation",
                reason: run.translationRepairFeedback,
              };
            }
            let alignmentError, repairedAlignment;
            const locationRepairs = [];
            try {
              repairedAlignment = validateAlignment(
                proposal.proposal.alignment,
                run.contract,
                run.context,
                locationRepairs,
              );
            } catch (error) {
              alignmentError = error;
            }
            if (
              (alignmentError || locationRepairs.length) &&
              internal.repairAlignment &&
              !internal.reviseTarget
            ) {
              proposal = await this.task(
                run,
                "R03",
                "修复翻译对照的原文锚点",
                alignmentError ? "model" : "source_anchor_resolver",
                [
                  run.contractArtifact,
                  run.contextArtifact,
                  run.translationArtifact,
                ],
                async () => {
                  if (!alignmentError)
                    return {
                      proposal: {
                        ...proposal.proposal,
                        alignment: repairedAlignment,
                      },
                      anchorRepairs: locationRepairs,
                      scope: "source_locations_only_math_target_unchanged",
                    };
                  const result = await this.model(config, {
                    role: "R03_ALIGNMENT_FIX",
                    maxTokens: 8000,
                    system: ALIGNMENT_REPAIR_PROMPT,
                    input: {
                      contract: run.contract,
                      context: translationContext(run.context),
                      rejectedAlignment: proposal.proposal.alignment,
                      error: alignmentError.message,
                      repairFeedback: run.translationRepairFeedback,
                    },
                    signal: controller.signal,
                  });
                  try {
                    validateTranslationWire(result.parsed, { repair: true });
                    validateAlignment(
                      result.parsed.alignment,
                      run.contract,
                      run.context,
                    );
                  } catch (error) {
                    error.modelRecord = result.record;
                    throw error;
                  }
                  return {
                    proposal: {
                      ...proposal.proposal,
                      alignment: result.parsed.alignment,
                    },
                    model: result.record,
                  };
                },
              );
              run.translationArtifact = this.taskReceipt(proposal).output;
              const priorContract = run.contract;
              run.contract = await this.task(
                run,
                "R05",
                "固定修复对照的新证据版本",
                "contract_validator",
                [
                  run.contractArtifact,
                  run.sourceArtifact,
                  run.contextArtifact,
                  run.translationArtifact,
                  ...[priorContract.domainArtifact].filter(Boolean),
                ],
                async () => {
                  const { targetHash, ...body } = priorContract;
                  body.translationArtifact = run.translationArtifact;
                  const revised = { ...body, targetHash: digest(body) };
                  validateContract(revised);
                  return revised;
                },
              );
              run.contractArtifact = this.taskReceipt(run.contract).output;
              run.translationRepair = {
                previousTargetHash: priorContract.targetHash,
                mathTargetUnchanged: true,
                reason:
                  "仅修复 alignment，Lean 目标、假设、定义、公理均沿用固定值；新证据版本须重新确认。",
              };
            }
            await this.reviewTranslation(run, proposal, config, controller);
            if (controller.signal.aborted) throw new Error("任务已取消。");
            run.status = "awaiting_confirmation";
          } catch (error) {
            run.status = controller.signal.aborted ? "cancelled" : "blocked";
            run.error = error.message;
            run.root = await this.store.put(
              "review_blocked",
              {
                runId: run.id,
                continuedFrom: previous.id,
                status: run.status,
                reason: run.error,
                paperSha256: run.paperSha256,
                mathematicalConclusion: "unknown",
              },
              run.tasks.map((t) => t.output).filter(Boolean),
            );
          }
          await this.store.saveRun(run);
        })(),
      );
      return run;
    });
  }
  async approve(id, input) {
    return this.reserve(() => this.approveReserved(id, input));
  }
  async approveByAgent(id, decisionArtifact) {
    return this.reserve(async () => {
      const artifact = await this.store.get(decisionArtifact),
        v = artifact.payload.value;
      const run = await this.store.getRun(id);
      if (
        artifact.kind !== "adaptive:assess_target" ||
        !artifact.payload.model ||
        v?.childRunId !== id ||
        v.targetHash !== run.contract?.targetHash ||
        v.semanticArtifact !== run.semanticArtifact ||
        !["proof", "counterexample"].includes(v.decision) ||
        !artifact.inputs.includes(run.contractArtifact) ||
        !artifact.inputs.includes(run.semanticArtifact)
      )
        throw Error("自动语义决策缺少对应目标、独立模型记录或来源证据。");
      return this.approveReserved(
        id,
        {
          confirmed: true,
          targetHash: v.targetHash,
          semanticArtifact: v.semanticArtifact,
          resolutions: v.resolutions,
          proofMode: v.decision,
        },
        decisionArtifact,
      );
    });
  }
  async approveReserved(id, input, agentDecisionArtifact = null) {
    const run = await this.store.getRun(id);
    if (
      run.status !== "awaiting_confirmation" ||
      input.confirmed !== true ||
      input.targetHash !== run.contract?.targetHash
    )
      throw new Error("请核对当前固定目标；任务阶段或目标摘要不匹配。");
    if (
      Object.keys(input).some(
        (k) =>
          ![
            "confirmed",
            "targetHash",
            "proof",
            "proofMode",
            "resolutions",
            "semanticArtifact",
          ].includes(k),
      )
    )
      throw new Error("审批不能修改固定目标，请建立新的目标版本。");
    let resolutions = null;
    if (
      ["lemma.contract.v3", "lemma.contract.v4", "lemma.contract.v5"].includes(
        run.contract.schemaVersion,
      )
    ) {
      validateContract(run.contract);
      if (
        digest((await this.store.get(run.contractArtifact)).payload) !==
          digest(run.contract) ||
        digest((await this.store.get(run.semanticArtifact)).payload) !==
          digest(run.semanticReview)
      )
        throw new Error("目标或翻译复核记录与固定产物不一致，不能确认。");
      if (input.semanticArtifact !== run.semanticArtifact)
        throw new Error("请确认当前翻译复核版本，旧确认不能复用。");
      resolutions = validateResolutions(run.semanticReview, input.resolutions);
      if (
        run.contract.schemaVersion === "lemma.contract.v4" ||
        (run.contract.schemaVersion === "lemma.contract.v5" &&
          !!run.contract.domainContext)
      ) {
        const bundle = await this.store.bundle(run.contractArtifact);
        inspectDomainEvidence(
          run.contract,
          new Map(bundle.artifacts.map((a) => [a.id, a])),
          run.semanticReview,
        );
      }
    }
    const config = usesModelProof(run) ? await this.getConfig() : null;
    if (usesModelProof(run) && !config)
      throw new Error("模型配置已失效，尚未执行核验。");
    if (!usesModelProof(run))
      validateLeanText(input.proof, "证明", MAX_PROOF_CHARACTERS);
    if (
      !usesModelProof(run) &&
      !["proof", "counterexample"].includes(input.proofMode || "proof")
    )
      throw new Error("核验方向无效。");
    const controller = new AbortController();
    run.approval = {
      confirmed: true,
      targetHash: run.contract.targetHash,
      recordedAt: new Date().toISOString(),
      authority: agentDecisionArtifact
        ? "autonomous_agent_semantic_assessment_not_human"
        : "local_human_attestation_not_authenticated_identity",
      ...(agentDecisionArtifact
        ? {
            decisionArtifact: agentDecisionArtifact,
            proofMode: input.proofMode,
          }
        : {}),
      ...(resolutions
        ? { semanticArtifact: run.semanticArtifact, resolutions }
        : {}),
    };
    if (agentDecisionArtifact) {
      const choice = (await this.store.get(agentDecisionArtifact)).payload
        .value;
      run.executionPlan = {
        schemaVersion: "lemma.obligation-plan.v1",
        first: choice.nextObligation || "theorem",
        decisionArtifact: agentDecisionArtifact,
        reason: choice.summary,
        sourceProof: choice.sourceProof || "unknown",
      };
    }
    run.approvalArtifact = await this.store.put(
      "semantic_approval",
      run.approval,
      [
        run.contractArtifact,
        ...(run.semanticArtifact ? [run.semanticArtifact] : []),
        ...(agentDecisionArtifact ? [agentDecisionArtifact] : []),
      ],
    );
    run.status = "running";
    await this.store.saveRun(run);
    this.active.set(id, controller);
    this.launch(run, this.execute(run, input, config, controller));
    return run;
  }
  async execute(run, input, config, controller) {
    run.completionProtocol = COMPLETION_VERSION;
    run.requiredObligations = usesModelProof(run)
      ? ["fidelity", "theorem", "author_route"]
      : ["fidelity", "theorem"];
    try {
      const source = (await this.store.get(run.sourceArtifact)).payload;
      const order =
        run.executionPlan?.first === "author_route"
          ? ["author_route", "theorem"]
          : ["theorem", "author_route"];
      run.obligationExecutions ||= [];
      for (const [index, kind] of order.entries()) {
        controller.signal.throwIfAborted();
        const parent = run.parentReviewId
          ? await this.store.getRun(run.parentReviewId)
          : null;
        const allowance = parent
          ? obligationAllowance(parent, index === 0, run, kind)
          : null;
        const phaseController = new AbortController();
        const timer = allowance
          ? setTimeout(
              () => phaseController.abort(new Error("Obligation deadline")),
              allowance.maxElapsedMs,
            )
          : null;
        const phase = {
          kind,
          startedAt: new Date().toISOString(),
          ...(allowance || {}),
          deadlineAt: allowance ? Date.now() + allowance.maxElapsedMs : null,
          reservedCalls: 0,
          closed: false,
        };
        run.obligationExecutions.push(phase);
        if (allowance) run.activeObligation = phase;
        const scoped = {
          signal: AbortSignal.any([controller.signal, phaseController.signal]),
        };
        try {
          if (kind === "theorem")
            await this.proveWithRepair(run, input, config, scoped, source);
          else await this.reviewAuthorRoute(run, config, scoped, source);
          phase.outcome = "returned";
        } catch (error) {
          phase.outcome = "incomplete";
          phase.error = error.message;
          phase.cause = phaseController.signal.aborted
            ? "phase_deadline"
            : terminationCause(error);
          if (controller.signal.aborted) throw error;
        } finally {
          clearTimeout(timer);
          phase.closed = true;
          phase.endedAt = new Date().toISOString();
          phase.elapsedMs =
            Date.parse(phase.endedAt) - Date.parse(phase.startedAt);
          delete run.activeObligation;
          await this.store.saveRun(run);
        }
      }
      run.conclusion = deriveConclusion(run);
      const completion = reviewCompletion(run);
      run.status = controller.signal.aborted
        ? "cancelled"
        : completion.reviewComplete
          ? "completed"
          : "blocked";
      run.conclusion = { ...run.conclusion, ...completion };
    } catch (e) {
      run.status = controller.signal.aborted ? "cancelled" : "blocked";
      run.error = e.message;
      run.termination = {
        schemaVersion: "lemma.termination.v1",
        cause: controller.signal.aborted ? "cancelled" : terminationCause(e),
      };
      run.conclusion = deriveConclusion(run);
      run.conclusion = { ...run.conclusion, ...reviewCompletion(run) };
      if (run.repair)
        run.repair.stopReason ||= controller.signal.aborted
          ? "cancelled"
          : Date.now() - Date.parse(run.repair.startedAt) >=
              run.repair.budget.maxElapsedMs
            ? "time_budget"
            : "execution_error";
    }
    try {
      const archiveStartedAt = Date.now();
      run.root = await this.store.put(
        "review_report",
        {
          runId: run.id,
          completionProtocol: run.completionProtocol,
          requiredObligations: run.requiredObligations,
          termination: run.termination || null,
          paperSha256: run.paperSha256,
          contract: run.contract,
          approval: run.approval,
          originalProof: run.originalProof || null,
          originalProofRoute: run.originalProofRoute || null,
          executionPlan: run.executionPlan || null,
          obligationExecutions: run.obligationExecutions || [],
          nativeTimings: run.nativeTimings || [],
          semanticReview: run.semanticReview || null,
          semanticArtifact: run.semanticArtifact || null,
          contextArtifact: run.contextArtifact || null,
          attempts: run.attempts || [],
          repair: run.repair || null,
          domainRecovery: run.domainRecovery || null,
          check: run.check || null,
          conclusion: run.conclusion,
          status: run.status,
          contractArtifact: run.contractArtifact,
          approvalArtifact: run.approvalArtifact,
          proofArtifact: run.proofArtifact || null,
          checkArtifact: run.checkArtifact || null,
          coverage: {
            selectedClaims: 1,
            knownOtherClaims: "not_enumerated",
            wholePaperVerified: false,
          },
        },
        [
          run.sourceArtifact,
          run.contractArtifact,
          run.approvalArtifact,
          ...(run.originalProofRoute?.root
            ? [run.originalProofRoute.root]
            : []),
          ...run.tasks.map((t) => t.output).filter(Boolean),
        ],
      );
      run.archiveTiming = {
        startedAtMs: archiveStartedAt,
        endedAtMs: Date.now(),
        elapsedMs: Date.now() - archiveStartedAt,
        scope:
          "report_persistence_after_execution_not_subtracted_from_wall_clock",
        root: run.root,
      };
      await this.store.saveRun(run);
    } catch (e) {
      run.status = "blocked";
      run.error = `证据归档失败：${e.message}`;
      run.archiveFailure = true;
      run.root = null;
      run.conclusion = deriveConclusion(run);
      await this.store.saveRun(run);
    }
  }
  async reviewAuthorRoute(run, config, controller, source) {
    if (usesModelProof(run)) {
      try {
        run.originalProof = await this.task(
          run,
          "R06",
          "审阅原证明路线",
          "model",
          [
            run.sourceArtifact,
            run.contractArtifact,
            run.contextArtifact,
          ].filter(Boolean),
          async () => {
            const result = await this.model(config, {
              role: "R06",
              maxTokens: 8000,
              system: auditPrompt,
              input: {
                text: source.text,
                context: run.context,
                contract: run.contract,
              },
              signal: controller.signal,
            });
            const value = result.parsed;
            if (
              !["gap_candidate", "unchecked", "source_proof_missing"].includes(
                value.status,
              )
            )
              throw new Error("原证明审计状态无效。");
            let anchor = null;
            if (
              ["gap_candidate", "source_proof_missing"].includes(value.status)
            )
              anchor = resolveContextAnchor(
                {
                  pageIndex: value.pageIndex ?? source.pageIndex,
                  quote: value.quote,
                },
                run.context || {
                  pages: [{ pageIndex: source.pageIndex, text: source.text }],
                  supplements: [],
                },
                {
                  focusAnchor: {
                    pageIndex: run.contract.pageIndex,
                    quote: run.contract.quote,
                  },
                },
              );
            return {
              status: value.status,
              quote: String(value.quote || "").slice(0, 5000),
              anchor,
              explanation: text(value.explanation, 5000, "审计说明"),
              model: result.record,
            };
          },
        );
      } catch (error) {
        if (controller.signal.aborted) throw error;
        run.originalProof = {
          status: "unchecked",
          quote: "",
          anchor: null,
          explanation: `原证明候选审计未完成：${error.message}`,
          auditArtifact: error.pipelineTaskReceipt?.output || null,
        };
      }
    }
    if (
      run.originalProof?.status === "gap_candidate" &&
      run.originalProof.anchor?.pageIndex !== undefined
    ) {
      run.pendingObligations ||= [];
      run.pendingObligations.push({
        type: "proof_step",
        label: "原证明步骤候选疑点",
        pageIndex: run.originalProof.anchor.pageIndex,
        quote: run.originalProof.anchor.quote,
        statement: run.originalProof.explanation,
      });
    }
    if (
      run.originalProof?.status === "source_proof_missing" &&
      run.executionPlan?.sourceProof === "missing" &&
      run.context?.omittedPages?.length === 0
    ) {
      const auditArtifact = this.taskReceipt(run.originalProof).output;
      const payload = {
        targetHash: run.contract.targetHash,
        paperSha256: run.paperSha256,
        auditArtifact,
        decisionArtifact: run.executionPlan.decisionArtifact,
        contextArtifact: run.contextArtifact,
        contractArtifact: run.contractArtifact,
        authority: "two_agent_source_observations_not_mathematical_proof",
      };
      const root = await this.store.put("source_proof_absence", payload, [
        auditArtifact,
        payload.decisionArtifact,
        run.contextArtifact,
        run.contractArtifact,
      ]);
      const bundle = await this.store.bundle(root);
      inspectSourceProofAbsence(
        new Map(bundle.artifacts.map((a) => [a.id, a])),
        root,
        run.contract,
      );
      run.originalProofRoute = {
        root,
        summary: {
          status: "source_proof_missing",
          headline: "所选来源未提供作者证明",
          wholePaperVerified: false,
        },
        authority: payload.authority,
      };
      return;
    }
    if (this.originalProofEngine && usesModelProof(run)) {
      try {
        run.originalProofRoute = await this.originalProofEngine.review({
          ...run,
          config,
          signal: controller.signal,
          task: async (role, title, inputs, action) => {
            const value = await this.task(
              run,
              role,
              title,
              "original-proof",
              inputs,
              action,
            );
            return {
              value,
              artifact: await this.store.put(`task:${role}`, value, [
                ...new Set([...inputs, ...receivedModelRoots(value)]),
              ]),
            };
          },
          onProgress: async (route) => {
            run.originalProofRoute = route;
            await this.store.saveRun(run);
          },
        });
      } catch (e) {
        run.originalProofRoute = {
          ...(run.originalProofRoute || {}),
          summary: { status: "partial", headline: "原证明路线尚未完成" },
          error: e.message,
        };
        if (controller.signal.aborted) throw e;
      }
    }
  }
  async proveWithRepair(run, input, config, controller, source) {
    const route = run.originalProofRoute;
    const received =
      route?.independentTheorem?.status === "verified"
        ? route.independentTheorem
        : route?.assembly?.status === "verified"
          ? route.assembly
          : null;
    if (
      run.approval?.proofMode !== "counterexample" &&
      received?.contract?.targetHash === run.contract.targetHash &&
      kernelAccepted(received.check, run.contract)
    ) {
      const started = Date.now();
      const candidate = await this.task(
        run,
        "R09",
        "读取已核验的命题证明",
        "proof_candidate",
        [
          run.contractArtifact,
          run.approvalArtifact,
          route.root,
          received.artifact,
        ].filter(Boolean),
        async () => ({
          mode: "proof",
          route: received === route.assembly ? "original" : "independent",
          proof: received.proof,
          explanation: "来自原证明核验中的命题证书；不改变原路线判断。",
          model: { source: "received_exact_target_certificate_no_model_call" },
        }),
      );
      run.proofArtifact = this.taskReceipt(candidate).output;
      run.check = await this.task(
        run,
        "R10",
        "复查所选命题证书",
        "lean_kernel",
        [run.contractArtifact, run.approvalArtifact, run.proofArtifact],
        () =>
          this.checker(run.contract, candidate.proof, {
            mode: "proof",
            signal: controller.signal,
          }),
      );
      run.checkArtifact = this.taskReceipt(run.check).output;
      run.attempts = [
        {
          number: 1,
          targetHash: run.contract.targetHash,
          proofArtifact: run.proofArtifact,
          checkArtifact: run.checkArtifact,
          status: run.check.status,
          mode: "proof",
          diagnostic: diagnose(run.check),
          elapsedMs: Date.now() - started,
        },
      ];
      run.repair = {
        budget: { ...this.repairBudget, maxCandidates: 1, maxModelCalls: 0 },
        startedAt: new Date(started).toISOString(),
        modelCalls: 0,
        reservedCompletionTokens: 0,
        inputCharacters: 0,
        elapsedMs: Date.now() - started,
        stopReason: kernelAccepted(run.check, run.contract)
          ? "verified_received_source_theorem"
          : "received_certificate_check_failed",
      };
      return;
    }
    if (this.prover && usesModelProof(run)) {
      return this.proveWithSearch(run, input, config, controller, source);
    }
    const budget = {
      ...this.repairBudget,
      ...(!usesModelProof(run) ? { maxCandidates: 1, maxModelCalls: 0 } : {}),
    };
    if (usesModelProof(run) && config?.maxOutputTokens) {
      budget.perCallCompletionTokens = modelOutputTokens(
        config,
        budget.perCallCompletionTokens,
      );
      budget.maxCompletionTokens = Math.max(
        budget.maxCompletionTokens,
        budget.perCallCompletionTokens * budget.maxModelCalls,
      );
    }
    if (usesModelProof(run) && config?.timeoutMs > budget.maxElapsedMs) {
      budget.maxElapsedMs = Math.min(
        PROOF_CEILINGS.maxElapsedMs,
        config.timeoutMs * budget.maxModelCalls + 120000,
      );
    }
    const started = Date.now();
    const deadline = AbortSignal.timeout(budget.maxElapsedMs);
    const signal = AbortSignal.any([controller.signal, deadline]);
    run.attempts = [];
    run.repair = {
      budget,
      startedAt: new Date(started).toISOString(),
      modelCalls: 0,
      reservedCompletionTokens: 0,
      inputCharacters: 0,
      stopReason: null,
    };
    let previous = null;
    const seen = new Set();
    for (let attempt = 1; attempt <= budget.maxCandidates; attempt++) {
      if (signal.aborted) {
        run.repair.stopReason = controller.signal.aborted
          ? "cancelled"
          : "time_budget";
        break;
      }
      let knowledge = { entries: [] },
        cases = [];
      let knowledgeArtifact = null;
      if (usesModelProof(run)) {
        knowledge = await this.task(
          run,
          "R07",
          `检索当前数学库 · 第 ${attempt} 轮`,
          "library_lookup",
          [
            run.contractArtifact,
            ...(run.checkArtifact ? [run.checkArtifact] : []),
          ],
          () =>
            this.knowledge(run.contract, {
              query: previous?.diagnostic.message || "",
              signal,
            }),
        );
        knowledgeArtifact = this.taskReceipt(knowledge).output;
        run.knowledge = knowledge;
        if (attempt === 1)
          cases = await this.task(
            run,
            "R07C",
            "查找可复用的已检查案例",
            "case_lookup",
            [run.contractArtifact],
            () =>
              retrieveCases(this.store, run.contract, {
                autonomy: run.autonomy,
              }),
          );
      }
      const modelInput = {
        contract: run.contract,
        context: run.context || { text: source.text },
        semanticReview: run.semanticReview
          ? {
              backTranslation: run.semanticReview.backTranslation,
              checks: run.semanticReview.checks,
            }
          : null,
        knowledge: knowledge.entries,
        domainKnowledge: run.domainRecovery
          ? {
              search: run.domainRecovery.search,
              components: run.domainRecovery.components.map((c) => ({
                component: c.component,
                status: c.status,
              })),
            }
          : null,
        cases,
        attempt,
        previous,
        constraints:
          "目标、前提、导入和公理固定；如需新增辅助引理，必须在证明项内证明，不得当作公理。根据具体报错修改，不重复同一失败。",
      };
      const characters = JSON.stringify(modelInput).length;
      if (
        usesModelProof(run) &&
        (run.repair.modelCalls >= budget.maxModelCalls ||
          run.repair.reservedCompletionTokens + budget.perCallCompletionTokens >
            budget.maxCompletionTokens ||
          run.repair.inputCharacters + characters > budget.maxInputCharacters)
      ) {
        run.repair.stopReason = "model_budget";
        break;
      }
      const usingSeed = attempt === 1 && run.seedProof;
      const dependencies = [
        run.contractArtifact,
        run.approvalArtifact,
        ...(knowledgeArtifact ? [knowledgeArtifact] : []),
        ...(run.checkArtifact ? [run.checkArtifact] : []),
        ...(usingSeed ? [run.seedArtifact] : []),
      ];
      const proposal = await this.task(
        run,
        "R09",
        usingSeed
          ? "检查人工提交的初始证明"
          : attempt === 1
            ? "为固定目标构造证据"
            : `根据 Lean 报错修复 · 第 ${attempt} 轮`,
        usesModelProof(run) && !usingSeed ? "model" : "human_input",
        dependencies,
        async () => {
          if (usingSeed) return { ...run.seedProof, route: "independent" };
          if (!usesModelProof(run))
            return {
              proof: input.proof,
              mode: input.proofMode || "proof",
              route: "independent",
              origin: "human",
            };
          run.repair.modelCalls++;
          run.repair.reservedCompletionTokens += budget.perCallCompletionTokens;
          run.repair.inputCharacters += characters;
          const result = await this.model(
            {
              ...config,
              timeoutMs: Math.max(
                1,
                Math.min(
                  config.timeoutMs || MODEL_RUNTIME.defaultTimeoutMs,
                  budget.maxElapsedMs - (Date.now() - started),
                ),
              ),
            },
            {
              role: "R09",
              system: scopedPrompt(proofPrompt, {
                ...profileForContract(run.contract),
                imports: run.contract.imports,
              }),
              input: modelInput,
              signal,
              maxTokens: budget.perCallCompletionTokens,
            },
          );
          if (result.parsed.unavailable)
            return {
              unavailable: text(result.parsed.unavailable, 3000, "受阻原因"),
              model: result.record,
            };
          const value = result.parsed;
          if (
            Object.keys(value).some(
              (key) => !["mode", "proof", "route", "explanation"].includes(key),
            )
          )
            throw new Error("修复候选包含目标或未声明字段，拒绝修改固定合同。");
          if (
            !["original", "completion", "independent"].includes(value.route) ||
            !["proof", "counterexample"].includes(value.mode)
          )
            throw new Error("证明路线无效。");
          if (previous && value.mode !== previous.mode)
            throw new Error("同一修复过程不能切换目标与其否定；请另建任务。");
          return {
            proof: validateLeanText(value.proof, "证明", MAX_PROOF_CHARACTERS),
            mode: value.mode,
            route: value.route,
            explanation: String(value.explanation || "").slice(0, 3000),
            model: result.record,
          };
        },
      );
      const proofArtifact = this.taskReceipt(proposal).output;
      if (proposal.unavailable) {
        run.repair.stopReason = "model_unavailable";
        run.repair.explanation = proposal.unavailable;
        break;
      }
      const fingerprint = digest({
        proof: proposal.proof,
        mode: proposal.mode,
      });
      if (seen.has(fingerprint)) {
        run.repair.stopReason = "repeated_candidate";
        run.attempts.push({
          number: attempt,
          targetHash: run.contract.targetHash,
          proofArtifact,
          checkArtifact: null,
          status: "duplicate",
          diff: proofDiff(previous?.proof, proposal.proof),
        });
        break;
      }
      seen.add(fingerprint);
      if (signal.aborted) {
        run.repair.stopReason = controller.signal.aborted
          ? "cancelled"
          : "time_budget";
        break;
      }
      const check = await this.task(
        run,
        "R10",
        `Lean 检查与信任审计 · 第 ${attempt} 轮`,
        "lean_kernel",
        [run.contractArtifact, run.approvalArtifact, proofArtifact],
        () =>
          this.checker(run.contract, proposal.proof, {
            mode: proposal.mode,
            signal,
          }),
      );
      const checkArtifact = this.taskReceipt(check).output;
      const diagnostic = diagnose(check);
      run.proofArtifact = proofArtifact;
      run.check = check;
      run.checkArtifact = checkArtifact;
      run.attempts.push({
        number: attempt,
        targetHash: run.contract.targetHash,
        proofArtifact,
        checkArtifact,
        status: check.status,
        mode: proposal.mode,
        diagnostic,
        diff: proofDiff(previous?.proof, proposal.proof),
        elapsedMs: Date.now() - started,
      });
      await this.store.saveRun(run);
      if (check.status === "verified") {
        run.repair.stopReason = "verified";
        break;
      }
      if (!diagnostic.repairable) {
        run.repair.stopReason = diagnostic.category;
        break;
      }
      if (previous?.diagnostic.fingerprint === diagnostic.fingerprint) {
        run.repair.stopReason = "repeated_failure";
        break;
      }
      previous = {
        proof: proposal.proof,
        mode: proposal.mode,
        diagnostic,
        checkArtifact,
      };
    }
    run.repair.stopReason ||= "candidate_budget";
    run.repair.elapsedMs = Date.now() - started;
  }
  async proveWithSearch(run, input, config, controller, source) {
    run.attempts = [];
    const start = Date.now();
    let latest = run.seedArtifact || null;
    const roleFor = {
      premises: "R07",
      candidate: "R09",
      kernel: "R10",
      session: "R09S",
      search: "R09S",
      export: "R09S",
      checkpoint: "R09S",
      goals: "R09S",
      generate: "R09G",
      tactics: "R09G",
      tactic: "R09S",
      project_plan: "R09D",
      project_kernel: "R09DC",
      helper_kernel: "R09HC",
      helper_connection: "R09HDC",
      project_resume: "R09DR",
      helper_model: "R09HG",
      helper_search: "R09HS",
    };
    const purposeFor = {
      premises: "核对当前数学库中实际可用的定理。",
      candidate: "保存与固定命题对应的候选证明。",
      kernel: "在独立环境重放证明，并检查目标与公理。",
      session: "建立固定命题的 Lean 证明环境。",
      search: "根据当前目标搜索可用的证明步骤。",
      export: "提取可在独立环境重放的证明。",
      checkpoint: "保存已经完成的局部推导，便于恢复。",
      goals: "读取当前尚未解决的目标和假设。",
      generate: "为固定命题构造或修复证明。",
      tactics: "根据实际目标与报错选择下一步推导。",
      tactic: "运行候选推导，检查它是否解决当前目标。",
      project_plan: "按实际失败拆分内部证明义务，保留原命题。",
      project_kernel:
        "先检查辅助命题是否足以推出原目标；不代表这些命题已证明。",
      helper_kernel: "独立检查当前辅助命题；尚不判定主命题通过。",
      helper_model: "为当前辅助命题构造证明，并复用已核验的依赖。",
      helper_search: "执行当前辅助命题的搜索、回退与进度保存。",
      helper_connection: "检查内部引理间的条件连接；相关引理仍须独立证明。",
      project_resume: "恢复已有拆分，并重新检查缓存的目标和证明。",
    };
    const knowledgeTask = run.tasks
      .filter(
        (t) =>
          t.role === "R04K" &&
          t.status === "succeeded" &&
          t.inputs.includes(run.contractArtifact),
      )
      .at(-1);
    const preparedKnowledge = knowledgeTask
      ? (await this.store.get(knowledgeTask.output)).payload
      : null;
    const result = await this.prover.prove(run.contract, {
      preparedKnowledge,
      pathEstimate: run.activeObligation?.pathEstimate || null,
      initialCandidate:
        run.seedProof?.mode === (input.proofMode || "proof")
          ? run.seedProof
          : null,
      config,
      context: run.context || { text: source.text },
      signal: controller.signal,
      mode: input.proofMode || "proof",
      budget: {
        ...this.provingBudget,
        ...(run.activeObligation
          ? {
              maxModelCalls: Math.min(
                run.activeObligation.maxCalls,
                this.provingBudget?.maxModelCalls ??
                  PROOF_RUNTIME.maxModelCalls,
              ),
              maxElapsedMs: Math.max(
                1,
                Math.min(
                  run.activeObligation.deadlineAt - Date.now(),
                  this.provingBudget?.maxElapsedMs ??
                    PROOF_RUNTIME.maxElapsedMs,
                ),
              ),
            }
          : {}),
      },
      reserveModel: () => this.reserveProverModel(run),
      step: async (kind, title, action) => {
        const inputs = [
          run.contractArtifact,
          run.approvalArtifact,
          ...(latest ? [latest] : []),
        ];
        if (
          kind === "kernel" &&
          run.proofArtifact &&
          !inputs.includes(run.proofArtifact)
        )
          inputs.push(run.proofArtifact);
        const value = await this.task(
          run,
          roleFor[kind] || "R09S",
          title,
          [
            "kernel",
            "project_kernel",
            "helper_kernel",
            "helper_connection",
          ].includes(kind)
            ? "lean_kernel"
            : ["generate", "tactics", "project_plan", "helper_model"].includes(
                  kind,
                )
              ? "model"
              : "proof_search",
          inputs,
          action,
        );
        const task = this.taskReceipt(value);
        latest = task.output;
        task.reason = purposeFor[kind];
        task.summary =
          value.status === "verified"
            ? ["project_kernel", "helper_connection"].includes(kind)
              ? "条件连接已通过，辅助命题仍须逐一证明"
              : kind === "helper_kernel"
                ? "该辅助命题已通过 Lean 核验"
                : "固定命题已通过 Lean 核验"
            : value.completed
              ? "找到完整候选，仍需独立核验"
              : value.status === "ready"
                ? "已读取当前目标和假设"
                : value.status === "rejected"
                  ? "本次推导未通过，保留原有证明进度"
                  : value.reason || null;
        if (Array.isArray(value.goals))
          task.goalPreview = value.goals
            .slice(0, 3)
            .map((g) => String(g).slice(0, 1800));
        if (
          value.status === "unavailable" ||
          value.status === "tool_unavailable"
        )
          task.status = "blocked";
        if (kind === "candidate") run.proofArtifact = latest;
        if (kind === "kernel") {
          run.check = value;
          run.checkArtifact = latest;
          run.attempts.push({
            number: run.attempts.length + 1,
            targetHash: run.contract.targetHash,
            proofArtifact: run.proofArtifact,
            checkArtifact: latest,
            status: value.status,
            mode: value.mode,
            diagnostic: diagnose(value),
            elapsedMs: Date.now() - start,
          });
        }
        await this.store.saveRun(run);
        return value;
      },
    });
    run.provingSearch = result.report;
    run.repair = {
      ...result.report,
      engine: "LeanInteract/LeanCopilot",
      attempts: undefined,
    };
    delete run.repair.attempts;
    // Keep the final evidence in the established R09 -> R10 replay format.
    if (result.check) run.check = result.check;
    const artifact = await this.store.put(
      "proving_search_report",
      result.report,
      [run.contractArtifact, run.approvalArtifact, ...(latest ? [latest] : [])],
    );
    run.tasks.push({
      id: randomUUID(),
      role: "R09S",
      title:
        result.report.stopReason === "verified"
          ? "证明核验完成"
          : "本次证明搜索已结束",
      type: "proof_search",
      status: "succeeded",
      inputs: [run.contractArtifact, run.approvalArtifact],
      output: artifact,
      startedAt: new Date(start).toISOString(),
      endedAt: new Date().toISOString(),
    });
    await this.store.saveRun(run);
  }
  async cancel(id) {
    const controller = this.active.get(id);
    if (!controller) throw new Error("任务当前没有执行中的进程。");
    controller.abort();
    return { id, cancellationRequested: true };
  }
  async replay(bundle, expectedRoot) {
    return this.reserve(() => this.replayReserved(bundle, expectedRoot));
  }
  async replayReserved(bundle, expectedRoot) {
    const { saved, contract, source, proofArtifact, domainChecks } =
      inspectReviewEvidence(bundle, expectedRoot);
    const librarySnapshot =
      saved.check?.environment?.library?.snapshot?.id ||
      saved.check?.environment?.library?.content?.sha256;
    let sourceEvidenceRecheck = null;
    const page = await extractInWorker(
      source.payload.pdfBase64,
      contract.pageIndex,
    );
    if (
      page.paperSha256 !== contract.paperSha256 ||
      page.text !== source.payload.text ||
      !normalize(page.text).includes(normalize(contract.quote))
    )
      throw new Error("论文、引句或提取文本不一致。");
    if (
      ["lemma.contract.v3", "lemma.contract.v4", "lemma.contract.v5"].includes(
        contract.schemaVersion,
      )
    ) {
      const paper = await extractInWorker(source.payload.pdfBase64, null);
      if (digest(paper.pages) !== digest(source.payload.pages))
        throw new Error("跨页原文提取与归档不一致。");
      if (source.payload.mathEvidence) {
        const { validateMathematicalSource } =
          await import("./math-extraction.mjs");
        sourceEvidenceRecheck = await validateMathematicalSource(
          source.payload,
        );
      }
      const type = await this.targetChecker(contract, { librarySnapshot });
      if (type.status !== "well_typed")
        throw new Error("复现时目标未通过类型检查。");
    }
    const replayedDomain = [];
    for (const component of domainChecks) {
      const result =
        component.kind === "definition"
          ? await this.targetChecker(component.contract, { librarySnapshot })
          : await this.checker(component.contract, component.component.proof, {
              mode: "proof",
              librarySnapshot,
            });
      if (
        result.status !==
        (component.kind === "definition" ? "well_typed" : "verified")
      )
        throw new Error(`复现时辅助声明 ${component.component.name} 未通过。`);
      replayedDomain.push({
        name: component.component.name,
        kind: component.kind,
        result,
      });
    }
    const check = await this.checker(contract, proofArtifact.payload.proof, {
      mode: proofArtifact.payload.mode,
      librarySnapshot,
    });
    const semanticProbeReplays = [];
    for (const probe of saved.semanticReview?.semanticProbes || []) {
      const probeSnapshot =
        probe.check?.environment?.library?.snapshot?.id ||
        probe.check?.environment?.library?.content?.sha256;
      const result = await this.checker(probe.contract, probe.proof, {
        mode: "proof",
        librarySnapshot: probeSnapshot,
      });
      const sameEnvironment =
        digest(result.environment || null) ===
          digest(probe.check.environment || null) &&
        result.parser?.sourceSha256 === probe.check.parser?.sourceSha256;
      const stable =
        result.status === "verified" ||
        (result.status === "not_verified" &&
          ["proof_rejected", "syntax_rejected"].includes(result.failureKind) &&
          !result.termination);
      semanticProbeReplays.push({
        artifact: probe.artifact,
        result,
        sameEnvironment,
        reproduced:
          sameEnvironment &&
          stable &&
          result.status === probe.check.status &&
          result.sourceSha256 === probe.check.sourceSha256 &&
          result.exitCode === probe.check.exitCode,
        revalidated: result.status === "verified",
      });
    }
    const originalRouteReplay =
      saved.originalProofRoute?.summary?.status === "source_proof_missing"
        ? inspectSourceProofAbsence(
            new Map(bundle.artifacts.map((a) => [a.id, a])),
            saved.originalProofRoute.root,
            contract,
          )
        : saved.originalProofRoute?.root
          ? await (
              await import("./original-proof.mjs")
            ).replayOriginalProof(
              evidenceClosure(bundle, saved.originalProofRoute.root),
              saved.originalProofRoute.root,
              this.checker,
            )
          : null;
    const routeHasChecks = !!originalRouteReplay?.replayedChecks;
    if (
      saved.check?.environment?.ready &&
      check.environment?.ready &&
      saved.check.environment.binarySha256 !== check.environment.binarySha256
    )
      throw new Error("复现使用的 Lean 编译器摘要与原检查不同。");
    const conclusion = deriveConclusion({ ...saved, check });
    const sameEnvironment =
      digest(check.environment || null) ===
        digest(saved.check?.environment || null) &&
      check.parser?.sourceSha256 === saved.check?.parser?.sourceSha256;
    const sameOutcome =
      check.status === saved.check?.status &&
      check.sourceSha256 === saved.check?.sourceSha256 &&
      conclusion.theorem === saved.conclusion.theorem &&
      check.exitCode === saved.check?.exitCode;
    const stableCompletion =
      check.status === "verified" ||
      (check.status === "not_verified" &&
        ["syntax_rejected", "proof_rejected"].includes(check.failureKind) &&
        check.failureKind === saved.check?.failureKind &&
        Number.isInteger(check.exitCode) &&
        !check.termination &&
        !saved.check?.termination);
    return {
      schemaVersion: "lemma.replay.v1",
      sourceEvidenceRecheck,
      semanticProbeReplays,
      domainChecks: replayedDomain,
      root: bundle.root,
      check,
      conclusion,
      reproduced:
        sameEnvironment &&
        sameOutcome &&
        stableCompletion &&
        semanticProbeReplays.every((p) => p.reproduced) &&
        (!routeHasChecks || originalRouteReplay.reproduced),
      revalidated:
        check.status === "verified" &&
        conclusion.theorem !== "unknown" &&
        semanticProbeReplays.every((p) => p.reproduced) &&
        (!routeHasChecks || originalRouteReplay.revalidated),
      sameEnvironment:
        sameEnvironment &&
        semanticProbeReplays.every((p) => p.sameEnvironment) &&
        (!routeHasChecks || originalRouteReplay.sameEnvironment),
      originalRouteReplay,
      originalRouteFullyVerified: !!(
        routeHasChecks &&
        originalRouteReplay.revalidated &&
        originalRouteReplay.allStepsVerified
      ),
      modelReplay:
        "未重新请求模型；使用归档输入输出和同一固定目标重新运行检查。",
    };
  }
}
