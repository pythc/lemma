import { adjudicateFidelity } from "./epistemic-audit.mjs";
import {
  adjudicatedAuditProtocol,
  epistemicAuditProtocol,
  witnessedAuditProtocol,
} from "./audit-wire.mjs";
import { projectSemanticInput } from "./semantic-projection.mjs";
import { nativeAuditProtocol } from "./audit-wire.mjs";
import {
  indexedAnchorProtocol,
  sourceAnchorIndex,
  sourceScopeCandidates,
} from "./source-anchor-index.mjs";
import { validateAuditWire } from "./audit-wire.mjs";
import {
  SOURCE_AUDIT_PROMPT,
  sourceAuditProtocol,
  validateSourceAudit,
} from "./source-audit.mjs";
import { digest } from "./evidence.mjs";
import { semanticReview } from "./semantics.mjs";
import { recoveryConcerns } from "./structured-review.mjs";

export const BLIND_PROMPT = `你负责 R04 原文与形式目标的盲审。首次输入没有翻译者理由。只核对固定原文、数学定义和 Lean 目标；不要修正原文。忠实翻译一个错误命题仍可语义一致，定理真假另行判断。输出 {"targetHash":"原样摘要","backTranslation":"准确回译","checks":[{"category":"variables","status":"aligned 或 concern 或 unresolved","explanation":"有依据的理由","anchors":[{"pageIndex":0,"quote":"context 中逐字唯一短引句"}]}]}。必须恰好覆盖 variables、quantifiers、domain、assumptions、conclusion、definitions 六类，每个 aligned 均须原文依据。检查量词、域、隐藏前提、遗漏结论、矛盾前提、空泛目标、定义缺失、PDF 公式损失。不能确认就 unresolved。不得声称自然语言等价已被机器证明。输出紧凑 JSON。${SOURCE_AUDIT_PROMPT}`;
export const COMPARISON_PROMPT = `你负责 R04 第二阶段对照。盲审已封存；现在核对翻译者 alignment 和盲审发现，不能因翻译理由自信而抹去疑点。输出 {"targetHash":"原样摘要","backTranslation":"准确回译","checks":[{"category":"variables","status":"aligned","explanation":"原文依据","anchors":[{"pageIndex":0,"quote":"逐字唯一短引句"}]}]}。checks 必须恰好覆盖 variables、quantifiers、domain、assumptions、conclusion、definitions 六类；status 只允许 aligned、concern、unresolved，不允许 mismatch 或其他值。用原文锚点支持每项判断；歧义无明确原文依据就保留 concern 或 unresolved。定理真假与翻译忠实性分别判断。输出紧凑 JSON，每项 explanation 不超过80字，anchors 只保留能定位的短句。`;

const pick = (object, keys) =>
  Object.fromEntries(
    keys
      .filter((k) => object?.[k] !== undefined)
      .map((k) => [k, structuredClone(object[k])]),
  );
export function blindSemanticInput(
  contract,
  context,
  definitions = null,
  targetCheck = null,
) {
  const input = {
    protocol: "lemma.blind-semantic.v1",
    ...(nativeAuditProtocol(context.semanticProtocol)
      ? { targetStructure: targetCheck?.targetStructure || null }
      : {}),
    contract: {
      ...pick(contract, [
        "targetHash",
        "leanTarget",
        "imports",
        "libraryProfile",
        "libraryRevision",
        "paperSha256",
        "pageIndex",
        "quote",
      ]),
      ...(contract.domainContext
        ? {
            domainContext: {
              modules: (contract.domainContext.modules || []).map((m) =>
                pick(m, ["name", "sha256", "commit"]),
              ),
            },
          }
        : {}),
    },
    context: {
      ...pick(context, [
        "paperSha256",
        "selectedPage",
        "pages",
        "supplements",
        "omittedPages",
        "mathEvidence",
        "semanticProtocol",
        "auditBindingProtocol",
        "anchorProtocol",
      ]),
      ...(indexedAnchorProtocol(context.anchorProtocol)
        ? { anchorIndex: sourceAnchorIndex(context) }
        : {}),
      ...(witnessedAuditProtocol(context.semanticProtocol)
        ? { scopeCandidates: sourceScopeCandidates(context) }
        : {}),
      ...(context.propositionScope
        ? {
            propositionScope: {
              spans: structuredClone(context.propositionScope.spans),
            },
          }
        : {}),
    },
    libraryDefinitions: (definitions?.entries || []).map((d) =>
      pick(d, [
        "name",
        "kind",
        "signature",
        "definition",
        "source",
        "sourceRevision",
        "sourceExcerpt",
      ]),
    ),
    addedDefinitions: (contract.domainContext?.definitions || []).map((d) =>
      pick(d, [
        "name",
        "parameters",
        "type",
        "value",
        "body",
        "lean",
        "anchors",
      ]),
    ),
    addedLemmas: (contract.domainContext?.lemmas || []).map((d) =>
      pick(d, ["name", "target"]),
    ),
  };
  return adjudicatedAuditProtocol(context.semanticProtocol)
    ? projectSemanticInput(input)
    : input;
}
export function semanticModelIdentity(config, translationConfig) {
  const identity = (c) => ({
    model: c.model || "unknown",
    endpointHost: c.endpoint ? new URL(c.endpoint).host : null,
    family: c.family || "unknown",
    familyEvidence: c.familyEvidence || "not_verified",
  });
  return {
    reviewer: identity(config),
    translator: identity(translationConfig),
    relationship:
      config.model &&
      config.endpoint === translationConfig.endpoint &&
      config.model === translationConfig.model
        ? "same_model_separate_calls"
        : "different_configuration_family_independence_unverified",
    crossFamilyValidated: false,
  };
}
export function mergeSemanticReviews(
  contract,
  context,
  alignment,
  blindResponse,
  comparisonResponse,
  targetCheck,
  attempts = {},
) {
  if (nativeAuditProtocol(context.semanticProtocol)) {
    validateAuditWire(blindResponse, { protocol: context.semanticProtocol });
    validateAuditWire(comparisonResponse, {
      comparison: true,
      protocol: context.semanticProtocol,
    });
  }
  const blind = semanticReview(
    contract,
    context,
    alignment,
    blindResponse,
    targetCheck,
  );
  const compared = semanticReview(
    contract,
    context,
    alignment,
    comparisonResponse,
    targetCheck,
  );
  const issues = new Map(
    [
      ...blind.issues,
      ...compared.issues,
      ...recoveryConcerns(attempts.blind),
      ...recoveryConcerns(attempts.comparison),
    ].map((i) => [i.id, i]),
  );
  const sourceAudit = sourceAuditProtocol(context.semanticProtocol)
    ? validateSourceAudit(
        blindResponse.sourceAudit,
        contract,
        context,
        targetCheck,
      )
    : null;
  for (const item of sourceAudit?.issues || []) issues.set(item.id, item);
  const disagreements = [];
  for (const before of blind.checks) {
    const after = compared.checks.find((c) => c.category === before.category);
    if (before.status !== after.status) {
      const detail = `盲审为 ${before.status}，对照后为 ${after.status}；需根据原文解决差异。`;
      const issue = {
        code: "blind_comparison_disagreement",
        category: before.category,
        detail,
      };
      issue.id = digest(issue).slice(0, 24);
      issues.set(issue.id, issue);
      disagreements.push({
        category: before.category,
        blind: before.status,
        comparison: after.status,
      });
    }
  }
  const adjudication = epistemicAuditProtocol(context.semanticProtocol)
    ? adjudicateFidelity(
        contract,
        context,
        [blindResponse, comparisonResponse],
        [...issues.values()],
        attempts,
      )
    : null;
  if (adjudication?.admission === "blocked") {
    const body = {
      code: "fidelity_admission_blocked",
      category: "definitions",
      sourceEvidenceRequired: true,
      detail: `来源忠实性为 ${adjudication.fidelity}；固定候选不得进入证明准入。`,
    };
    issues.set(digest(body).slice(0, 24), {
      ...body,
      id: digest(body).slice(0, 24),
    });
  }
  return {
    ...compared,
    ...(adjudication ? { adjudication } : {}),
    schemaVersion: adjudication
      ? "lemma.semantic.v5"
      : adjudicatedAuditProtocol(context.semanticProtocol)
        ? "lemma.semantic.v4"
        : sourceAudit
          ? "lemma.semantic.v3"
          : "lemma.semantic.v2",
    ...(sourceAudit ? { sourceAudit } : {}),
    issues: [...issues.values()],
    // Downstream obligation generation must also see every blind concern.
    checks: compared.checks.map((c) => {
      const prior = blind.checks.find((b) => b.category === c.category);
      return c.status === "aligned" && prior.status !== "aligned" ? prior : c;
    }),
    blindResponse,
    comparisonResponse,
    disagreements,
    authority:
      "blind_then_comparison_model_and_rules_not_semantic_equivalence_proof",
  };
}
