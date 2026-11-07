import { anchorInContext } from "./context.mjs";
import { digest } from "./evidence.mjs";
import { normalize } from "./contracts.mjs";
import {
  witnessedAuditProtocol,
  nativeBoundAuditProtocol,
  witnessDependencyProtocol,
  ANCHORED_AUDIT_PROTOCOL,
} from "./audit-wire.mjs";

// A witnessed model judgement is not a kernel theorem about natural language.
// This layer separates what is known from whether a translation may be used.
export function validateEpistemicFindings(response, contract, context) {
  return response.findings.map((f, index) => {
    const fail = (message) => {
      throw Object.assign(Error(message), {
        auditValidation: {
          code: "invalid_fidelity_witness",
          path: `findings.${index}`,
        },
      });
    };
    const anchors = f.anchors.map((a) => anchorInContext(a, context));
    if (f.targetFragment && !contract.leanTarget.includes(f.targetFragment))
      fail("差异依据不是固定目标的逐字片段。");
    if (
      f.kind === "established_change" &&
      (!f.independentOfMissing || f.missingSymbols.length || !f.targetFragment)
    )
      fail("已知改写必须给出不依赖缺失定义的具体差异依据。");
    if (
      ["source_missing", "unsupported_substitution"].includes(f.kind) &&
      !f.missingSymbols.length
    )
      fail("材料不足发现必须列明缺失对象。");
    if (witnessedAuditProtocol(context.semanticProtocol)) {
      const w = f.changeWitness;
      if (f.kind === "established_change") {
        let a;
        if (context.semanticProtocol === ANCHORED_AUDIT_PROTOCOL) {
          // Resolved location identity detects ID/object aliases as duplicates.
          const key = (x) =>
            digest({
              pageIndex: x.pageIndex ?? null,
              supplementId: x.supplementId ?? null,
              sourceTextHash: x.sourceTextHash,
              start: x.start,
              quote: normalize(x.quote),
            });
          const keys = anchors.map(key);
          if (new Set(keys).size !== keys.length)
            fail("差异来源锚点重复或存在别名歧义。");
          let selected;
          try {
            selected = anchorInContext(w?.sourceAnchor, context);
          } catch {
            fail("差异引用的来源锚点不存在或不唯一。");
          }
          // Require the actual wire anchor to be a member, not a nearby span.
          if (!f.anchors.some((x) => digest(x) === digest(w?.sourceAnchor)))
            fail("差异来源锚点不属于本条 finding。");
          a = anchors.find((x) => key(x) === key(selected));
        } else a = anchors[w?.sourceAnchorIndex];
        if (
          !w ||
          w.kind !== f.category ||
          !a ||
          !normalize(w.sourceFragment || "") ||
          !normalize(a.quote).includes(normalize(w.sourceFragment))
        )
          fail("已知改写缺少同类、逐字且属于所引来源的差异片段。");
      } else if (w !== null)
        fail("非已知改写发现的 changeWitness 必须为 null。");
    }
    const body = { ...f, anchors };
    return { ...body, id: digest(body).slice(0, 24) };
  });
}
const mentions = (fragment, symbol) => {
  const name = normalize(symbol);
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
    "u",
  ).test(normalize(fragment));
};
export function adjudicateFidelity(
  contract,
  context,
  responses,
  issues,
  attempts = {},
) {
  let findings = responses.flatMap((response, stage) =>
    validateEpistemicFindings(response, contract, context).map((f) => ({
      ...f,
      stage: stage ? "comparison" : "blind",
    })),
  );
  const history = Object.entries(attempts).flatMap(([stage, rows]) =>
    (rows || [])
      .filter((a) => a.outcome === "schema_rejected")
      .map((a) => ({
        stage,
        responseHash: digest(a.response),
        findings: a.response?.findings || [],
        checks: a.response?.checks || [],
        authority: "invalid_protocol_history_not_established_change",
      })),
  );
  const witnessed = witnessedAuditProtocol(context.semanticProtocol);
  if (witnessed) {
    const rejected = Object.values(attempts)
      .flat()
      .filter((a) => a.outcome === "schema_rejected")
      .map((a) => a.response)
      .filter(Boolean);
    const missing = [
      ...new Set(
        [...responses, ...rejected]
          .flatMap((r) => [
            ...(Array.isArray(r.findings) ? r.findings : [])
              .filter((f) =>
                ["source_missing", "unsupported_substitution"].includes(
                  f?.kind,
                ),
              )
              .flatMap((f) =>
                Array.isArray(f.missingSymbols) ? f.missingSymbols : [],
              ),
            ...(Array.isArray(r.sourceAudit?.missing)
              ? r.sourceAudit.missing
              : nativeBoundAuditProtocol(context.semanticProtocol) &&
                  Array.isArray(r.missing)
                ? r.missing
                : []
            ).map((m) => m?.symbol),
          ])
          .filter((s) => typeof s === "string"),
      ),
    ];
    findings = findings.map((f) => {
      if (f.kind !== "established_change") return f;
      const conflicts = missing.filter(
        (symbol) =>
          mentions(f.changeWitness.sourceFragment, symbol) ||
          mentions(f.targetFragment, symbol),
      );
      const structureOnly =
        witnessDependencyProtocol(context.semanticProtocol) &&
        f.changeWitness.effect === "structure_only";
      return {
        ...f,
        evidenceStatus:
          conflicts.length || structureOnly
            ? "unsubstantiated"
            : "supported_model_judgement",
        evidenceIssues: [
          ...(structureOnly
            ? [{ code: "structure_is_not_mathematical_difference" }]
            : []),
          ...conflicts.map((symbol) => ({
            code: "change_witness_depends_on_missing_symbol",
            symbol,
          })),
        ],
      };
    });
  }
  const changed = findings.some(
    (f) =>
      f.kind === "established_change" &&
      (!witnessed || f.evidenceStatus === "supported_model_judgement"),
  );
  const uncertain =
    issues.length > 0 ||
    findings.some((f) => f.evidenceStatus === "unsubstantiated") ||
    findings.some(
      (f) => !["established_change", "source_math_concern"].includes(f.kind),
    ) ||
    responses.some(
      (r) =>
        r.checks.some((c) => c.status !== "aligned") ||
        (r.sourceAudit &&
          (r.sourceAudit.fidelity.status !== "preserved" ||
            r.sourceAudit.missing.length)),
    );
  return {
    schemaVersion: witnessed
      ? "lemma.fidelity-decision.v2"
      : "lemma.fidelity-decision.v1",
    fidelity: changed ? "changed" : uncertain ? "unknown" : "preserved",
    admission: changed || uncertain ? "blocked" : "allowed",
    findings,
    history,
    authority: "source_anchored_model_judgement_not_kernel_equivalence",
  };
}
