import { executionContext } from "./execution-context.mjs";
import {
  MODEL_RUNTIME,
  domainProvingBudget,
  LEAN_RUNTIME,
} from "./runtime-limits.mjs";
import { modelOutputTokens } from "./model.mjs";
import { validateAlignment } from "./semantics.mjs";
import { receivedLibraries } from "./execution-libraries.mjs";
import { randomUUID } from "node:crypto";
import {
  createContract,
  validateContract,
  validateProposal,
  text,
  validateLeanText,
  MAX_PROOF_CHARACTERS,
  withExternalLibraries,
  normalize,
} from "./contracts.mjs";
import { digest } from "./evidence.mjs";
import {
  validateDomainPlan,
  orderedComponents,
  dependencyContext,
  DOMAIN_LIMITS,
  preserveDomainPlan,
} from "./domain-schema.mjs";
import { moduleManifest, ensureDomainModules } from "./domain-library.mjs";
import { anchorInContext } from "./context.mjs";
import { MATHLIB_COMMIT, libraryProfile } from "../shared/library-profiles.mjs";
import { diagnose, proofDiff } from "./repair.mjs";
import { searchPremises } from "./premise-index.mjs";
import { PROVING_BUDGET } from "./proving-engine.mjs";

const planPrompt = `你负责领域知识补全。只返回 JSON：{queries:["英文检索词"],modules:["Mathlib.X.Y"],definitions:[{name:"大写开头ASCII名称",type:"完整 Lean 类型项",value:"完整 Lean 定义项",meaning:"对应的数学含义",anchors:[{pageIndex:0,quote:"逐字唯一原文"}],dependsOn:["其他定义的短名"]}],lemmas:[{name:"大写开头ASCII名称",target:"完整 Prop",purpose:"为什么此引理有助于目标",dependsOn:["定义或引理短名"],proof:"可选证明项"}]}。补充声明用 LemmaPaper.Name 引用。可在 modules 中补充检索到的固定版本 Mathlib 模块，不受默认 profile.imports 清单限制；系统会检查模块身份、准备缓存并验证声明。不能使用任意代码命令。定义不得增添论文假设或改变对象/量词；论文明确给出的定义可以按原文补写为 definitions，这正是本流程的职责，不属于杜撰；非论文定义不能伪装成原文定义。没有现成同名库定义，不构成拒绝补写的理由。先给出有依据的最小定义及目标方案，暂时没有可用辅助引理时 lemmas 可以为空，主证明留给后续步骤；未知声明或无法忠实表达仍须明确返回 unavailable。引理必须逐个证明，不作为假设。依赖关系显式声明，无循环；最多${DOMAIN_LIMITS.modules}模块、${DOMAIN_LIMITS.definitions}定义、${DOMAIN_LIMITS.lemmas}引理。若没有现存固定命题，方案还必须提供 proposal，其字段为 label、quote(选中页原文)、statement、assumptions、leanTarget、ambiguity、alignment(覆盖variables/quantifiers/domain/assumptions/conclusion/definitions，每项explanation、leanFragment和anchors；不适用用notApplicable:true)。已有目标时不得更改目标或假设。对无法补齐之处返回 {unavailable:"具体原因"}，不能以 True、额外前提或虚构声明替代。`;
export const immutableProposal = (proposal, old, source, focusQuote = null) => {
  const validated = validateProposal(proposal, source);
  if (focusQuote && normalize(validated.quote) !== normalize(focusQuote))
    throw Error(
      "领域补全改变了选定的论证范围；必须保留 selectedQuote 对应的原命题。",
    );
  if (
    old &&
    Object.entries(validated).some(([k, v]) => digest(v) !== digest(old[k]))
  )
    throw new Error(
      "补全不能修改已经固定的命题、引句或前提；请另建目标并重新审核。",
    );
};
const checkAccepted = (result, contract, mode = "proof") =>
  result?.status === "verified" &&
  result.targetHash === contract.targetHash &&
  result.mode === mode &&
  result.exitCode === 0 &&
  !result.termination &&
  Array.isArray(result.axioms) &&
  result.axioms.every((a) => contract.allowedAxioms.includes(a));
export async function recoverDomain(pipeline, id, input, internal = {}) {
  return pipeline.reserve(async () => {
    if (
      !input ||
      !["manual", "model"].includes(input.mode) ||
      Object.keys(input).some((k) => !["mode", "plan", "queries"].includes(k))
    )
      throw new Error("领域补全请求无效。");
    const previous = await pipeline.store.getRun(id);
    if (
      ["preparing", "running"].includes(previous.status) ||
      !previous.sourceArtifact ||
      !previous.contextArtifact
    )
      throw new Error("请先完成论文和上下文读取，再补全领域。");
    if ((previous.domainRecovery?.generation || 0) >= DOMAIN_LIMITS.generations)
      throw new Error(
        `同一补全链最多 ${DOMAIN_LIMITS.generations} 代，请核对当前缺口后另建评审。`,
      );
    if (previous.contract) validateContract(previous.contract);
    const source = (await pipeline.store.get(previous.sourceArtifact)).payload;
    const context = (await pipeline.store.get(previous.contextArtifact))
      .payload;
    if (
      digest(context) !== digest(previous.context) ||
      context.paperSha256 !== previous.paperSha256 ||
      source.paperSha256 !== previous.paperSha256 ||
      (previous.contract &&
        digest(
          (await pipeline.store.get(previous.contractArtifact)).payload,
        ) !== digest(previous.contract))
    )
      throw new Error("原任务与固定材料不一致。");
    const plan = input.plan
      ? validateDomainPlan(
          preserveDomainPlan(previous.contract?.domainContext, input.plan),
          context,
        )
      : null;
    if (input.mode === "manual" && !plan)
      throw new Error("人工补全需要结构化方案。");
    if (plan?.proposal)
      immutableProposal(
        plan.proposal,
        previous.contract,
        source,
        previous.focusQuote,
      );
    if (!previous.contract && input.mode === "manual" && !plan?.proposal)
      throw new Error("原任务尚无固定目标，请在方案中补充 proposal。");
    const config = input.mode === "model" ? await pipeline.getConfig() : null;
    if (input.mode === "model" && !config)
      throw new Error("模型未配置，可使用人工补全方案。");
    const originInputs = [
      previous.sourceArtifact,
      previous.contextArtifact,
      ...(previous.contractArtifact ? [previous.contractArtifact] : []),
      ...(previous.root ? [previous.root] : []),
    ];
    const parentArtifact = await pipeline.store.put(
      "domain_parent",
      {
        id: previous.id,
        contract: previous.contract,
        status: previous.status,
        error: previous.error || null,
      },
      originInputs,
    );
    const run = {
      id: internal.runId || randomUUID(),
      continuedFrom: previous.id,
      ...(previous.parentReviewId
        ? {
            parentReviewId: previous.parentReviewId,
            parentTaskId: internal.parentTaskId || previous.parentTaskId,
          }
        : {}),
      mode: input.mode,
      proofStrategy: input.mode,
      autonomy: internal.autonomy || previous.autonomy || null,
      libraryProfile: previous.libraryProfile,
      status: "preparing",
      createdAt: new Date().toISOString(),
      pageIndex: previous.pageIndex,
      focusQuote: previous.focusQuote || null,
      propositionScope: previous.propositionScope || null,
      paperSha256: previous.paperSha256,
      sourceArtifact: previous.sourceArtifact,
      contextArtifact: previous.contextArtifact,
      context,
      tasks: [],
      contract: null,
      approval: null,
      originalProof: null,
      check: null,
      conclusion: null,
      root: null,
      domainRecovery: {
        parentArtifact,
        limits: {
          ...DOMAIN_LIMITS,
          elapsedMs: DOMAIN_LIMITS.elapsedMs,
          perCallCompletionTokens: modelOutputTokens(config, 8000),
        },
        generation: (previous.domainRecovery?.generation || 0) + 1,
        startedAt: new Date().toISOString(),
        modelCalls: 0,
        components: [],
        stage: "search",
      },
    };
    const controller = new AbortController();
    await pipeline.store.saveRun(run);
    pipeline.active.set(run.id, controller);
    pipeline.launch(
      run,
      perform(
        pipeline,
        run,
        previous,
        source,
        plan,
        input.queries,
        config,
        controller,
      ),
    );
    return run;
  });
}
async function perform(
  p,
  run,
  previous,
  source,
  providedPlan,
  requestedQueries,
  config,
  controller,
) {
  const r = run.domainRecovery;
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(r.limits.elapsedMs),
  ]);
  let plan, ctx;
  const purpose = {
    RDQ: "根据原命题和实际失败证据确定要补充的知识。",
    RDS: "查找固定数学库中的候选声明及其来源；尚不判定适用性。",
    RDP: "建立不改变原命题的模块、定义和辅助引理方案。",
    RDM: "核对补充模块的版本和源码摘要。",
    RDL: "准备固定模块的编译缓存，并保护正在执行的核验。",
    RDDC: "检查定义的类型与表达是否合法；语义忠实性另行复核。",
    RDDR: "将新定义与论文原文的对象、量词和条件对照。",
    RDLC: "独立重放辅助引理证明，并核对目标和允许公理。",
    RDPC: "重放原来失败的候选，检查补充环境是否解决问题；不自动批准新版本。",
    R03: "将原命题绑定到已检查的补充环境，保留原目标文本。",
    R05: "固定补充环境的新版本，等待语义确认。",
  };
  const task = (role, title, type, inputs, fn) =>
    p.task(run, role, title, type, inputs, async () => {
      const node = executionContext.getStore().task;
      node.reason = purpose[role] || title;
      node.agent =
        type === "model"
          ? "领域补全 Agent"
          : type === "lean_kernel" || role === "RDPC"
            ? "Lean 核验器"
            : ["RDS", "RDM", "RDL"].includes(role)
              ? "数学库工具"
              : "评审服务";
      await p.store.saveRun(run);
      signal.throwIfAborted();
      const result = await fn();
      signal.throwIfAborted();
      return result;
    });
  const call = async (role, system, input) => {
    signal.throwIfAborted();
    if (++r.modelCalls > r.limits.modelCalls)
      throw new Error("领域补全模型调用预算耗尽。");
    if (
      JSON.stringify(input).length >
      (r.limits.requestCharacters ?? DOMAIN_LIMITS.requestCharacters)
    )
      throw new Error("领域补全上下文超过单次预算。");
    const result = await p.model(
      {
        ...config,
        timeoutMs: Math.min(
          config?.timeoutMs || MODEL_RUNTIME.defaultTimeoutMs,
          r.limits.elapsedMs,
        ),
      },
      { role, system, input, signal, maxTokens: 8000 },
    );
    signal.throwIfAborted();
    if (result.parsed?.unavailable) {
      const e = new Error(
        text(result.parsed.unavailable, 3000, "补全受阻原因"),
      );
      e.modelRecord = result.record;
      throw e;
    }
    return result;
  };
  try {
    let queries = requestedQueries || providedPlan?.queries;
    if (!queries?.length && run.mode === "model" && !providedPlan) {
      const result = await task(
        "RDQ",
        "分析领域缺口与检索词",
        "model",
        [r.parentArtifact],
        () =>
          call(
            "RDQ",
            '从选定原文、目标和错误中提取最多八个相关数学库英文检索词。返回 {queries:["相关声明名或数学概念"]}。不下数学结论，不扩大选定命题范围。',
            {
              context: run.context,
              selectedQuote: run.focusQuote,
              contract: previous.contract,
              error: previous.error,
              check: previous.check?.stdout,
              proofSearchFailure: previous.provingSearch || null,
            },
          ),
      );
      queries = result.parsed.queries;
    }
    const search = await task(
      "RDS",
      "检索固定版本的完整数学库源码",
      "library_search",
      [r.parentArtifact],
      () =>
        searchPremises(queries || [], {
          signal,
          target: previous.contract?.leanTarget || "",
        }),
    );
    r.searchArtifact = p.taskReceipt(search).output;
    r.search = search;
    let planned,
      planFeedback = null;
    for (
      let attempt = 1;
      attempt <= (providedPlan ? 1 : DOMAIN_LIMITS.attempts);
      attempt++
    ) {
      try {
        planned = await task(
          "RDP",
          attempt === 1
            ? "建立模块、定义与引理补全方案"
            : "修正补全方案的结构与依赖",
          run.mode === "model" && !providedPlan ? "model" : "human_input",
          [
            r.parentArtifact,
            r.searchArtifact,
            ...(planFeedback ? [planFeedback.errorArtifact] : []),
          ],
          async () => {
            if (providedPlan) return { plan: providedPlan, origin: "human" };
            const result = await call(
              "RDP",
              planPrompt +
                "\n工具 install_library 可安装兼容的固定提交外部 Lean 模块。若确需使用本次工具实际安装的库，在最终 JSON 中添加 libraryIds:[安装工具返回的id]；不要把外部模块写入仅限 Mathlib 的 modules，也不得编造收据。可先用 inspect_modules 的 libraryIds 参数原生检查实际声明。类型通过不证明定义与论文语义等价。",
              {
                context: run.context,
                selectedPage: run.pageIndex,
                selectedQuote: run.focusQuote,
                contract: previous.contract,
                profile: libraryProfile(run.libraryProfile),
                search,
                error: previous.error,
                proofSearchFailure: previous.provingSearch || null,
                priorDomain: previous.contract?.domainContext || null,
                validationFeedback: planFeedback,
                schemaRules:
                  "name 仅填短名，不加 LemmaPaper. 前缀；dependsOn 仅列本方案中定义和引理的短名，Mathlib 已有声明无需放入 dependsOn。优先最小补库；有旧证明候选且只缺导入时可以令 definitions 和 lemmas 为空。selectedQuote 非空时 proposal.quote 必须与之完全一致，不得改选同页其他命题。只补充当前目标确实需要的定义。",
              },
            );
            try {
              const candidate = validateDomainPlan(
                preserveDomainPlan(
                  previous.contract?.domainContext,
                  result.parsed,
                ),
                run.context,
              );
              if (candidate.proposal)
                immutableProposal(
                  candidate.proposal,
                  previous.contract,
                  source,
                  run.focusQuote,
                );
              const alignmentRepairs = [];
              if (candidate.proposal)
                candidate.proposal.alignment = validateAlignment(
                  candidate.proposal.alignment,
                  {
                    leanTarget: candidate.proposal.leanTarget,
                    pageIndex: run.pageIndex,
                    quote: candidate.proposal.quote,
                  },
                  run.context,
                  alignmentRepairs,
                );
              // Module paths are part of the received plan. Reject fabricated
              // imports here so the bounded plan-repair loop gets the concrete
              // source error, rather than blocking later in acquisition.
              await moduleManifest(candidate.modules, { signal });
              const externalReceipts = await receivedLibraries(
                p.store,
                result.record,
                candidate.libraryIds || [],
              );
              return {
                plan: candidate,
                externalReceipts,
                alignmentRepairs,
                model: result.record,
              };
            } catch (error) {
              error.modelRecord = result.record;
              error.domainRecord = {
                invalidPlan: result.parsed,
                validationError: error.message,
              };
              error.domainPlanValidation = true;
              throw error;
            }
          },
        );
        break;
      } catch (error) {
        // Only a received, locally rejected plan may be repaired. Transport
        // failures and unknown external outcomes never enter this loop.
        if (!error.domainPlanValidation || attempt >= DOMAIN_LIMITS.attempts)
          throw error;
        planFeedback = {
          ...error.domainRecord,
          errorArtifact: error.pipelineTaskReceipt?.output || null,
        };
        await p.store.saveRun(run);
      }
    }
    r.planArtifact = p.taskReceipt(planned).output;
    plan = planned.plan;
    r.plan = plan;
    r.externalLibraryIds = (planned.externalReceipts || []).map((x) => x.id);
    if (plan.proposal)
      immutableProposal(
        plan.proposal,
        previous.contract,
        source,
        run.focusQuote,
      );
    const modules = await task(
      "RDM",
      "固定新增模块的源码版本",
      "source_identity",
      [r.planArtifact],
      () => moduleManifest(plan.modules, { signal }),
    );
    const manifestArtifact = p.taskReceipt(modules).output;
    r.stage = "library";
    r.library = await task(
      "RDL",
      "准备固定版本模块与编译缓存",
      "library_acquisition",
      [manifestArtifact],
      () => ensureDomainModules(modules, { signal }),
    );
    r.libraryArtifact = p.taskReceipt(r.library).output;
    ctx = {
      schemaVersion: "lemma.domain.v1",
      revision: MATHLIB_COMMIT,
      modules,
      definitions: [],
      lemmas: [],
    };
    let proposal = previous.contract
      ? (await p.store.get(previous.translationArtifact)).payload.proposal
      : plan.proposal;
    if (!proposal) throw new Error("补全方案未提供可核对的命题。");
    immutableProposal(proposal, previous.contract, source, run.focusQuote);
    const provenance = {
      contextArtifact: run.contextArtifact,
      translationArtifact: previous.translationArtifact || r.planArtifact,
    };
    const externalize = (base) => {
      if (previous.contract?.externalLibraries?.length) {
        const { targetHash, ...body } = base;
        const value = {
          ...body,
          schemaVersion: "lemma.contract.v5",
          externalLibraries: previous.contract.externalLibraries,
          imports: [
            ...body.imports,
            ...previous.contract.externalLibraries.flatMap((x) => x.modules),
          ],
        };
        base = validateContract({ ...value, targetHash: digest(value) });
      }
      return (planned.externalReceipts || []).length
        ? withExternalLibraries(base, planned.externalReceipts)
        : base;
    };
    const componentContract = (target, context) =>
      externalize(
        createContract(
          { ...source, artifact: run.sourceArtifact },
          { ...proposal, leanTarget: target },
          run.libraryProfile,
          provenance,
          { context, artifact: r.planArtifact },
        ),
      );
    for (const entry of orderedComponents(plan)) {
      signal.throwIfAborted();
      r.stage = entry.kind === "definition" ? "definitions" : "lemmas";
      const { kind, ...initial } = entry;
      const component = { ...initial };
      const record = {
        name: entry.name,
        kind,
        dependsOn: entry.dependsOn,
        attempts: [],
        status: "pending",
      };
      r.components.push(record);
      const dependencies = [
        r.planArtifact,
        r.libraryArtifact,
        ...r.components
          .filter((c) => entry.dependsOn.includes(c.name))
          .map((c) => c.finalArtifact)
          .filter(Boolean),
      ];
      const ancestors = dependencyContext(ctx, entry);
      const seen = new Set();
      let last = null;
      if (kind === "lemma" && run.mode === "model" && p.prover) {
        const contract = componentContract(component.target, ancestors);
        const left =
          r.limits.elapsedMs - (Date.now() - Date.parse(r.startedAt));
        if (left < 1) throw Error("领域补全时间预算耗尽。");
        let latest = dependencies.at(-1),
          unknownModel = null;
        const search = await p.prover.prove(contract, {
          config,
          signal,
          mode: "proof",
          context: {
            purpose: component.purpose,
            paperContext: run.context,
            dependencyContext: ancestors,
          },
          initialCandidate: component.proof
            ? {
                proof: component.proof,
                mode: "proof",
                origin: "domain_plan_candidate",
              }
            : null,
          budget: domainProvingBudget(
            p.provingBudget,
            r.limits,
            left,
            r.modelCalls,
          ),
          reserveModel: async () => {
            if (r.modelCalls >= r.limits.modelCalls)
              throw Error("领域补全模型调用预算耗尽。");
            await p.reserveProverModel(run);
            r.modelCalls++;
            await p.store.saveRun(run);
          },
          step: async (kind, title, action) => {
            const value = await task(
              "RDLS",
              `辅助引理 ${entry.name} · ${title}`,
              ["generate", "tactics", "project_plan", "helper_model"].includes(
                kind,
              )
                ? "model"
                : [
                      "kernel",
                      "project_kernel",
                      "helper_kernel",
                      "helper_connection",
                    ].includes(kind)
                  ? "lean_kernel"
                  : "proof_search",
              [...dependencies, ...(latest ? [latest] : [])],
              action,
            );
            const node = p.taskReceipt(value);
            node.agent = [
              "kernel",
              "project_kernel",
              "helper_kernel",
              "helper_connection",
            ].includes(kind)
              ? "Lean 核验器"
              : [
                    "generate",
                    "tactics",
                    "project_plan",
                    "helper_model",
                  ].includes(kind)
                ? "证明构造 Agent"
                : "引理核查 Agent";
            node.reason = `核查辅助引理 ${entry.name}，保留其已验证依赖。`;
            if (Array.isArray(value.goals))
              node.goalPreview = value.goals
                .slice(0, 3)
                .map((goal) => String(goal).slice(0, 1800));
            node.summary =
              value.status === "verified"
                ? ["project_kernel", "helper_connection"].includes(kind)
                  ? "条件连接已检查，内部引理仍须证明"
                  : "该辅助引理已通过 Lean 检查"
                : value.completed
                  ? "已找到候选，等待独立核验"
                  : value.reason || null;
            if (["unavailable", "tool_unavailable"].includes(value.status))
              node.status = "blocked";
            latest = node.output;
            if (value?.model?.error) unknownModel = value.model;
            await p.store.saveRun(run);
            return value;
          },
        });
        record.provingSearch = search.report;
        record.searchArtifact = await p.store.put(
          "domain_lemma_search",
          search.report,
          [...dependencies, ...(latest ? [latest] : [])],
        );
        dependencies.push(record.searchArtifact);
        if (
          !search.candidate?.proof ||
          !checkAccepted(search.check, contract)
        ) {
          record.status = "blocked";
          record.stopReason = search.report.stopReason;
          if (search.report.stopReason === "external_outcome_unknown")
            r.externalOutcomeUnknown = true;
          throw Object.assign(
            Error(
              `辅助引理 ${entry.name} 搜索未完成：${search.report.stopReason}`,
            ),
            unknownModel ? { modelRecord: unknownModel } : {},
          );
        }
        component.proof = search.candidate.proof;
      }
      for (
        let attempt = 1;
        attempt <= (run.mode === "model" ? DOMAIN_LIMITS.attempts : 1);
        attempt++
      ) {
        signal.throwIfAborted();
        let candidateModelArtifact = null;
        if (kind === "lemma" && (!component.proof || attempt > 1)) {
          if (run.mode === "model" && p.prover)
            throw Error("搜索与独立重放结果不一致，保留诊断后停止。");
          if (run.mode === "manual")
            throw new Error(`辅助引理 ${entry.name} 缺少证明项。`);
          const result = await task(
            "RDLP",
            `构造辅助引理 ${entry.name} · 第 ${attempt} 轮`,
            "model",
            [...dependencies, ...(last ? [last.checkArtifact] : [])],
            () => {
              if (run.mode !== "model")
                throw new Error(`辅助引理 ${entry.name} 缺少证明项。`);
              return call(
                "RDLP",
                '为固定辅助引理返回 {proof:"完整 Lean 证明项"}。只允许现有模块和 dependencyContext 中的 LemmaPaper 声明，不得修改目标、增加前提或声称未证的引理成立。根据上一轮 Lean 报错修复。',
                {
                  component: { ...component, proof: undefined },
                  dependencyContext: ancestors,
                  imports: componentContract(entry.target, ancestors).imports,
                  previous: last,
                },
              );
            },
          );
          candidateModelArtifact = p.taskReceipt(result).output;
          if (Object.keys(result.parsed).some((k) => k !== "proof"))
            throw new Error("引理修复不能修改目标或附加假设。");
          component.proof = validateLeanText(
            result.parsed.proof,
            "引理证明",
            MAX_PROOF_CHARACTERS,
          );
        } else if (kind === "definition" && attempt > 1) {
          const result = await task(
            "RDDF",
            `修复定义 ${entry.name} · 第 ${attempt} 轮`,
            "model",
            [...dependencies, last.checkArtifact],
            () =>
              call(
                "RDDF",
                '只返回 {type:"完整 Lean 类型项",value:"完整 Lean 定义项"}。修正编译错误，保留原文数学含义和依赖。不允许命令、新假设或未证明公理。修复后会重新复核定义含义。',
                {
                  component,
                  dependencyContext: ancestors,
                  context: run.context,
                  previous: last,
                },
              ),
          );
          candidateModelArtifact = p.taskReceipt(result).output;
          if (
            Object.keys(result.parsed).some(
              (k) => !["type", "value"].includes(k),
            )
          )
            throw new Error("定义修复包含未声明字段。");
          component.type = validateLeanText(
            result.parsed.type,
            "定义类型",
            LEAN_RUNTIME.helperTargetCharacters,
          );
          component.value = validateLeanText(
            result.parsed.value,
            "定义内容",
            LEAN_RUNTIME.helperTargetCharacters,
          );
        }
        const fingerprint = digest(component);
        if (seen.has(fingerprint)) {
          record.stopReason = "repeated_candidate";
          break;
        }
        seen.add(fingerprint);
        const candidate = await p.store.put(
          "domain_candidate",
          { component: { ...component }, kind, attempt },
          [
            ...dependencies,
            ...(candidateModelArtifact ? [candidateModelArtifact] : []),
          ],
        );
        const local =
          kind === "definition"
            ? {
                ...ancestors,
                definitions: [...ancestors.definitions, { ...component }],
              }
            : ancestors;
        const contract = componentContract(
          kind === "definition" ? "True" : component.target,
          local,
        );
        const checked = await task(
          kind === "definition" ? "RDDC" : "RDLC",
          `${kind === "definition" ? "检查定义" : "核验辅助引理"} ${entry.name} · 第 ${attempt} 轮`,
          "lean_kernel",
          [candidate, ...dependencies],
          async () => ({
            contract,
            result:
              kind === "definition"
                ? await p.targetChecker(contract, { signal })
                : await p.checker(contract, component.proof, {
                    mode: "proof",
                    signal,
                  }),
          }),
        );
        const checkArtifact = p.taskReceipt(checked).output;
        const okay =
          kind === "definition"
            ? checked.result.status === "well_typed" &&
              checked.result.targetHash === contract.targetHash
            : checkAccepted(checked.result, contract);
        const diagnostic =
          kind === "lemma"
            ? diagnose(checked.result)
            : {
                category: checked.result.status,
                message: `${checked.result.stdout || ""}\n${checked.result.stderr || ""}\n${checked.result.reason || ""}`,
                repairable: checked.result.status === "not_well_typed",
              };
        record.attempts.push({
          number: attempt,
          candidateArtifact: candidate,
          checkArtifact,
          status: checked.result.status,
          diagnostic,
          diff: proofDiff(
            last?.proof || last?.value,
            component.proof || component.value,
          ),
        });
        await p.store.saveRun(run);
        last = {
          proof: component.proof || null,
          value: component.value || null,
          diagnostic,
          checkArtifact,
        };
        if (okay) {
          record.status = "verified";
          record.finalArtifact = checkArtifact;
          record.component = { ...component };
          break;
        }
        if (!diagnostic.repairable) {
          record.stopReason = diagnostic.category;
          break;
        }
      }
      if (record.status !== "verified") {
        record.status = "blocked";
        record.stopReason ||= "candidate_budget";
        throw new Error(
          `补全 ${entry.name} 未通过检查；其依赖项及主证明尚未继续。`,
        );
      }
      if (kind === "definition") {
        const fidelity = await task(
          "RDDR",
          run.mode === "model"
            ? `独立复核定义 ${entry.name} 与原文`
            : `登记定义 ${entry.name} 的人工复核义务`,
          run.mode === "model" ? "model" : "human_review_pending",
          [record.finalArtifact, run.contextArtifact],
          async () => {
            if (run.mode === "manual")
              return {
                status: "human_review_required",
                explanation:
                  "类型检查不证明定义忠实，需在主目标确认时逐项核对。",
                componentHash: digest(component),
              };
            const result = await call(
              "RDDR",
              '独立核对新定义与原文的对象、量词、定义域、条件、空泛性，返回 {status:"aligned 或 concern 或 unresolved",explanation:"具体依据与差异",anchors:[{pageIndex:0,quote:"逐字唯一原文"}]}。类型通过不代表语义正确。',
              {
                definition: component,
                context: run.context,
                dependencyContext: ancestors,
              },
            );
            const value = result.parsed;
            if (
              !["aligned", "concern", "unresolved"].includes(value.status) ||
              !Array.isArray(value.anchors) ||
              !value.anchors.length ||
              value.anchors.length > 8
            )
              throw new Error("定义复核缺少有效状态或原文依据。");
            return {
              status: value.status,
              explanation: text(value.explanation, 3000, "定义复核"),
              anchors: value.anchors.map((a) =>
                anchorInContext(a, run.context),
              ),
              componentHash: digest(component),
              model: result.record,
            };
          },
        );
        record.fidelity = fidelity;
        record.fidelityArtifact = p.taskReceipt(fidelity).output;
        ctx.definitions.push({ ...component });
      } else ctx.lemmas.push({ ...component });
    }
    r.stage = "translation";
    const domainArtifact = await p.store.put(
      "domain_completion",
      {
        context: ctx,
        planArtifact: r.planArtifact,
        libraryArtifact: r.libraryArtifact,
        components: r.components,
        parentArtifact: r.parentArtifact,
      },
      [
        r.planArtifact,
        r.libraryArtifact,
        r.parentArtifact,
        ...r.components.flatMap((c) => [
          ...c.attempts.flatMap((a) => [a.candidateArtifact, a.checkArtifact]),
          ...(c.fidelityArtifact ? [c.fidelityArtifact] : []),
        ]),
      ],
    );
    r.completionArtifact = domainArtifact;
    const translated = await task(
      "R03",
      "在补充环境中绑定原命题",
      previous.contract ? "fixed_target_reuse" : "domain_proposal",
      [
        run.sourceArtifact,
        run.contextArtifact,
        domainArtifact,
        ...(previous.translationArtifact ? [previous.translationArtifact] : []),
      ],
      async () => ({
        proposal,
        origin: previous.contract ? "unchanged_previous_target" : run.mode,
        parentTargetHash: previous.contract?.targetHash || null,
      }),
    );
    run.translationArtifact = p.taskReceipt(translated).output;
    run.contract = await task(
      "R05",
      "固定领域补全后的新目标版本",
      "contract_validator",
      [
        run.sourceArtifact,
        run.contextArtifact,
        run.translationArtifact,
        domainArtifact,
      ],
      async () =>
        externalize(
          createContract(
            { ...source, artifact: run.sourceArtifact },
            proposal,
            run.libraryProfile,
            {
              contextArtifact: run.contextArtifact,
              translationArtifact: run.translationArtifact,
            },
            { context: ctx, artifact: domainArtifact },
          ),
        ),
    );
    run.contractArtifact = p.taskReceipt(run.contract).output;
    if (previous.proofArtifact && run.mode === "model" && p.prover) {
      const old = (await p.store.get(previous.proofArtifact)).payload;
      if (old.proof && ["proof", "counterexample"].includes(old.mode)) {
        run.seedProof = {
          proof: validateLeanText(
            old.proof,
            "待重放旧候选",
            MAX_PROOF_CHARACTERS,
          ),
          mode: old.mode,
          origin: "previous_unverified_candidate",
        };
        run.seedArtifact = await p.store.put(
          "recovered_proof_seed",
          run.seedProof,
          [previous.proofArtifact, run.contractArtifact],
        );
        const preview = await task(
          "RDPC",
          "检查补库后的原候选",
          "candidate_environment_check",
          [run.seedArtifact, run.contractArtifact],
          async () => {
            const result = await p.prover.prove(run.contract, {
              signal,
              mode: old.mode,
              initialCandidate: run.seedProof,
              budget: {
                maxElapsedMs: 60000,
                maxCandidates: 1,
                maxModelCalls: 0,
                maxTacticSteps: 0,
              },
            });
            const replay =
              result.check?.status === "verified"
                ? await p.checker(run.contract, run.seedProof.proof, {
                    mode: old.mode,
                    signal,
                  })
                : null;
            return {
              scope: "candidate_environment_only_pending_confirmation",
              targetHash: run.contract.targetHash,
              status:
                checkAccepted(result.check, run.contract, old.mode) &&
                checkAccepted(replay, run.contract, old.mode)
                  ? "candidate_verified_pending_confirmation"
                  : "candidate_unverified",
              result,
              replay,
            };
          },
        );
        r.preview = preview;
        r.previewArtifact = p.taskReceipt(preview).output;
        p.taskReceipt(preview).summary =
          preview.status === "candidate_verified_pending_confirmation"
            ? "原候选在新环境中通过检查，仍待确认该版本"
            : "原候选仍未通过，后续继续有限证明搜索";
      }
    }
    if (run.mode === "model" && r.modelCalls >= r.limits.modelCalls)
      throw new Error("补全预算耗尽，主目标翻译仍需重新复核。");
    if (run.mode === "model") r.modelCalls++;
    await p.reviewTranslation(run, translated, config, { signal });
    signal.throwIfAborted();
    r.stage = "awaiting_fresh_confirmation";
    run.status = "awaiting_confirmation";
  } catch (error) {
    run.status = controller.signal.aborted ? "cancelled" : "blocked";
    run.error =
      signal.aborted && !controller.signal.aborted
        ? "领域补全时间预算耗尽，未得出数学结论。"
        : error.message;
    r.stage = run.status;
    r.stopReason = run.error;
    for (const component of r.components)
      if (component.status === "pending") {
        component.status = run.status === "cancelled" ? "cancelled" : "blocked";
        component.stopReason = run.error;
      }
    run.pendingObligations = [
      {
        type:
          r.components.at(-1)?.kind === "lemma" ? "proof_step" : "definition",
        label: "领域补全未完成",
        pageIndex: run.pageIndex,
        quote: previous.contract?.quote || source.text.slice(0, 1000),
        statement: run.error,
      },
    ];
  }
  r.elapsedMs = Date.now() - Date.parse(r.startedAt);
  run.root = await p.store.put(
    "domain_recovery_report",
    {
      runId: run.id,
      status: run.status,
      paperSha256: run.paperSha256,
      contract: run.contract,
      recovery: r,
      mathematicalConclusion: "unknown",
    },
    [
      r.parentArtifact,
      ...run.tasks.map((t) => t.output).filter(Boolean),
      ...(r.completionArtifact ? [r.completionArtifact] : []),
    ],
  );
  await p.store.saveRun(run);
}
