import { LEAN_RUNTIME } from "./runtime-limits.mjs";
import { digest, isHash } from "./evidence.mjs";
import { semanticApprovalValid } from "./semantics.mjs";
import { validateEnvironmentDescriptor } from "./lean-environments.mjs";
import {
  libraryProfile,
  profileForContract,
  ALLOWED_AXIOMS,
} from "../shared/library-profiles.mjs";

import { validateDomainContext, domainImports } from "./domain-schema.mjs";

// A composed, self-contained proof can contain several independently checked helpers.
export const MAX_PROOF_CHARACTERS = LEAN_RUNTIME.proofCharacters;

export const text = (v, max, name) => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new Error(`${name}缺失或超限。`);
  return v.trim();
};
export const normalize = (v) => v.normalize("NFC").replace(/\s+/g, " ").trim();

// This is a defense in depth policy, not a replacement for the OS sandbox and kernel.
export function validateLeanText(value, name, max) {
  const source = text(value, max, name);
  if (
    /(?:sorry|admit|sorryAx|axiom|unsafe|native_decide|run_tac|run_elab|initialize|builtin_initialize|\b(?:elab|macro|syntax|set_option|import|namespace|export|notation|command_elab)\b|#)/u.test(
      source,
    )
  )
    throw new Error(`${name}包含未完成证明或本版本不允许的指令。`);
  if (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e\u2066-\u2069]/u.test(
      source,
    )
  )
    throw new Error(`${name}包含控制字符。`);
  return source;
}

export function validateProposal(value, page) {
  if (!value || typeof value !== "object")
    throw new Error("模型没有返回命题对象。");
  const quote = text(value.quote, 5000, "原文引句");
  const body = normalize(page.text),
    normalizedQuote = normalize(quote),
    quoteStart = body.indexOf(normalizedQuote);
  if (quoteStart < 0) throw new Error("模型引句未在固定原文中找到。");
  if (body.indexOf(normalizedQuote, quoteStart + 1) >= 0)
    throw new Error("引句在当前页重复，请提供能够唯一定位的上下文。");
  if (!Array.isArray(value.assumptions) || value.assumptions.length > 20)
    throw new Error("假设清单无效。");
  return {
    label: text(value.label, 120, "命题编号"),
    quote,
    quoteStart,
    statement: text(value.statement, 5000, "命题表述"),
    assumptions: value.assumptions.map((v) => text(v, 1000, "假设")),
    leanTarget: validateLeanText(
      value.leanTarget,
      "Lean 目标",
      LEAN_RUNTIME.targetCharacters,
    ),
    ambiguity:
      typeof value.ambiguity === "string" ? value.ambiguity.slice(0, 3000) : "",
  };
}

export function createContract(
  source,
  proposal,
  profileId = "std-v1",
  provenance = null,
  domain = null,
) {
  if (
    !isHash(source.paperSha256) ||
    !Number.isInteger(source.pageIndex) ||
    source.pageIndex < 0
  )
    throw new Error("原文身份无效。");
  const profile = libraryProfile(profileId);
  if (domain) validateDomainContext(domain.context);
  const body = {
    schemaVersion: domain
      ? "lemma.contract.v4"
      : provenance
        ? "lemma.contract.v3"
        : "lemma.contract.v2",
    paperSha256: source.paperSha256,
    pageIndex: source.pageIndex,
    sourceArtifact: source.artifact,
    ...validateProposal(proposal, source),
    libraryProfile: profile.id,
    libraryRevision: profile.revision,
    imports: domainImports(profile, domain?.context),
    ...(domain
      ? { domainContext: domain.context, domainArtifact: domain.artifact }
      : {}),
    allowedAxioms: [...ALLOWED_AXIOMS],
    ...(provenance
      ? {
          contextArtifact: provenance.contextArtifact,
          translationArtifact: provenance.translationArtifact,
        }
      : {}),
  };
  return { ...body, targetHash: digest(body) };
}

export function validateContract(contract) {
  if (
    !contract ||
    ![
      "lemma.contract.v1",
      "lemma.contract.v2",
      "lemma.contract.v3",
      "lemma.contract.v4",
      "lemma.contract.v5",
      "lemma.contract.v6",
    ].includes(contract.schemaVersion)
  )
    throw new Error("合同版本无效。");
  const { targetHash, ...body } = contract;
  if (!isHash(targetHash) || digest(body) !== targetHash)
    throw new Error("目标合同被修改。");
  if (
    contract.schemaVersion !== "lemma.contract.v1" &&
    typeof contract.libraryProfile !== "string"
  )
    throw new Error("目标没有固定数学库配置。");
  const profile = profileForContract(contract);
  if (contract.schemaVersion === "lemma.contract.v6") {
    validateEnvironmentDescriptor(contract.executionEnvironment);
    if (
      contract.externalLibraries ||
      contract.domainContext ||
      contract.domainArtifact
    )
      throw Error(
        "Versioned environments require their own sealed library closure",
      );
    if (
      contract.libraryRevision !== contract.executionEnvironment.libraryRevision
    )
      throw Error("Execution environment library revision mismatch");
  } else if (contract.executionEnvironment)
    throw Error("Execution environment requires a v6 contract");
  if (
    contract.schemaVersion !== "lemma.contract.v5" &&
    contract.externalLibraries
  )
    throw Error("External libraries require a v5 contract");
  if (
    contract.schemaVersion === "lemma.contract.v4" ||
    (contract.schemaVersion === "lemma.contract.v5" && contract.domainContext)
  ) {
    validateDomainContext(contract.domainContext);
    if (!isHash(contract.domainArtifact)) throw new Error("缺少领域补全证据。");
  } else if (contract.domainContext || contract.domainArtifact)
    throw new Error("旧合同不能嵌入新领域上下文。");
  if (
    JSON.stringify(contract.imports) !==
      JSON.stringify([
        ...domainImports(profile, contract.domainContext),
        ...(contract.schemaVersion === "lemma.contract.v5"
          ? validateExternalDescriptors(contract.externalLibraries).flatMap(
              (e) => e.modules,
            )
          : []),
      ]) ||
    JSON.stringify(contract.allowedAxioms) !== JSON.stringify(ALLOWED_AXIOMS) ||
    (!["lemma.contract.v1", "lemma.contract.v6"].includes(
      contract.schemaVersion,
    ) &&
      contract.libraryRevision !== profile.revision)
  )
    throw new Error("信任基础不受本版本支持。");
  validateLeanText(
    contract.leanTarget,
    "Lean 目标",
    LEAN_RUNTIME.targetCharacters,
  );
  if (
    ["lemma.contract.v3", "lemma.contract.v4"].includes(
      contract.schemaVersion,
    ) &&
    (!isHash(contract.contextArtifact) || !isHash(contract.translationArtifact))
  )
    throw new Error("目标缺少上下文与翻译版本。");
  return contract;
}

export function withExecutionEnvironment(contract, descriptor) {
  validateContract(contract);
  validateEnvironmentDescriptor(descriptor);
  if (contract.externalLibraries || contract.domainContext)
    throw Error("Cannot transplant an unported library closure");
  const { targetHash, ...body } = contract;
  const next = {
    ...body,
    schemaVersion: "lemma.contract.v6",
    executionEnvironment: descriptor,
    libraryRevision: descriptor.libraryRevision,
  };
  return validateContract({ ...next, targetHash: digest(next) });
}

export function withDefaultExecutionEnvironment(contract) {
  validateContract(contract);
  if (!contract.executionEnvironment) return contract;
  const { targetHash, executionEnvironment, ...body } = contract;
  const next = {
    ...body,
    schemaVersion:
      body.contextArtifact && body.translationArtifact
        ? "lemma.contract.v3"
        : "lemma.contract.v2",
    libraryRevision: profileForContract(contract).revision,
  };
  return validateContract({ ...next, targetHash: digest(next) });
}

export function validateExternalDescriptors(items) {
  if (!Array.isArray(items) || !items.length || items.length > 8)
    throw Error("Invalid external library descriptors");
  const seen = new Set();
  for (const e of items) {
    if (
      !isHash(e.id) ||
      !isHash(e.treeSha256) ||
      seen.has(e.id) ||
      !Array.isArray(e.modules) ||
      !e.modules.length ||
      e.modules.some(
        (n) => !/^\p{Lu}[\p{L}\p{N}_]*(?:\.[\p{L}\p{N}_]+)*$/u.test(n),
      )
    )
      throw Error("Invalid external library descriptor");
    seen.add(e.id);
  }
  return items;
}
export function withExternalLibraries(contract, receipts) {
  validateContract(contract);
  const { targetHash, ...body } = contract;
  const externalLibraries = [...(body.externalLibraries || [])];
  for (const r of receipts)
    if (!externalLibraries.some((e) => e.id === r.id))
      externalLibraries.push({
        id: r.id,
        treeSha256: r.tree.sha256,
        modules: r.modules,
      });
  const profile = profileForContract(contract);
  const next = {
    ...body,
    schemaVersion: "lemma.contract.v5",
    externalLibraries,
    imports: [
      ...domainImports(profile, body.domainContext),
      ...externalLibraries.flatMap((e) => e.modules),
    ],
  };
  return validateContract({ ...next, targetHash: digest(next) });
}

export function deriveConclusion({
  contract,
  approval,
  check,
  originalProof,
  originalProofRoute,
  status,
  semanticReview,
  semanticArtifact,
  completionProtocol,
  archiveFailure,
}) {
  validateContract(contract);
  const aligned =
    approval?.targetHash === contract.targetHash &&
    approval?.confirmed === true &&
    semanticApprovalValid(contract, approval, semanticReview, semanticArtifact);
  const checked =
    // New records separate a certificate from route completion; old replay stays stable.
    (!status ||
      status === "completed" ||
      ["lemma.review-completion.v1", "lemma.review-completion.v2"].includes(
        completionProtocol,
      )) &&
    !archiveFailure &&
    check?.status === "verified" &&
    check.targetHash === contract.targetHash &&
    ["proof", "counterexample"].includes(check.mode) &&
    check.exitCode === 0 &&
    Array.isArray(check.axioms) &&
    check.axioms.every((a) => contract.allowedAxioms.includes(a));
  const theorem = !aligned
    ? "semantic_review_required"
    : !checked
      ? "unknown"
      : check.mode === "counterexample"
        ? "refuted"
        : "formalized_proved";
  return {
    semantic: aligned
      ? approval?.authority === "autonomous_agent_semantic_assessment_not_human"
        ? "agent_reviewed"
        : "human_confirmed"
      : "unreviewed",
    theorem,
    originalProof:
      (originalProof?.status === "gap_candidate" &&
      !["verified_route", "verified_with_completion"].includes(
        originalProofRoute?.summary?.status,
      )
        ? "gap_candidate"
        : originalProofRoute?.summary?.status) ||
      (originalProof?.status === "gap_candidate"
        ? "gap_candidate"
        : "unverified"),
    scope: "selected_claim",
    wholePaperVerified: false,
    dependencies: checked
      ? profileForContract(contract).id === "std-v1" &&
        !contract.domainContext?.modules.length &&
        !contract.externalLibraries?.length
        ? "declared_std_basis"
        : "declared_mathlib_basis"
      : "unverified",
    headline: {
      semantic_review_required: "先核对命题与原文",
      unknown: "尚无足够依据判定",
      refuted: "已核验原命题的否定",
      formalized_proved: "所选形式化命题已证明",
    }[theorem],
    caveat:
      approval?.authority === "autonomous_agent_semantic_assessment_not_human"
        ? "Agent 复核不构成语义等价的机器证明；独立证明不代表原证明已核验。未检查的内容不在结论范围内。"
        : "人工确认记录不构成语义等价的机器证明；独立证明不代表原证明已核验。未检查的论文内容不在结论范围内。",
  };
}
