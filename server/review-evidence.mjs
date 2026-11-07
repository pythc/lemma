import { inspectSourceProofAbsence } from "./source-proof-absence.mjs";
import {
  reviewCompletion,
  COMPLETION_VERSION,
} from "../shared/review-completion.mjs";
import {
  reviewCompletion as archivedCompletionV1,
  COMPLETION_VERSION as ARCHIVED_COMPLETION_V1,
} from "../shared/review-completion-v1.mjs";
import {
  ADJUDICATED_AUDIT_PROTOCOL,
  ADJUDICATED_AUDIT_PROMPT,
  nativeAuditProtocol,
} from "./audit-wire.mjs";
import {
  ANCHOR_PROTOCOL,
  indexedAnchorProtocol,
} from "./source-anchor-index.mjs";
import { NATIVE_AUDIT_PROTOCOL } from "./audit-wire.mjs";
import { prepareSemanticProbe } from "./semantic-probes.mjs";
import { SOURCE_AUDIT_PROTOCOL, sourceAuditProtocol } from "./source-audit.mjs";
import { validateStructuredAttempts } from "./structured-review.mjs";
import { boundAudit, verifyAuditEnvelope } from "./audit-envelope.mjs";
import { inspectDomainEvidence } from "./domain-evidence.mjs";
import { digest, inspectBundle } from "./evidence.mjs";
import {
  deriveConclusion,
  validateContract,
  validateProposal,
} from "./contracts.mjs";
import { buildContext, supplementsFor, anchorInContext } from "./context.mjs";
import { validateAlignment, validateResolutions } from "./semantics.mjs";
import { bindScopeEvidence } from "./source-scope.mjs";
import { blindSemanticInput, mergeSemanticReviews } from "./semantic-blind.mjs";

// Structural/source/target validation is shared by single-claim replay and the ledger.
// This validates an archive's relationships, not its mathematical truth; replay still runs Lean.
export function inspectReviewEvidence(bundle, expectedRoot) {
  const { root, artifacts } = inspectBundle(bundle, expectedRoot);
  if (root.kind !== "review_report") throw new Error("不是可复现的评审报告。");
  const saved = root.payload,
    contract = validateContract(saved.contract);
  const source = artifacts.get(contract.sourceArtifact);
  const proofArtifact = artifacts.get(saved.proofArtifact);
  const contractArtifact = artifacts.get(saved.contractArtifact);
  const approvalArtifact = artifacts.get(saved.approvalArtifact);
  const checkArtifact = artifacts.get(saved.checkArtifact);
  // A repaired R05 version may point to its previous fixed contract rather
  // than repeat every source edge directly. Validate the actual ancestry;
  // source bytes, translated target and context are still checked below.
  const dependsOn = (artifact, id) => {
    const pending = [...artifact.inputs],
      seen = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (current === id) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(artifacts.get(current)?.inputs || []));
    }
    return false;
  };
  if (
    source?.kind !== "task:R02" ||
    !root.inputs.includes(source.id) ||
    proofArtifact?.kind !== "task:R09" ||
    contractArtifact?.kind !== "task:R05" ||
    approvalArtifact?.kind !== "semantic_approval" ||
    checkArtifact?.kind !== "task:R10"
  )
    throw new Error("证据包没有完整的原文、固定目标、审批、证明及检查链。");
  validateProposal(contract, source.payload);
  if (
    source.payload.paperSha256 !== contract.paperSha256 ||
    source.payload.pageIndex !== contract.pageIndex ||
    digest(contractArtifact.payload) !== digest(contract) ||
    digest(approvalArtifact.payload) !== digest(saved.approval) ||
    digest(checkArtifact.payload) !== digest(saved.check) ||
    saved.paperSha256 !== contract.paperSha256 ||
    approvalArtifact.payload.targetHash !== contract.targetHash ||
    !dependsOn(contractArtifact, source.id) ||
    !approvalArtifact.inputs.includes(contractArtifact.id) ||
    !proofArtifact.inputs.includes(contractArtifact.id) ||
    !proofArtifact.inputs.includes(approvalArtifact.id) ||
    !checkArtifact.inputs.includes(proofArtifact.id) ||
    !checkArtifact.inputs.includes(contractArtifact.id) ||
    !checkArtifact.inputs.includes(approvalArtifact.id)
  )
    throw new Error("证据产物没有对应同一固定目标。");
  if (
    ["lemma.contract.v3", "lemma.contract.v4", "lemma.contract.v5"].includes(
      contract.schemaVersion,
    )
  ) {
    const context = artifacts.get(contract.contextArtifact),
      translation = artifacts.get(contract.translationArtifact),
      semantic = artifacts.get(saved.semanticArtifact);
    if (
      context?.kind !== "task:R02C" ||
      translation?.kind !== "task:R03" ||
      semantic?.kind !== "task:R04" ||
      saved.contextArtifact !== context.id ||
      !context.inputs.includes(source.id) ||
      !dependsOn(contractArtifact, context.id) ||
      !contractArtifact.inputs.includes(translation.id) ||
      !semantic.inputs.includes(contractArtifact.id) ||
      !semantic.inputs.includes(context.id) ||
      !approvalArtifact.inputs.includes(semantic.id) ||
      digest(semantic.payload) !== digest(saved.semanticReview)
    )
      throw new Error("翻译、上下文和确认没有形成完整证据链。");
    const translated = validateProposal(
      translation.payload.proposal,
      source.payload,
    );
    if (
      Object.entries(translated).some(
        ([key, value]) => digest(value) !== digest(contract[key]),
      )
    )
      throw new Error("固定命题与已归档的翻译不一致。");
    let rebuilt = buildContext(
      source.payload,
      contract.pageIndex,
      supplementsFor(context.payload.supplements),
    );
    if (context.payload.propositionScope) {
      const evidence = context.payload.propositionScopeEvidence;
      rebuilt = bindScopeEvidence(
        rebuilt,
        context.payload.propositionScope,
        evidence,
        artifacts.get(evidence?.selection),
        artifacts.get(evidence?.review),
      );
      if (
        !context.inputs.includes(evidence.selection) ||
        !context.inputs.includes(evidence.review)
      )
        throw Error("命题范围复核证据未绑定到固定上下文。");
    }
    if (sourceAuditProtocol(context.payload.semanticProtocol))
      rebuilt.semanticProtocol = context.payload.semanticProtocol;
    if (indexedAnchorProtocol(context.payload.anchorProtocol))
      rebuilt.anchorProtocol = context.payload.anchorProtocol;
    if (boundAudit({ context: context.payload }))
      rebuilt.auditBindingProtocol = context.payload.auditBindingProtocol;
    if (digest(rebuilt) !== digest(context.payload))
      throw new Error("上下文与固定论文材料不一致。");
    if (translation.payload.proposal.alignment) {
      const alignment = validateAlignment(
        translation.payload.proposal.alignment,
        contract,
        context.payload,
      );
      if (digest(alignment) !== digest(semantic.payload.alignment))
        throw new Error("翻译对照表不一致。");
    }
    validateResolutions(saved.semanticReview, saved.approval.resolutions);
    if (
      saved.approval.authority ===
      "autonomous_agent_semantic_assessment_not_human"
    ) {
      const decision = artifacts.get(saved.approval.decisionArtifact),
        value = decision?.payload?.value;
      if (
        decision?.kind !== "adaptive:assess_target" ||
        !decision.payload.model ||
        !approvalArtifact.inputs.includes(decision.id) ||
        !decision.inputs.includes(contractArtifact.id) ||
        !decision.inputs.includes(semantic.id) ||
        value?.targetHash !== contract.targetHash ||
        value.semanticArtifact !== semantic.id ||
        value.childRunId !== saved.runId ||
        value.decision !== saved.approval.proofMode ||
        digest(value.resolutions) !== digest(saved.approval.resolutions)
      )
        throw Error("自动语义决策没有与固定目标及核验路线形成完整证据链。");
    }
    for (const check of saved.semanticReview.checks)
      for (const anchor of check.anchors) {
        if (digest(anchorInContext(anchor, context.payload)) !== digest(anchor))
          throw new Error("复核意见的原文依据不一致。");
      }
    const type = [...artifacts.values()].find(
      (a) => a.kind === "task:R04T" && semantic.inputs.includes(a.id),
    );
    if (
      !type ||
      !type.inputs.includes(contractArtifact.id) ||
      digest(type.payload) !== digest(semantic.payload.targetCheck)
    )
      throw new Error("类型检查证据缺失或不一致。");
    if (
      [
        "lemma.semantic.v2",
        "lemma.semantic.v3",
        "lemma.semantic.v4",
        "lemma.semantic.v5",
      ].includes(semantic.payload.schemaVersion)
    ) {
      const blind = artifacts.get(semantic.payload.blindArtifact);
      const definitions = [...artifacts.values()].find(
        (a) => a.kind === "task:R04K" && semantic.inputs.includes(a.id),
      );
      const expectedInput = blindSemanticInput(
        contract,
        context.payload,
        definitions?.payload,
        semantic.payload.targetCheck,
      );
      if (
        blind?.kind !== "task:R04B" ||
        !semantic.inputs.includes(blind.id) ||
        !blind.inputs.includes(contractArtifact.id) ||
        !blind.inputs.includes(context.id) ||
        (nativeAuditProtocol(context.payload.semanticProtocol) &&
          !blind.inputs.includes(type.id)) ||
        (definitions && !blind.inputs.includes(definitions.id)) ||
        digest(blind.payload.input) !== digest(expectedInput) ||
        blind.payload.inputHash !== digest(expectedInput) ||
        semantic.payload.blindInputHash !== digest(expectedInput) ||
        digest(blind.payload.response) !==
          digest(semantic.payload.blindResponse)
      )
        throw Error("盲审输入、响应或独立收据与归档不一致。");
      // Real transport receipts bind the actual payload, not just a claimed
      // sanitized copy. Injected offline fixtures may omit a transport record.
      if (boundAudit(expectedInput)) {
        if (
          !blind.payload.structuredAttempts ||
          !semantic.payload.structuredAttempts ||
          !blind.payload.auditOwner ||
          !semantic.payload.auditOwner ||
          !semantic.payload.model?.request?.messages
        )
          throw Error("Bound audit attempt history is missing");
        verifyAuditEnvelope(
          blind.payload.response,
          blind.payload.model,
          expectedInput,
          blind.payload.auditOwner,
        );
      }
      if (
        blind.payload.model?.request?.messages &&
        digest(
          JSON.parse(
            blind.payload.model.request.messages.find((m) => m.role === "user")
              .content,
          ),
        ) !== digest(expectedInput)
      )
        throw Error("盲审实际请求泄漏了对照理由或改变了原文输入。");
      if (blind.payload.structuredAttempts)
        validateStructuredAttempts(
          blind.payload.structuredAttempts,
          expectedInput,
          blind.payload.response,
          blind.payload.model,
        );
      if (
        semantic.payload.structuredAttempts &&
        semantic.payload.model?.request?.messages
      ) {
        const comparisonInput = JSON.parse(
          semantic.payload.model.request.messages.find((m) => m.role === "user")
            .content,
        );
        if (boundAudit(expectedInput))
          verifyAuditEnvelope(
            semantic.payload.comparisonResponse,
            semantic.payload.model,
            comparisonInput,
            semantic.payload.auditOwner,
          );
        if (
          comparisonInput.stage !== "comparison_after_immutable_blind_review" ||
          digest(comparisonInput.contract) !== digest(expectedInput.contract) ||
          digest(comparisonInput.context) !== digest(expectedInput.context) ||
          digest(comparisonInput.blindResponse) !==
            digest(blind.payload.response) ||
          digest(comparisonInput.alignment) !==
            digest(semantic.payload.alignment)
        )
          throw Error("对照实际请求改变了固定原文、目标、盲审或翻译依据。");
        validateStructuredAttempts(
          semantic.payload.structuredAttempts,
          comparisonInput,
          semantic.payload.comparisonResponse,
          semantic.payload.model,
        );
      }
      const proposedProbes = blind.payload.response?.sourceAudit?.probes || [];
      const storedProbes = semantic.payload.semanticProbes || [];
      if (
        proposedProbes.length !== storedProbes.length ||
        storedProbes.length > 2
      )
        throw Error("语义诊断被遗漏或增加。");
      for (const [index, probe] of storedProbes.entries()) {
        const artifact = artifacts.get(probe.artifact);
        const { artifact: _id, ...payload } = probe;
        const { check: _check, ...prepared } = payload;
        if (
          artifact?.kind !== "task:R04P" ||
          !semantic.inputs.includes(artifact.id) ||
          !artifact.inputs.includes(blind.id) ||
          !artifact.inputs.includes(contractArtifact.id) ||
          !artifact.inputs.includes(context.id) ||
          digest(artifact.payload) !== digest(payload) ||
          digest(
            prepareSemanticProbe(
              contract,
              context.payload,
              proposedProbes[index],
            ),
          ) !== digest(prepared)
        )
          throw Error("诊断目标与原文、原合同或实际检查不一致。");
      }
      const rebuiltReview = mergeSemanticReviews(
        contract,
        context.payload,
        semantic.payload.alignment,
        blind.payload.response,
        semantic.payload.comparisonResponse,
        type.payload,
        {
          blind: blind.payload.structuredAttempts,
          comparison: semantic.payload.structuredAttempts,
        },
      );
      for (const key of [
        "checks",
        "issues",
        "backTranslation",
        "disagreements",
        ...(semantic.payload.schemaVersion === "lemma.semantic.v5"
          ? ["adjudication"]
          : []),
        ...([
          "lemma.semantic.v3",
          "lemma.semantic.v4",
          "lemma.semantic.v5",
        ].includes(semantic.payload.schemaVersion)
          ? ["sourceAudit"]
          : []),
      ])
        if (digest(rebuiltReview[key]) !== digest(semantic.payload[key]))
          throw Error("盲审分歧或疑点在归档中被删除。");
    }
    for (const attempt of saved.attempts || []) {
      const proof = artifacts.get(attempt.proofArtifact),
        checked = artifacts.get(attempt.checkArtifact);
      if (
        attempt.targetHash !== contract.targetHash ||
        proof?.kind !== "task:R09" ||
        !proof.inputs.includes(contractArtifact.id) ||
        !proof.inputs.includes(approvalArtifact.id)
      )
        throw new Error("修复历史修改了固定目标。");
      if (
        attempt.checkArtifact &&
        (checked?.kind !== "task:R10" ||
          !checked.inputs.includes(proof.id) ||
          !checked.inputs.includes(contractArtifact.id) ||
          checked.payload.targetHash !== contract.targetHash ||
          checked.payload.mode !== proof.payload.mode ||
          attempt.status !== checked.payload.status)
      )
        throw new Error("修复候选与检查结果不一致。");
    }
    const last = (saved.attempts || []).filter((a) => a.checkArtifact).at(-1);
    const actualChecks = [...artifacts.values()].filter(
      (a) =>
        a.kind === "task:R10" &&
        a.inputs.includes(contractArtifact.id) &&
        a.inputs.includes(approvalArtifact.id),
    );
    if (
      actualChecks.length !==
        (saved.attempts || []).filter((a) => a.checkArtifact).length ||
      actualChecks.some(
        (a) => !saved.attempts.some((t) => t.checkArtifact === a.id),
      )
    )
      throw new Error("修复历史遗漏或重复了实际检查。");
    if (
      !last ||
      last.proofArtifact !== proofArtifact.id ||
      last.checkArtifact !== checkArtifact.id
    )
      throw new Error("最终结论未使用最后一次实际检查。");
  }
  if (
    (contract.schemaVersion === "lemma.contract.v4" ||
      (contract.schemaVersion === "lemma.contract.v5" &&
        !!contract.domainContext)) &&
    !contractArtifact.inputs.includes(contract.domainArtifact)
  )
    throw new Error("主目标未绑定领域补全版本。");
  const domainChecks = inspectDomainEvidence(
    contract,
    artifacts,
    saved.semanticReview,
  );
  if (saved.originalProofRoute?.summary?.status === "source_proof_missing")
    inspectSourceProofAbsence(
      artifacts,
      saved.originalProofRoute.root,
      contract,
    );
  const baseConclusion = deriveConclusion(saved);
  // Validate immutable historical conclusions with their recorded protocol.
  // Current UI and acceptance independently use reviewCompletion v2.
  const archivedCompletion =
    saved.completionProtocol === COMPLETION_VERSION
      ? reviewCompletion
      : saved.completionProtocol === ARCHIVED_COMPLETION_V1
        ? archivedCompletionV1
        : null;
  const conclusion =
    archivedCompletion
      ? {
          ...baseConclusion,
          ...archivedCompletion({ ...saved, conclusion: baseConclusion }),
        }
      : baseConclusion;
  if (digest(conclusion) !== digest(saved.conclusion))
    throw new Error("归档结论与实际检查产物不一致。");
  return {
    root,
    artifacts,
    saved,
    contract,
    source,
    proofArtifact,
    conclusion,
    domainChecks,
  };
}
