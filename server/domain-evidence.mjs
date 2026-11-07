import { inspectTranslationModulePlan } from "./translation-modules.mjs";
import { digest } from "./evidence.mjs";
import { anchorInContext } from "./context.mjs";
import { validateContract } from "./contracts.mjs";
import {
  validateDomainPlan,
  orderedComponents,
  dependencyContext,
  domainIssues,
  DOMAIN_LIMITS,
} from "./domain-schema.mjs";

// Validate the component DAG and every attempted proof, not only the final list.
// Fresh kernel checks remain necessary: archived assertions alone are not proof.
export function inspectDomainEvidence(contract, artifacts, semantic = null) {
  if (
    !["lemma.contract.v4", "lemma.contract.v5"].includes(
      contract.schemaVersion,
    ) ||
    !contract.domainContext
  )
    return [];
  const completion = artifacts.get(contract.domainArtifact);
  if (
    completion?.kind !== "domain_completion" ||
    digest(completion.payload.context) !== digest(contract.domainContext)
  )
    throw new Error("领域上下文未绑定完整补全证据。");
  const value = completion.payload;
  const planArtifact = artifacts.get(value.planArtifact),
    library = artifacts.get(value.libraryArtifact),
    context = artifacts.get(contract.contextArtifact);
  if (
    planArtifact?.kind !== "task:RDP" ||
    library?.kind !== "task:RDL" ||
    !context ||
    !completion.inputs.includes(planArtifact.id) ||
    !completion.inputs.includes(library.id)
  )
    throw new Error("领域补全方案或库准备证据缺失。");
  const priorModuleContract = inspectTranslationModulePlan(
    planArtifact,
    library,
    artifacts,
    {
      paperSha256: contract.paperSha256,
      sourceArtifact: contract.sourceArtifact,
    },
  );
  if (priorModuleContract)
    inspectDomainEvidence(priorModuleContract, artifacts);
  const plan = validateDomainPlan(planArtifact.payload.plan, context.payload);
  if (
    digest(plan.modules) !==
      digest(contract.domainContext.modules.map((m) => m.name)) ||
    digest(library.payload.modules) !==
      digest(contract.domainContext.modules) ||
    library.payload.status !== "ready"
  )
    throw new Error("新增模块未与固定方案对应。");
  const components = orderedComponents(contract.domainContext);
  const plannedComponents = orderedComponents(plan);
  if (
    components.length !== plannedComponents.length ||
    plannedComponents.some(
      (p) => !components.some((c) => c.name === p.name && c.kind === p.kind),
    )
  )
    throw new Error("补全结果遗漏了方案中的声明。");
  if (
    !Array.isArray(value.components) ||
    value.components.length !== components.length ||
    new Set(value.components.map((c) => c.name)).size !== components.length
  )
    throw new Error("领域补全遗漏或重复声明。");
  const checks = [];
  for (const c of components) {
    const record = value.components.find((r) => r.name === c.name);
    const initial = [...plan.definitions, ...plan.lemmas].find(
      (r) => r.name === c.name,
    );
    const { kind, ...component } = c;
    if (
      !record ||
      record.kind !== kind ||
      record.status !== "verified" ||
      digest(record.component) !== digest(component) ||
      !initial ||
      digest(initial.dependsOn) !== digest(c.dependsOn)
    )
      throw new Error("辅助声明身份不一致。");
    const invariant =
      kind === "definition" ? ["meaning", "anchors"] : ["target", "purpose"];
    if (invariant.some((k) => digest(initial[k]) !== digest(c[k])))
      throw new Error("修复期间改动了定义依据或引理目标。");
    if (
      !Array.isArray(record.attempts) ||
      !record.attempts.length ||
      record.attempts.length > DOMAIN_LIMITS.attempts ||
      record.finalArtifact !== record.attempts.at(-1).checkArtifact
    )
      throw new Error("辅助检查历史不完整。");
    for (const [i, attempt] of record.attempts.entries()) {
      const candidate = artifacts.get(attempt.candidateArtifact),
        check = artifacts.get(attempt.checkArtifact);
      if (
        candidate?.kind !== "domain_candidate" ||
        check?.kind !== (kind === "definition" ? "task:RDDC" : "task:RDLC") ||
        !check.inputs.includes(candidate.id) ||
        !check.inputs.includes(planArtifact.id) ||
        !completion.inputs.includes(check.id) ||
        attempt.number !== i + 1 ||
        candidate.payload.component.name !== c.name ||
        candidate.payload.kind !== kind
      )
        throw new Error("辅助检查与候选版本不一致。");
      const localContract = validateContract(check.payload.contract);
      const proposed = candidate.payload.component;
      if (
        digest(proposed.dependsOn) !== digest(c.dependsOn) ||
        invariant.some((k) => digest(proposed[k]) !== digest(c[k]))
      )
        throw new Error("辅助候选修改了固定目标或原文依据。");
      const ancestor = dependencyContext(contract.domainContext, c);
      const localContext =
        kind === "definition"
          ? { ...ancestor, definitions: [...ancestor.definitions, proposed] }
          : ancestor;
      if (
        digest(localContract.domainContext) !== digest(localContext) ||
        localContract.leanTarget !==
          (kind === "definition" ? "True" : c.target) ||
        localContract.sourceArtifact !== contract.sourceArtifact ||
        localContract.contextArtifact !== contract.contextArtifact ||
        localContract.domainArtifact !== planArtifact.id ||
        digest(localContract.imports) !== digest(contract.imports) ||
        localContract.libraryProfile !== contract.libraryProfile ||
        check.payload.result.targetHash !== localContract.targetHash ||
        attempt.status !== check.payload.result.status
      )
        throw new Error("辅助检查使用了不同的目标、依赖或来源。");
      if (i === record.attempts.length - 1) {
        if (digest(proposed) !== digest(component))
          throw new Error("最终使用的声明不是最后一个已检查候选。");
        const result = check.payload.result;
        if (
          kind === "definition"
            ? result.status !== "well_typed"
            : result.status !== "verified" ||
              result.mode !== "proof" ||
              result.exitCode !== 0 ||
              result.termination ||
              !Array.isArray(result.axioms) ||
              result.axioms.some((a) => !contract.allowedAxioms.includes(a))
        )
          throw new Error("未验证的辅助声明进入了证明上下文。");
        checks.push({ kind, component, contract: localContract });
      }
    }
    const actual = [...artifacts.values()].filter(
      (a) =>
        ["task:RDDC", "task:RDLC"].includes(a.kind) &&
        a.inputs.includes(planArtifact.id) &&
        a.inputs.some(
          (n) =>
            artifacts.get(n)?.kind === "domain_candidate" &&
            artifacts.get(n).payload.component.name === c.name,
        ),
    );
    if (
      actual.length !== record.attempts.length ||
      actual.some((a) => !record.attempts.some((t) => t.checkArtifact === a.id))
    )
      throw new Error("辅助历史遗漏了实际检查。");
    if (kind === "definition") {
      const fidelity = artifacts.get(record.fidelityArtifact);
      if (
        fidelity?.kind !== "task:RDDR" ||
        fidelity.payload.componentHash !== digest(component) ||
        digest(fidelity.payload) !== digest(record.fidelity) ||
        !fidelity.inputs.includes(record.finalArtifact) ||
        !completion.inputs.includes(fidelity.id)
      )
        throw new Error("新定义缺少对应版本的独立复核记录。");
      for (const anchor of fidelity.payload.anchors || []) {
        if (digest(anchorInContext(anchor, context.payload)) !== digest(anchor))
          throw new Error("定义复核的原文锚点不一致。");
      }
    }
  }
  if (
    semantic &&
    domainIssues(contract.domainContext).some(
      (i) => !semantic.issues.some((s) => digest(i) === digest(s)),
    )
  )
    throw new Error("新增定义未进入人工忠实性核对清单。");
  return checks;
}
