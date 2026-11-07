import { adjudicatedAuditProtocol } from "./audit-wire.mjs";
import { domainIssues } from "./domain-schema.mjs";
import { digest, isHash } from "./evidence.mjs";
import { resolveContextAnchor } from "./context.mjs";

import { ALIGNMENT_CATEGORIES } from "./translation-wire.mjs";
export { ALIGNMENT_CATEGORIES };
const clean = (v) =>
  String(v || "")
    .replace(/\/\-[\s\S]*?\-\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const bounded = (v, max, name) => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new Error(`${name}无效。`);
  return v.trim();
};
const issue = (code, detail, category = "assumptions") => ({
  id: digest({ code, detail, category }).slice(0, 24),
  code,
  detail,
  category,
});

export function structuralConcerns(contract) {
  const target = clean(contract.leanTarget),
    original = `${contract.quote} ${contract.statement} ${contract.assumptions.join(" ")}`;
  const issues = [];
  if (/^\(*\s*(True|False)\s*\)*$/.test(target))
    issues.push(
      issue(
        "trivial_or_false_target",
        "形式目标只剩 True 或 False，须核对是否丢失原命题。",
        "conclusion",
      ),
    );
  if (/\bFalse\s*(?:→|->)|:\s*False\s*\)/.test(target))
    issues.push(
      issue(
        "inconsistent_premise",
        "目标出现 False 前提，可能使结论空泛成立。",
      ),
    );
  if (
    (/(?:every|for all|for every|all functions|所有|任意|每个)/i.test(
      original,
    ) ||
      /^\s*(?:a|an)\s+[\s\S]{1,200}?\b(?:is|has|admits|maps|satisfies)\b/i.test(
        contract.quote,
      )) &&
    /^(?:\(*\s*)(?:∃|Exists\b)/.test(target)
  )
    issues.push(
      issue(
        "quantifier_changed",
        "原文可能为全称表述，形式目标却以存在量词开始。",
        "quantifiers",
      ),
    );
  const tail = target.split(/→|->/).map((v) => clean(v).replace(/[()]/g, ""));
  if (tail.length > 1 && tail.slice(0, -1).some((v) => v === tail.at(-1)))
    issues.push(
      issue(
        "conclusion_as_premise",
        "结论与某个前提相同，可能把待证结论当作了假设。",
      ),
    );
  if (
    /(closed bounded interval|closed interval|闭区间|Set\.Icc)/i.test(
      original,
    ) &&
    !/(Icc|IsCompact|CompactSpace|IsClosed|≤|<=)/.test(target)
  )
    issues.push(
      issue(
        "domain_condition_missing",
        "原文包含闭区间条件，目标未显示相应的区间或紧致条件。",
        "domain",
      ),
    );
  if (contract.ambiguity?.trim())
    issues.push(issue("declared_ambiguity", contract.ambiguity, "definitions"));
  return issues;
}

export function validateAlignment(raw, contract, context, repairs = []) {
  // Normalize only an equivalent complete representation. The original strict
  // checks still verify every Lean fragment, category and source anchor below.
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Object.keys(raw).length === ALIGNMENT_CATEGORIES.length &&
    ALIGNMENT_CATEGORIES.every((k) => Object.hasOwn(raw, k))
  ) {
    raw = ALIGNMENT_CATEGORIES.map((category) => {
      const item = raw[category];
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        (item.category !== undefined && item.category !== category)
      )
        throw Error("六类语义对照的对象条目无效或类别不一致。");
      return { ...item, category };
    });
    repairs.push({
      method: "six_category_object_to_array",
      scope: "representation_only_no_semantic_content_added",
    });
  }
  if (!Array.isArray(raw) || raw.length > 40)
    throw new Error("需要变量、量词、定义域、假设、结论及定义的逐项对照。");
  const items = raw.map((item) => {
    if (!ALIGNMENT_CATEGORIES.includes(item.category))
      throw new Error("对照类别无效。");
    const explanation = bounded(item.explanation, 2000, "对照说明");
    if (item.notApplicable === true) {
      if (item.category === "conclusion")
        throw new Error("每条命题都必须核对结论，不能标为不适用。");
      return {
        category: item.category,
        explanation,
        notApplicable: true,
        anchors: [],
        leanFragment: "",
      };
    }
    const leanFragment = bounded(item.leanFragment, 6000, "Lean 对照片段");
    if (!clean(contract.leanTarget).includes(clean(leanFragment)))
      throw new Error("对照引用的 Lean 片段不在固定目标中。");
    if (
      !Array.isArray(item.anchors) ||
      item.anchors.length < 1 ||
      item.anchors.length > 8
    )
      throw new Error("每项对照需要原文依据。");
    return {
      category: item.category,
      explanation,
      notApplicable: false,
      leanFragment,
      anchors: item.anchors.map((a) =>
        resolveContextAnchor(a, context, {
          focusAnchor: { pageIndex: contract.pageIndex, quote: contract.quote },
          repairs,
        }),
      ),
    };
  });
  if (ALIGNMENT_CATEGORIES.some((k) => !items.some((i) => i.category === k)))
    throw new Error("六类翻译对照没有覆盖完整。");
  return items;
}

export function semanticReview(
  contract,
  context,
  alignment,
  response = null,
  targetCheck = null,
) {
  const issues = [
    // Legacy replay retains its old heuristics. v3 adjudicates source-target
    // differences using source anchored checks plus native identity; lexical
    // flags remain recorded as hints, never an equivalence verdict.
    ...structuralConcerns(contract).filter(
      (i) =>
        !adjudicatedAuditProtocol(context.semanticProtocol) ||
        i.code === "declared_ambiguity",
    ),
    ...domainIssues(contract.domainContext),
  ];
  for (const page of context.mathEvidence?.pages || [])
    for (const discrepancy of page.issues || []) {
      const value = issue(discrepancy.code, discrepancy.detail, "definitions");
      issues.push({
        ...value,
        pageIndex: page.pageIndex,
        sourceEvidenceRequired: discrepancy.blocking === true,
      });
    }
  const anchorRepairs = [];
  let checks = [],
    backTranslation = "未请求模型复核；需要人工逐项核对。";
  if (response) {
    if (response.targetHash !== contract.targetHash)
      throw new Error("语义复核没有对应当前固定目标。");
    backTranslation = bounded(response.backTranslation, 8000, "回译");
    if (!Array.isArray(response.checks) || response.checks.length !== 6)
      throw new Error("语义复核必须逐一检查六个类别。");
    checks = response.checks.map((c) => {
      if (
        !ALIGNMENT_CATEGORIES.includes(c.category) ||
        !["aligned", "concern", "unresolved"].includes(c.status)
      )
        throw new Error("语义复核条目无效。");
      const explanation = bounded(c.explanation, 3000, "复核说明");
      if (!Array.isArray(c.anchors) || c.anchors.length > 8)
        throw new Error("复核依据清单无效。");
      const anchors = c.anchors.map((a) =>
        resolveContextAnchor(a, context, {
          focusAnchor: { pageIndex: contract.pageIndex, quote: contract.quote },
          repairs: anchorRepairs,
        }),
      );
      if (
        c.status === "aligned" &&
        !anchors.length &&
        !alignment.some((a) => a.category === c.category && a.notApplicable)
      )
        throw new Error("一致意见缺少原文依据。");
      if (c.status !== "aligned")
        issues.push(issue(`review_${c.category}`, explanation, c.category));
      return { category: c.category, status: c.status, explanation, anchors };
    });
    if (new Set(checks.map((c) => c.category)).size !== 6)
      throw new Error("复核类别重复或缺失。");
  } else
    issues.push(
      issue(
        "manual_alignment_review",
        "未执行模型语义复核；请人工逐项核对六类条件并记录依据。",
        "definitions",
      ),
    );
  if (!alignment.length)
    issues.push(
      issue(
        "alignment_missing",
        "尚无逐项翻译对照表，需记录人工核对依据。",
        "definitions",
      ),
    );
  if (context.omittedPages.length)
    issues.push(
      issue(
        "context_incomplete",
        `本次未读取 ${context.omittedPages.length} 页；请核对是否遗漏相关定义或假设。`,
        "definitions",
      ),
    );
  return {
    schemaVersion: "lemma.semantic.v1",
    ...(adjudicatedAuditProtocol(context.semanticProtocol)
      ? {
          structuralHints: structuralConcerns(contract),
          adjudicationProtocol: context.semanticProtocol,
        }
      : {}),
    targetHash: contract.targetHash,
    alignment,
    checks,
    issues,
    backTranslation,
    targetCheck,
    ...(anchorRepairs.length ? { anchorRepairs } : {}),
    authority: "independent_model_and_rules_not_semantic_equivalence_proof",
  };
}

export function validateResolutions(review, resolutions) {
  if (review?.issues?.some((i) => i.sourceEvidenceRequired))
    throw Error(
      "原文抽取、定义或条件审计存在未解决的来源疑点；须形成新的原文核对证据，不能仅凭确认理由消除。",
    );
  if (
    !review ||
    !Array.isArray(review.issues) ||
    !Array.isArray(resolutions) ||
    resolutions.length !== review.issues.length
  )
    throw new Error("请逐项解决翻译疑点并记录理由。");
  if (
    review.targetCheck?.status !== "well_typed" ||
    review.targetCheck.targetHash !== review.targetHash
  )
    throw new Error(
      "目标尚未通过 Lean 类型检查，请修正目标或环境后重新建立版本。",
    );
  const result = resolutions.map((r) => {
    if (
      !review.issues.some((i) => i.id === r.issueId) ||
      r.decision !== "confirmed_with_reason"
    )
      throw new Error("疑点尚未解决，需重新建立目标。");
    const reason = bounded(r.reason, 2000, "核对理由");
    if (reason.length < 12)
      throw new Error("请写明具体原文依据或为何不存在该差异，至少十二个字符。");
    return { issueId: r.issueId, decision: r.decision, reason };
  });
  if (new Set(result.map((r) => r.issueId)).size !== review.issues.length)
    throw new Error("疑点处理记录重复。");
  return result;
}

// Findings about a paper's proof are not translation issues. A model may copy
// finding IDs into resolutions; retain its raw response but do not manufacture
// semantic issues or ask the model to resolve nonexistent ones repeatedly.
export function validateAgentResolutions(review, supplied) {
  if (!Array.isArray(supplied)) throw Error("语义疑点处理必须为数组。");
  const ids = new Set(review.issues.map((i) => i.id));
  return {
    resolutions: validateResolutions(
      review,
      supplied.filter((r) => ids.has(r.issueId)),
    ),
    ignoredNonSemanticResolutions: supplied.filter((r) => !ids.has(r.issueId)),
  };
}

export function semanticApprovalValid(contract, approval, review, artifact) {
  if (
    !["lemma.contract.v3", "lemma.contract.v4", "lemma.contract.v5"].includes(
      contract.schemaVersion,
    )
  )
    return true;
  if (
    !isHash(artifact) ||
    approval?.semanticArtifact !== artifact ||
    review?.targetHash !== contract.targetHash
  )
    return false;
  try {
    validateResolutions(review, approval.resolutions);
    return true;
  } catch {
    return false;
  }
}
