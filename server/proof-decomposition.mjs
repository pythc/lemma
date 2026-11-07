import { HELPER_PATTERN } from "../shared/agent-tool-fields.mjs";
import { PROOF_RUNTIME, LEAN_RUNTIME } from "./runtime-limits.mjs";
import { digest } from "./evidence.mjs";
import {
  validateContract,
  validateLeanText,
  normalize,
  MAX_PROOF_CHARACTERS,
} from "./contracts.mjs";

export const decompositionPrompt = `Split the EXACT fixed Lean goal into a small dependency DAG of genuinely smaller, closed, fully quantified propositions. Return JSON {parts:[{name:"ShortName",target:"Lean Prop",purpose:"concrete mathematical role",dependsOn:["ShortName"],proof:"optional complete proof of the dependency-quantified target"}],assembly:"complete Lean proof term"}. No new imports, definitions, axioms, sorry, commands, or changed root assumptions. A part's dependency-quantified target is ∀ (ProofPart_Dep : (dependency target)), ..., (part target), in dependsOn order. assembly proves ∀ (ProofPart_Name : (part target)), ... in the supplied parts' topological order, (EXACT root target). These parameters are conditional obligations, not accepted facts: every part will be independently proved, then the complete root proof replayed. Use source proof steps and actual diagnostics; do not repeat the root theorem as a part. Do not bundle independent cases into one large conjunction. Eliminating one disjunction is not an adequate response to a failed long proof: split the internal inequalities, transformations, finite rearrangements or limit estimates that the source argument actually needs. Missing a same-named library theorem is not a mathematical obstruction; construct these intermediate results. Limit parts to the supplied maximum. Keep already verified part targets and dependencies unchanged. For an invalid/failed plan, repair the concrete compiler error rather than restating the same plan. Return {unavailable:"specific missing mathematical step"} only when no faithful decomposition can be given.`;

export function hasUnknownProofOutcome(project, seen = new Set()) {
  if (!project || seen.has(project)) return false;
  seen.add(project);
  return (
    project.status === "external_outcome_unknown" ||
    (project.helpers || []).some(
      (h) =>
        h.report?.stopReason === "external_outcome_unknown" ||
        hasUnknownProofOutcome(h.report?.decomposition, seen),
    )
  );
}

const namePattern = new RegExp(HELPER_PATTERN);
const onlyFields = (v, allowed) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !allowed.includes(k))
  )
    throw Error("Invalid decomposition fields");
};
export function validateDecomposition(
  raw,
  root,
  maxParts = PROOF_RUNTIME.maxHelperParts,
) {
  onlyFields(raw, ["parts", "assembly"]);
  if (
    !Array.isArray(raw.parts) ||
    !raw.parts.length ||
    raw.parts.length > maxParts
  )
    throw Error("Invalid decomposition size");
  const parts = raw.parts.map((p) => {
    onlyFields(p, ["name", "target", "purpose", "dependsOn", "proof"]);
    if (typeof p.name !== "string" || !namePattern.test(p.name))
      throw Error(
        "Invalid helper name: use 1-48 ASCII letters/digits/underscore, uppercase first; no dots, e.g. RankBound",
      );
    if (
      typeof p.purpose !== "string" ||
      !p.purpose.trim() ||
      p.purpose.length > 1200
    )
      throw Error(
        "Invalid helper purpose: provide a nonempty mathematical role of at most 1200 characters",
      );
    if (
      !Array.isArray(p.dependsOn) ||
      p.dependsOn.length > maxParts ||
      new Set(p.dependsOn).size !== p.dependsOn.length ||
      p.dependsOn.some((n) => !namePattern.test(n))
    )
      throw Error("Invalid helper dependencies");
    const target = validateLeanText(
      p.target,
      "辅助命题",
      LEAN_RUNTIME.helperTargetCharacters,
    );
    if (normalize(target) === normalize(root.leanTarget))
      throw Error("A helper must not repeat the root target");
    return {
      name: p.name,
      target,
      purpose: p.purpose,
      dependsOn: [...p.dependsOn],
      ...(p.proof
        ? { proof: validateLeanText(p.proof, "辅助候选", MAX_PROOF_CHARACTERS) }
        : {}),
    };
  });
  const byName = new Map(parts.map((p) => [p.name, p]));
  if (byName.size !== parts.length) throw Error("Duplicate helper name");
  const ordered = [],
    visiting = new Set(),
    done = new Set();
  const visit = (p) => {
    if (!p) throw Error("Unknown helper dependency");
    if (visiting.has(p.name)) throw Error("Cyclic helper dependency");
    if (done.has(p.name)) return;
    visiting.add(p.name);
    p.dependsOn.forEach((n) => visit(byName.get(n)));
    visiting.delete(p.name);
    done.add(p.name);
    ordered.push(p);
  };
  parts.forEach(visit);
  // The model must use a deterministic binder order; do not silently reorder its assembly.
  if (parts.some((p, i) => p.name !== ordered[i].name))
    throw Error("Parts must be in dependency order");
  return {
    parts,
    assembly: validateLeanText(
      raw.assembly,
      "主证明连接",
      MAX_PROOF_CHARACTERS,
    ),
  };
}
export function obligationContract(root, name, target, dependencies = []) {
  validateContract(root);
  const leanTarget = dependencies.length
    ? `∀ ${dependencies.map((p) => `(ProofPart_${p.name} : (\n${p.target}\n))`).join(" ")}, (\n${target}\n)`
    : target;
  validateLeanText(leanTarget, "内部证明义务", LEAN_RUNTIME.targetCharacters);
  const { targetHash, ...body } = root;
  const result = {
    ...body,
    label: `内部证明义务 ${name}`,
    statement: "派生证明义务，未声称与论文引句等价。",
    leanTarget,
    proofObligation: {
      rootTargetHash: targetHash,
      name,
      dependencies: dependencies.map((p) => ({
        name: p.name,
        targetHash: digest(p.target),
      })),
    },
  };
  return validateContract({ ...result, targetHash: digest(result) });
}
export const kernelAccepted = (check, contract) =>
  check?.status === "verified" &&
  check.targetHash === contract.targetHash &&
  check.mode === "proof" &&
  check.exitCode === 0 &&
  !check.termination &&
  Array.isArray(check.axioms) &&
  check.axioms.every((a) => contract.allowedAxioms.includes(a));

export function composeDecomposition(plan, solved, connectionContract) {
  const lines = ["by"];
  const indent = (value) =>
    value
      .split("\n")
      .map((line) => "    " + line)
      .join("\n");
  for (const p of plan.parts) {
    const s = solved.get(p.name);
    if (
      !s ||
      s.identity !== digest({ target: p.target, dependsOn: p.dependsOn })
    )
      throw Error("Unproved helper cannot enter root proof");
    const value = `((${s.proof}) : (\n${s.contract.leanTarget}\n))${p.dependsOn.map((n) => ` ProofPart_${n}`).join("")}`;
    lines.push(
      `  have ProofPart_${p.name} : (\n${indent(p.target)}\n  ) := (\n${indent(value)}\n  )`,
    );
  }
  lines.push(
    `  exact (((\n${indent(plan.assembly)}\n  ) : (\n${indent(connectionContract.leanTarget)}\n  ))${plan.parts.map((p) => ` ProofPart_${p.name}`).join("")})`,
  );
  return validateLeanText(lines.join("\n"), "组装证明", MAX_PROOF_CHARACTERS);
}

// All helpers are proved as conditional propositions in the unchanged imports.
// Only the final self-contained proof is submitted against the original contract.
export async function proveDecomposition({
  root,
  context,
  failure,
  premises,
  budget,
  signal,
  model,
  checker,
  childProve,
  step,
  remaining,
  reserve,
  available,
  resume = null,
}) {
  const report = {
    schemaVersion: "lemma.proof-decomposition.v1",
    rootTargetHash: root.targetHash,
    plans: [],
    helpers: [],
    status: "unresolved",
  };
  const solved = new Map(),
    cached = new Map((resume?.helpers || []).map((h) => [h.name, h]));
  const preserveError = (error) => {
    const record = error.modelRecord;
    if (
      record?.error?.code === "model_incomplete" &&
      record.finishReason === "length"
    )
      report.status = "model_output_budget";
    else if (
      [
        "model_timeout",
        "model_transport_error",
        "model_nonfinal",
        "model_incomplete",
        "model_cancelled",
      ].includes(record?.error?.code)
    )
      report.status = "external_outcome_unknown";
    else report.status = signal.aborted ? "cancelled" : "execution_error";
    report.error = String(error.message || "Proof decomposition failed").slice(
      0,
      3000,
    );
    error.decompositionReport = report;
    return error;
  };
  let feedback = failure || null;
  for (
    let attempt = 1;
    attempt <= budget.maxDecompositionPlans && !signal.aborted;
    attempt++
  ) {
    const request = {
      root,
      context,
      failure: feedback,
      premises,
      maxParts: budget.maxHelperParts,
      verified: [...solved.values()].map((h) => ({
        name: h.name,
        target: h.target,
        dependsOn: h.dependsOn,
      })),
    };
    const archivedPlan =
      attempt === 1 && resume?.rootTargetHash === root.targetHash
        ? resume.plans?.findLast((p) => p.plan)?.plan
        : null;
    if (!archivedPlan && !(await reserve(request))) {
      report.status = "model_budget";
      break;
    }
    let raw, plan;
    try {
      const result = archivedPlan
        ? await step(
            "project_resume",
            "恢复已有拆分方案，重新检查连接与证明",
            async () => ({
              parsed: archivedPlan,
              origin: "cached_plan_untrusted_until_rechecked",
            }),
          )
        : await step("project_plan", `拆分证明义务 · 第 ${attempt} 轮`, () =>
            model(decompositionPrompt, request),
          );
      raw = result.parsed;
      if (raw.unavailable) {
        report.plans.push({
          attempt,
          unavailable: String(raw.unavailable).slice(0, 3000),
        });
        report.status = "decomposition_unavailable";
        break;
      }
      plan = validateDecomposition(raw, root, budget.maxHelperParts);
      for (const s of solved.values()) {
        const p = plan.parts.find((p) => p.name === s.name);
        if (
          !p ||
          digest({ target: p.target, dependsOn: p.dependsOn }) !== s.identity
        )
          throw Error("Verified helper changed or omitted");
      }
    } catch (error) {
      if (error.modelRecord) {
        throw preserveError(error);
      }
      feedback = {
        category: "plan_validation",
        reason: error.message,
        invalidPlan: raw || null,
      };
      report.plans.push({ attempt, ...feedback });
      continue;
    }
    const record = { attempt, plan, status: "checking_connection" };
    report.plans.push(record);
    try {
      const assemblyContract = obligationContract(
        root,
        "Connection",
        root.leanTarget,
        plan.parts,
      );
      const connection = await step(
        "project_kernel",
        "检查引理能否连接到原目标",
        () =>
          checker(assemblyContract, plan.assembly, { mode: "proof", signal }),
      );
      record.connection = { contract: assemblyContract, check: connection };
      if (!kernelAccepted(connection, assemblyContract)) {
        feedback = { category: "connection_rejected", check: connection, plan };
        record.status = "connection_rejected";
        continue;
      }
      record.status = "proving_helpers";
      let failed = false;
      for (const part of plan.parts) {
        signal.throwIfAborted();
        if (solved.has(part.name)) continue;
        const dependencies = part.dependsOn.map((n) =>
          plan.parts.find((p) => p.name === n),
        );
        const contract = obligationContract(
          root,
          part.name,
          part.target,
          dependencies,
        );
        const identity = digest({
          target: part.target,
          dependsOn: part.dependsOn,
        });
        const saved = cached.get(part.name);
        const seed =
          part.proof ||
          (saved?.contract?.targetHash === contract.targetHash
            ? saved.proof || saved.candidate?.proof
            : null);
        const limits = available();
        const helper = {
          name: part.name,
          target: part.target,
          dependsOn: part.dependsOn,
          identity,
          contract,
          status: "running",
        };
        report.helpers.push(helper);
        const result = await childProve(contract, {
          config: limits.config,
          signal,
          mode: "proof",
          initialCandidate: seed
            ? { mode: "proof", proof: seed, origin: "decomposition_candidate" }
            : null,
          initialDecomposition:
            saved?.contract?.targetHash === contract.targetHash
              ? saved.report?.decomposition || null
              : null,
          context: {
            purpose: part.purpose,
            rootTarget: root.leanTarget,
            paper: context,
            dependencies: dependencies.map((p) => ({
              name: `ProofPart_${p.name}`,
              target: p.target,
            })),
          },
          budget: {
            ...budget,
            maxDecompositionPlans:
              budget.maxDecompositionDepth > 1
                ? budget.maxDecompositionPlans
                : 0,
            maxDecompositionDepth: Math.max(
              0,
              budget.maxDecompositionDepth - 1,
            ),
            maxElapsedMs: Math.max(1, remaining()),
            maxModelCalls: Math.min(
              budget.maxHelperModelCalls,
              limits.modelCalls,
            ),
            maxCompletionTokens: limits.completionTokens,
            maxInputCharacters: limits.inputCharacters,
            maxTacticSteps: limits.tacticSteps,
            maxCandidates: Math.min(
              LEAN_RUNTIME.helperCandidates,
              budget.maxCandidates,
            ),
          },
          reserveModel: limits.reserve,
          step: (kind, title, action) =>
            step(
              ["project_kernel", "helper_connection"].includes(kind)
                ? "helper_connection"
                : ["kernel", "helper_kernel"].includes(kind)
                  ? "helper_kernel"
                  : [
                        "generate",
                        "tactics",
                        "project_plan",
                        "helper_model",
                      ].includes(kind)
                    ? "helper_model"
                    : "helper_search",
              `${part.name} · ${title}`,
              action,
            ),
        });
        helper.report = result.report;
        helper.check = result.check;
        // Preserve failed candidates and nested progress as untrusted repair input.
        // Reuse still enters childProve and the kernel; it never enters solved directly.
        helper.candidate = result.candidate?.proof
          ? {
              proof: result.candidate.proof,
              mode: "proof",
              targetHash: contract.targetHash,
            }
          : null;
        cached.set(part.name, helper);
        if (result.report.stopReason === "external_outcome_unknown") {
          report.status = "external_outcome_unknown";
          return { report };
        }
        if (
          !kernelAccepted(result.check, contract) ||
          !result.candidate?.proof
        ) {
          helper.status = "unresolved";
          failed = true;
          feedback = {
            category: "helper_unresolved",
            helper: {
              name: part.name,
              target: part.target,
              dependsOn: part.dependsOn,
            },
            attempts: result.report.attempts,
            stopReason: result.report.stopReason,
            budgetStop: result.report.budgetStop,
            budget: result.report.budget,
            check: result.check,
            plan,
          };
          break;
        }
        helper.proof = result.candidate.proof;
        helper.status = "verified";
        solved.set(part.name, helper);
      }
      if (failed) {
        record.status = "helper_unresolved";
        continue;
      }
      const proof = composeDecomposition(plan, solved, assemblyContract);
      report.status = "assembled_candidate";
      record.status = "assembled_candidate";
      return { proof, report };
    } catch (error) {
      if (error.modelRecord || signal.aborted) {
        throw preserveError(error);
      }
      feedback = { category: "local_validation", reason: error.message, plan };
      record.status = "local_rejected";
      record.error = error.message;
    }
  }
  report.failure = feedback;
  return { report };
}
