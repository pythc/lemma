import {
  PROOF_RUNTIME,
  PROOF_CEILINGS,
  MODEL_RUNTIME,
  LEAN_RUNTIME,
} from "./runtime-limits.mjs";
import { ProverSession, proverCapabilities } from "./prover-session.mjs";
import { generateSpecialist, specialistStatus } from "./specialist-model.mjs";
import { checkProof } from "./lean.mjs";
import { callModel, MODEL_LIMITS } from "./model.mjs";
import {
  validateContract,
  validateLeanText,
  MAX_PROOF_CHARACTERS,
} from "./contracts.mjs";
import {
  proveDecomposition,
  hasUnknownProofOutcome,
} from "./proof-decomposition.mjs";
import { digest } from "./evidence.mjs";
import { diagnose } from "./repair.mjs";
import { retrieveKnowledge } from "./knowledge.mjs";
import { ResourcePool } from "./resource-pool.mjs";
import { libraryAccess } from "./library-access.mjs";
import { searchPremises } from "./premise-index.mjs";
import {
  missingDeclarationQueries,
  mergePremises,
} from "./proving-retrieval.mjs";

export const PROVING_BUDGET = PROOF_RUNTIME;
const searchPool = new ResourcePool(1);
const tactics = [
  "rfl",
  "simp_all",
  "assumption",
  "omega",
  "linarith",
  "nlinarith",
  "fun_prop",
  "positivity",
];
const proofPrompt =
  'For this immutable Lean 4.35.0 target, return JSON {mode:"proof",proof:"by ...",route:"independent",explanation:"brief evidence route"}. Use only the fixed imports. Do not change assumptions or target. No sorry, axioms, unsafe, imports, commands or self-reference. If impossible return {unavailable:"reason"}. Use the actual compiler diagnostic to repair the previous candidate.';
const tacticPrompt =
  'Return JSON {tactics:["one Lean tactic", "alternative tactic"]}, at most eight alternatives for the EXACT current Lean proof state. Preserve all coupled goals. Each alternative must be a tactic block, no by prefix, commands, new axioms, sorry, self-reference or unproved premise. Prefer applicable signatures from the supplied verified library context. Do not claim success.';

export function validateProvingBudget(value = {}) {
  const b = { ...PROVING_BUDGET, ...value };
  for (const [key, n] of Object.entries(b))
    if (!Number.isSafeInteger(n) || n < 0)
      throw Error(`Invalid proving budget ${key}`);
  if (
    b.maxElapsedMs < 1 ||
    b.maxElapsedMs > PROOF_CEILINGS.maxElapsedMs ||
    b.maxCandidates < 1 ||
    b.maxCandidates > PROOF_CEILINGS.maxCandidates ||
    b.maxModelCalls > PROOF_CEILINGS.maxModelCalls ||
    b.maxInputCharacters > PROOF_CEILINGS.maxInputCharacters ||
    b.maxCompletionTokens > PROOF_CEILINGS.maxCompletionTokens ||
    b.maxRequestCharacters < 1 ||
    b.maxRequestCharacters > PROOF_CEILINGS.maxRequestCharacters ||
    b.maxDecompositionPlans > PROOF_CEILINGS.maxDecompositionPlans ||
    b.maxDecompositionDepth > PROOF_CEILINGS.maxDecompositionDepth ||
    b.maxHelperParts < 1 ||
    b.maxHelperParts > PROOF_CEILINGS.maxHelperParts ||
    b.maxHelperModelCalls > PROOF_CEILINGS.maxHelperModelCalls ||
    b.maxTacticSteps > PROOF_CEILINGS.maxTacticSteps ||
    b.maxRestarts > PROOF_CEILINGS.maxRestarts ||
    b.perCallCompletionTokens < 1 ||
    b.perCallCompletionTokens > MODEL_LIMITS.outputTokens ||
    b.perStepMs < 1 ||
    b.perStepMs > PROOF_CEILINGS.perStepMs ||
    b.perSpecialistMs < 1 ||
    b.perSpecialistMs > PROOF_CEILINGS.perSpecialistMs
  )
    throw Error("Proving budget outside supported bounds");
  return b;
}

/** Produces candidates, then invokes the existing isolated checker. A completed
 * REPL state is never a verified result. All search imports are disposable. */
export class ProvingEngine {
  constructor({
    checker = checkProof,
    model = callModel,
    specialist = generateSpecialist,
    sessionFactory = (o) => new ProverSession(o),
    knowledge = retrieveKnowledge,
    capabilities = proverCapabilities,
    specialistAvailable = specialistStatus,
    sourceSearch = searchPremises,
  } = {}) {
    Object.assign(this, {
      checker,
      model,
      specialist,
      sessionFactory,
      knowledge,
      capabilities,
      specialistAvailable,
      sourceSearch,
    });
  }
  async prove(
    contract,
    {
      config,
      context = null,
      signal,
      mode = "proof",
      initialCandidate = null,
      initialDecomposition = null,
      preparedKnowledge = null,
      pathEstimate = null,
      budget: requested = {},
      step = async (_k, _t, fn) => fn(),
      reserveModel = async () => {},
    } = {},
  ) {
    validateContract(contract);
    if (!["proof", "counterexample"].includes(mode))
      throw Error("Invalid proving direction");
    if (
      initialDecomposition &&
      (initialDecomposition.rootTargetHash !== contract.targetHash ||
        hasUnknownProofOutcome(initialDecomposition))
    )
      throw Error(
        "Unmatched or unknown-outcome decomposition cannot be resumed automatically",
      );
    const budget = validateProvingBudget(requested),
      started = Date.now();
    signal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(budget.maxElapsedMs),
    ]);
    const report = {
      schemaVersion: "lemma.proving-search.v1",
      targetHash: contract.targetHash,
      mode,
      budget,
      startedAt: new Date(started).toISOString(),
      attempts: [],
      checkpoints: [],
      modelCalls: 0,
      tacticSteps: 0,
      reservedCompletionTokens: 0,
      inputCharacters: 0,
      restarts: 0,
      resumptions: 0,
      stopReason: null,
      route: "independent",
      originalProofCoverage: "not_established",
      environmentSuggestions: [],
      decomposition: null,
      budgetStop: null,
    };
    let session = null,
      checkpoint = null,
      previous = null,
      knowledge = { entries: [] },
      candidate = null,
      check = null;
    const seen = new Set();
    const lookedUp = new Set();
    let decompositionAttempted = false;
    const observeModelError = (e) => {
      if (
        e.modelRecord?.error?.code === "model_incomplete" &&
        e.modelRecord?.finishReason === "length"
      )
        report.stopReason = "model_output_budget";
      else if (
        e.modelRecord &&
        [
          "model_timeout",
          "model_transport_error",
          "model_nonfinal",
          "model_incomplete",
          "model_cancelled",
        ].includes(e.modelRecord.error?.code)
      )
        report.stopReason = "external_outcome_unknown";
    };
    const remaining = () =>
      Math.max(1, budget.maxElapsedMs - (Date.now() - started));
    const bounded = () =>
      !signal.aborted && report.attempts.length < budget.maxCandidates;
    const safeStep = async (kind, title, fn) =>
      step(kind, title, async () => {
        try {
          return await fn();
        } catch (e) {
          // A lost remote response does not authorize sending the same work
          // again. Local specialist processes are killed before they return.
          observeModelError(e);
          return {
            status: kind === "kernel" ? "tool_unavailable" : "unavailable",
            targetHash: contract.targetHash,
            mode,
            reason: e.message,
            detail: e.detail || null,
            model: e.modelRecord || e.specialistRecord || null,
          };
        }
      });
    const reserveUsage = async ({
      inputCharacters: chars,
      completionTokens,
    }) => {
      if (
        signal.aborted ||
        report.stopReason ||
        report.modelCalls >= budget.maxModelCalls ||
        report.reservedCompletionTokens + completionTokens >
          budget.maxCompletionTokens ||
        report.inputCharacters + chars > budget.maxInputCharacters ||
        chars > budget.maxRequestCharacters
      ) {
        report.budgetStop = {
          constraint:
            chars > budget.maxRequestCharacters
              ? "per_request_input"
              : report.inputCharacters + chars > budget.maxInputCharacters
                ? "total_input"
                : report.reservedCompletionTokens + completionTokens >
                    budget.maxCompletionTokens
                  ? "total_output"
                  : "model_calls_or_time",
          nextInputCharacters: chars,
          usedInputCharacters: report.inputCharacters,
        };
        return false;
      }
      await reserveModel({ inputCharacters: chars, completionTokens });
      report.modelCalls++;
      report.reservedCompletionTokens += completionTokens;
      report.inputCharacters += chars;
      return true;
    };
    const reserve = (input) =>
      reserveUsage({
        inputCharacters: JSON.stringify(input).length,
        completionTokens: budget.perCallCompletionTokens,
      });
    const verify = async (proposal) => {
      if (!bounded()) return false;
      try {
        validateLeanText(proposal.proof, "证明", MAX_PROOF_CHARACTERS);
      } catch (e) {
        report.attempts.push({ status: "rejected", reason: e.message });
        return false;
      }
      if (
        proposal.mode !== mode ||
        (proposal.targetHash && proposal.targetHash !== contract.targetHash)
      )
        throw Error("Candidate changed the immutable target");
      const key = digest({ proof: proposal.proof, mode });
      if (seen.has(key)) {
        report.attempts.push({ status: "duplicate", candidateHash: key });
        return false;
      }
      seen.add(key);
      candidate = await step("candidate", "保存待核验的证明", async () => ({
        ...proposal,
        mode,
        route: "independent",
        targetHash: contract.targetHash,
      }));
      check = await safeStep("kernel", "独立重放证明与公理审计", async () => {
        const checked = await this.checker(contract, candidate.proof, {
          mode,
          signal,
        });
        if (
          checked.status === "verified" &&
          (checked.targetHash !== contract.targetHash || checked.mode !== mode)
        )
          return {
            status: "tool_unavailable",
            targetHash: contract.targetHash,
            mode,
            reason: "Checker result identity mismatch",
          };
        return checked;
      });
      const diagnostic = diagnose(check);
      report.attempts.push({
        number: report.attempts.length + 1,
        candidateHash: key,
        origin: proposal.origin || "reader_model",
        status: check.status,
        diagnostic,
        elapsedMs: Date.now() - started,
      });
      previous = { proof: candidate.proof, mode, diagnostic };
      // Require the checker identity to agree; search responses cannot set this.
      if (
        check.status === "verified" &&
        check.targetHash === contract.targetHash &&
        check.mode === mode
      ) {
        report.stopReason = "verified";
        return true;
      }
      if (!diagnostic.repairable) report.stopReason = diagnostic.category;
      return false;
    };
    const saveCheckpoint = async () => {
      checkpoint = session.checkpoint();
      report.checkpoints.push(checkpoint.checkpointHash);
      await step("checkpoint", "保存当前证明进度", async () => checkpoint);
    };
    const open = async (resume = false) => {
      await session?.close();
      session = this.sessionFactory({
        signal,
        perStepMs: Math.min(budget.perStepMs, remaining()),
      });
      const result = await safeStep(
        "session",
        resume ? "恢复上次证明进度" : "建立交互式证明目标",
        async () => {
          const created = await session.create(contract, { mode });
          if (resume && checkpoint) {
            report.resumptions++;
            return session.resume(checkpoint);
          }
          return created;
        },
      );
      if (result.status === "unavailable") {
        await session.close();
        session = null;
        return false;
      }
      return true;
    };
    const withSession = (fn) =>
      searchPool.run(
        () =>
          libraryAccess.read(
            async () => {
              try {
                return await fn();
              } finally {
                // Release the actual process, not just the scheduling slot. Checkpoints
                // retain progress while whole-proof models run or other claims wait.
                if (session?.closed) {
                  if (report.restarts >= budget.maxRestarts) checkpoint = null;
                  else report.restarts++;
                }
                await session?.close();
                session = null;
              }
            },
            { signal },
          ),
        { signal },
      );
    try {
      if (initialCandidate?.proof) {
        await verify({
          ...initialCandidate,
          mode: initialCandidate.mode || mode,
        });
        if (report.stopReason) return { candidate, check, report };
      }
      knowledge =
        preparedKnowledge?.targetHash === contract.targetHash
          ? preparedKnowledge
          : await safeStep("premises", "检索当前版本可用定理", () =>
              this.knowledge(contract, { signal }),
            );
      if (!knowledge.entries) knowledge.entries = [];
      const coldCost = pathEstimate
        ? pathEstimate.native.preparation.ms +
          pathEstimate.native.bootstrap.ms +
          pathEstimate.native.kernel.ms +
          pathEstimate.modelMs
        : null;
      const deferInteractive = !!(
        config &&
        budget.maxModelCalls > 0 &&
        coldCost !== null &&
        remaining() < coldCost
      );
      report.pathDecision = {
        coldCost,
        remainingMs: remaining(),
        strategy: deferInteractive
          ? "bounded_candidate_before_cold_interactive_setup"
          : "interactive_then_candidate",
        estimate: pathEstimate,
      };
      const capabilities = deferInteractive
        ? {
            ready: false,
            reason:
              "Cold setup would consume candidate and final-check capacity; try one bounded candidate first.",
          }
        : await this.capabilities();
      if (capabilities.ready && budget.maxTacticSteps > 0) {
        // Only independent claims use separate workers. Goals within this state
        // stay together, because Lean metavariables can be shared.
        await withSession(async () => {
          if (!(await open())) return;
          const queries = [
            ...new Set(
              (contract.leanTarget.match(/[A-Z][A-Za-z0-9_.]{2,}/g) || []).map(
                (s) => s.split(".").at(-1),
              ),
            ),
          ].slice(0, 8);
          if (queries.length) {
            const indexed = await safeStep(
              "premises",
              "查询当前 Lean 环境中的相关定理",
              () => session.queryPremises(queries),
            );
            knowledge.entries = mergePremises(
              knowledge.entries,
              (indexed.entries || []).map((e) => ({
                ...e,
                environmentHash: session.environmentHash,
                verifiedInEnvironment: true,
                sourceOrigin: "live_pinned_lean_environment",
              })),
            );
          }
          await saveCheckpoint();
          report.tacticSteps++;
          const result = await safeStep(
            "search",
            "用 LeanCopilot 与 Aesop 搜索证明",
            () => session.runSearch(tactics),
          );
          if (result.completed && result.exportable !== false) {
            const exported = await safeStep(
              "export",
              "提取可重放的证明脚本",
              async () => session.exportCandidate(),
            );
            if (exported.proof) await verify(exported);
          }
          // Always return to the target before model-driven repairs.
          if (!report.stopReason && session && !session.closed)
            await session.rollback(session.initialState);
        });
      } else
        await step(
          "session",
          "交互式证明环境暂不可用",
          async () => capabilities,
        );
      if (report.stopReason) return { candidate, check, report };
      const specialized = deferInteractive
        ? {
            ready: false,
            reason: "configured_model_selected_within_bounded_path",
          }
        : await this.specialistAvailable();
      for (
        let round = 0;
        bounded() && report.modelCalls < budget.maxModelCalls;
        round++
      ) {
        const input = {
          contract,
          context,
          knowledge: knowledge.entries,
          previous,
          partialProgress: checkpoint
            ? {
                journal: checkpoint.journal,
                goals: checkpoint.goals,
                checkpointHash: checkpoint.checkpointHash,
              }
            : null,
        };
        const resumeProject =
          round === 0 &&
          initialDecomposition &&
          budget.maxDecompositionPlans > 0 &&
          budget.maxDecompositionDepth > 0 &&
          config &&
          mode === "proof";
        let generated,
          useSpecialist = false;
        if (resumeProject)
          generated = {
            unavailable:
              "Resume the archived incomplete decomposition; recheck all cached proof obligations.",
          };
        else {
          if (!(await reserve(input))) {
            report.stopReason = "model_budget";
            break;
          }
          // Prefer the user's configured model when available; the slower local
          // specialist remains a bounded alternative after a failed candidate.
          useSpecialist =
            specialized.ready && (!config || (round >= 2 && round % 2 === 0));
          generated = await safeStep(
            "generate",
            useSpecialist ? "专用证明模型构造候选" : "根据核验结果修复证明",
            async () => {
              if (useSpecialist)
                return this.specialist(contract, {
                  mode,
                  previous,
                  premises: knowledge.entries,
                  signal,
                  maxTokens: Math.min(
                    budget.perCallCompletionTokens,
                    LEAN_RUNTIME.specialistOutputTokens,
                  ),
                  timeoutMs: Math.min(budget.perSpecialistMs, remaining()),
                  seed: Math.floor(round / 2),
                });
              const r = await this.model(
                {
                  ...config,
                  maxOutputTokens: Math.min(
                    config?.maxOutputTokens || budget.perCallCompletionTokens,
                    budget.perCallCompletionTokens,
                  ),
                  timeoutMs: Math.min(
                    config?.timeoutMs || MODEL_RUNTIME.defaultTimeoutMs,
                    remaining(),
                  ),
                },
                {
                  role: "R09",
                  system: proofPrompt.replace('mode:"proof"', `mode:"${mode}"`),
                  input: { ...input, requiredMode: mode },
                  signal,
                  maxTokens: budget.perCallCompletionTokens,
                },
              );
              const p = r.parsed;
              if (
                Object.keys(p).some(
                  (k) =>
                    ![
                      "proof",
                      "mode",
                      "route",
                      "explanation",
                      "unavailable",
                    ].includes(k),
                )
              )
                throw Object.assign(
                  Error("Candidate attempted to change the contract"),
                  { modelRecord: r.record },
                );
              return {
                ...p,
                origin: config?.model || "configured_model",
                record: r.record,
              };
            },
          );
        }
        // An explicit completed truncation can change strategy under the same
        // total budget. Unknown transport outcomes still stop all dispatch.
        if (
          report.stopReason === "model_output_budget" &&
          budget.maxDecompositionDepth > 0 &&
          budget.maxDecompositionPlans > 0 &&
          config &&
          mode === "proof" &&
          budget.maxModelCalls - report.modelCalls >= 3
        ) {
          report.stopReason = null;
          generated.unavailable =
            "The complete response reached its declared output cap. Split the mathematical obligation into smaller parts instead of repeating this generation.";
        }
        if (report.stopReason) break;
        if (generated.proof) {
          if (await verify(generated)) break;
          if (report.stopReason) break;
        } else {
          previous = {
            ...previous,
            generationFailure:
              generated.reason || generated.unavailable || "No candidate",
          };
          report.attempts.push({
            status: resumeProject
              ? "resumed_decomposition"
              : "generation_unavailable",
            origin: useSpecialist ? "specialist" : "reader_model",
            reason: previous.generationFailure,
          });
        }
        if (
          !decompositionAttempted &&
          budget.maxDecompositionPlans > 0 &&
          budget.maxDecompositionDepth > 0 &&
          config &&
          mode === "proof" &&
          (resumeProject || budget.maxModelCalls - report.modelCalls >= 3) &&
          (previous?.generationFailure ||
            previous?.diagnostic?.category === "unsolved_goals")
        ) {
          decompositionAttempted = true;
          const project = await proveDecomposition({
            root: contract,
            context,
            failure: previous,
            premises: knowledge.entries.slice(0, 24),
            budget,
            signal,
            step,
            remaining,
            reserve,
            resume: initialDecomposition,
            model: (system, input) =>
              this.model(
                {
                  ...config,
                  maxOutputTokens: Math.min(
                    config?.maxOutputTokens || budget.perCallCompletionTokens,
                    budget.perCallCompletionTokens,
                  ),
                  timeoutMs: Math.min(
                    config.timeoutMs || MODEL_RUNTIME.defaultTimeoutMs,
                    remaining(),
                  ),
                },
                {
                  role: "R09_DECOMPOSE",
                  system,
                  input,
                  signal,
                  maxTokens: budget.perCallCompletionTokens,
                },
              ),
            checker: this.checker,
            childProve: async (target, options) => {
              const result = await this.prove(target, options);
              report.tacticSteps += result.report.tacticSteps;
              return result;
            },
            available: () => ({
              config,
              modelCalls: Math.max(0, budget.maxModelCalls - report.modelCalls),
              completionTokens: Math.max(
                0,
                budget.maxCompletionTokens - report.reservedCompletionTokens,
              ),
              inputCharacters: Math.max(
                0,
                budget.maxInputCharacters - report.inputCharacters,
              ),
              tacticSteps: Math.max(
                0,
                budget.maxTacticSteps - report.tacticSteps,
              ),
              reserve: async (usage) => {
                if (!(await reserveUsage(usage)))
                  throw Error(
                    "Shared proof-project budget exhausted before dispatch",
                  );
              },
            }),
          });
          report.decomposition = project.report;
          previous = {
            ...previous,
            decompositionFeedback: {
              status: project.report.status,
              helpers: project.report.helpers.map((h) => ({
                name: h.name,
                target: h.target,
                dependsOn: h.dependsOn,
                status: h.status,
                proof: h.proof || null,
                diagnostic: h.report?.attempts?.at(-1)?.diagnostic || null,
              })),
              failure: project.report.failure
                ? {
                    category: project.report.failure.category,
                    reason: project.report.failure.reason,
                    helper: project.report.failure.helper,
                    check: project.report.failure.check
                      ? {
                          status: project.report.failure.check.status,
                          stdout: project.report.failure.check.stdout?.slice(
                            0,
                            6000,
                          ),
                        }
                      : null,
                  }
                : null,
            },
          };
          if (project.report.status === "external_outcome_unknown") {
            report.stopReason = "external_outcome_unknown";
            break;
          }
          if (
            project.proof &&
            (await verify({
              proof: project.proof,
              mode,
              origin: "verified_helper_composition",
            }))
          )
            break;
          if (report.stopReason) break;
        }
        if (
          !bounded() ||
          !checkpoint ||
          !config ||
          report.modelCalls >= budget.maxModelCalls
        )
          continue;
        // One bounded tactic-refinement round, with rollback for alternatives.
        await withSession(async () => {
          if (!(await open(true))) return;
          const queries = missingDeclarationQueries(previous?.diagnostic);
          const lookupKey = digest(queries);
          if (queries.length && !lookedUp.has(lookupKey)) {
            lookedUp.add(lookupKey);
            const resolved = await safeStep(
              "premises",
              "按实际报错查找可用定理",
              () => session.queryPremises(queries),
            );
            knowledge.entries = mergePremises(
              knowledge.entries,
              (resolved.entries || []).map((entry) => ({
                ...entry,
                environmentHash: session.environmentHash,
                verifiedInEnvironment: true,
                sourceOrigin: "live_pinned_lean_environment",
              })),
            );
            const source = await safeStep(
              "premises",
              "核对缺失声明的固定版本源码",
              () =>
                this.sourceSearch(queries, {
                  signal,
                  limit: 8,
                  target: contract.leanTarget,
                }),
            );
            // A source hit is a proposal, never permission to add imports to
            // this target. Environment changes require a new reviewed contract.
            const suggestions = (source.matches || []).map((match) => ({
              ...match,
              availableInCurrentEnvironment: "not_established",
              requiresNewContract: !contract.imports.includes(match.module),
            }));
            report.environmentSuggestions.push({
              queries,
              matches: suggestions,
            });
            previous = {
              ...previous,
              declarationLookup: {
                queries,
                currentEnvironmentStatus: resolved.status,
                sourceCandidates: suggestions,
                instruction:
                  "Source candidates are not verified premises; retain the fixed imports and target.",
              },
            };
            // A declaration that exists in pinned source but is absent from
            // the live environment needs an import review, not increasingly
            // long proof generations against the same unavailable name.
            const missingImport = suggestions.some(
              (match) =>
                match.name &&
                queries.includes(match.name) &&
                match.requiresNewContract &&
                !(resolved.entries || []).some(
                  (entry) => entry.name === match.name,
                ),
            );
            if (missingImport) {
              report.stopReason = "environment_extension_required";
              return;
            }
          }
          const state = await safeStep("goals", "检查尚未完成的证明目标", () =>
            session.inspectGoal(),
          );
          if (!state.goals) return;
          const tacticInput = {
            targetHash: contract.targetHash,
            goals: state.goals,
            premises: knowledge.entries,
            diagnostic: previous?.diagnostic,
            declarationLookup: previous?.declarationLookup,
          };
          if (!(await reserve(tacticInput))) return;
          const plan = await safeStep(
            "tactics",
            "根据当前目标选择下一步策略",
            async () => {
              const r = await this.model(
                {
                  ...config,
                  maxOutputTokens: Math.min(
                    config?.maxOutputTokens || budget.perCallCompletionTokens,
                    budget.perCallCompletionTokens,
                  ),
                  timeoutMs: Math.min(
                    config.timeoutMs || MODEL_RUNTIME.defaultTimeoutMs,
                    remaining(),
                  ),
                },
                {
                  role: "R09_TACTIC",
                  system: tacticPrompt,
                  input: tacticInput,
                  signal,
                  maxTokens: budget.perCallCompletionTokens,
                },
              );
              if (
                !Array.isArray(r.parsed.tactics) ||
                r.parsed.tactics.length > 8
              )
                throw Object.assign(Error("Invalid tactic alternatives"), {
                  modelRecord: r.record,
                });
              return { tactics: r.parsed.tactics, record: r.record };
            },
          );
          if (!plan.tactics) return;
          const origin = state.state;
          for (const tactic of plan.tactics) {
            if (!bounded() || report.tacticSteps >= budget.maxTacticSteps)
              break;
            report.tacticSteps++;
            const applied = await safeStep("tactic", "尝试下一步推导", () =>
              session.applyTactic(tactic, { state: origin }),
            );
            if (applied.status === "unavailable") break;
            if (applied.completed) {
              const exported = await safeStep(
                "export",
                "提取完整证明",
                async () => session.exportCandidate(),
              );
              if (exported.proof && (await verify(exported))) break;
            } else if (
              applied.status === "advanced" &&
              digest(applied.goals) !== digest(state.goals)
            ) {
              await saveCheckpoint();
              break;
            }
            await session.rollback(origin);
          }
        });
        if (report.stopReason) break;
      }
      report.stopReason ||= signal.aborted
        ? "cancelled_or_time_budget"
        : report.attempts.length >= budget.maxCandidates
          ? "candidate_budget"
          : "model_budget";
    } catch (e) {
      observeModelError(e);
      if (e.decompositionReport) report.decomposition = e.decompositionReport;
      report.stopReason ||= signal.aborted
        ? "cancelled_or_time_budget"
        : "execution_error";
      report.error = e.message;
    } finally {
      await session?.close();
      report.elapsedMs = Date.now() - started;
    }
    return { candidate, check, report };
  }
}
