// Scripted fixture metadata only; never used as a real model or gold label.
import { BOUNDARY_KINDS } from "../server/source-audit.mjs";
import { digest } from "../server/evidence.mjs";
// Unit plumbing only. Native acceptance uses inspectTarget, never this helper.
export function fixtureTargetStructure(contract) {
  const quantifiers = [...contract.leanTarget.matchAll(/[∀∃][^,]+/gu)].map(
    (m, i) => ({
      id: `fixture-${i}`,
      name: `fixture_binder_${i}`,
      kind: m[0][0] === "∀" ? "forall" : "exists",
      type: "Nat",
      typeDependencies: [],
      scope: Array.from({ length: i }, (_, j) => `fixture-${j}`),
    }),
  );
  return {
    schemaVersion: "lemma.target-structure.v2",
    targetHash: contract.targetHash,
    environmentHash: digest(null),
    complete: true,
    quantifiers,
    binders: quantifiers,
    authority: "explicit_scripted_unit_fixture_not_native_execution",
  };
}
export function sourceAuditFixture(
  contract,
  structure = null,
  protocol = "lemma.source-audit.v2",
) {
  structure ||= fixtureTargetStructure(contract);
  const anchor = { pageIndex: contract.pageIndex || 0, quote: contract.quote };
  const seen = [];
  return {
    coverage: { status: "complete", anchors: [anchor] },
    bindings: [],
    uses: [],
    ...(structure ? { mathematicalConcerns: [] } : {}),
    quantifiers: structure
      ? structure.quantifiers.map((q) => ({
          binderId: q.id,
          variable: q.name,
          ...([
            "lemma.source-audit.v6",
            "lemma.source-audit.v7",
            "lemma.source-audit.v8",
          ].includes(protocol)
            ? {}
            : { kind: q.kind }),
          ...([
            "lemma.source-audit.v3",
            "lemma.source-audit.v4",
            "lemma.source-audit.v5",
            "lemma.source-audit.v6",
            "lemma.source-audit.v7",
            "lemma.source-audit.v8",
          ].includes(protocol)
            ? {
                ...([
                  "lemma.source-audit.v6",
                  "lemma.source-audit.v7",
                  "lemma.source-audit.v8",
                ].includes(protocol)
                  ? {}
                  : {
                      lexicalScope: q.scope,
                      typeDependencies: q.typeDependencies || [],
                    }),
                sourceKind: q.kind,
                sourceType: q.type || "Nat",
                mapping: "preserved",
                ...(["lemma.source-audit.v7", "lemma.source-audit.v8"].includes(
                  protocol,
                )
                  ? {}
                  : {
                      dependsOn:
                        q.kind === "exists"
                          ? q.scope.filter((id) =>
                              structure.quantifiers.some(
                                (n) => n.id === id && n.kind === "forall",
                              ),
                            )
                          : [],
                    }),
              }
            : { dependsOn: q.scope }),
          anchor,
        }))
      : [...contract.leanTarget.matchAll(/[∀∃][^,]+/gu)].map((m, i) => {
          const variable = `fixture_binder_${i}`,
            dependsOn = [...seen];
          seen.push(variable);
          let finish = m.index + m[0].length,
            leanFragment = m[0];
          while (
            (contract.leanTarget.indexOf(leanFragment) !== m.index ||
              contract.leanTarget.indexOf(leanFragment, m.index + 1) >= 0) &&
            finish < contract.leanTarget.length
          )
            leanFragment = contract.leanTarget.slice(m.index, ++finish);
          return {
            variable,
            kind: m[0][0] === "∀" ? "forall" : "exists",
            dependsOn,
            anchor,
            leanFragment,
          };
        }),
    ...(["lemma.source-audit.v7", "lemma.source-audit.v8"].includes(protocol)
      ? {
          witnessDependencies: (structure?.quantifiers || [])
            .filter((q) => q.kind === "exists")
            .map((q) => ({
              binderId: q.id,
              anchor,
              dependsOn: q.scope.filter((id) =>
                structure.quantifiers.some(
                  (n) => n.id === id && n.kind === "forall",
                ),
              ),
            })),
        }
      : {}),
    boundaries: BOUNDARY_KINDS.map((kind) => ({
      kind,
      status: "matched",
      explanation:
        "Explicit scripted plumbing fixture, not mathematical judgement.",
      anchors: [anchor],
    })),
    fidelity: {
      status: "preserved",
      explanation: "Scripted fixture only.",
      anchors: [anchor],
    },
    missing: [],
    corrections: [],
  };
}

// Test-provider encoder only: production never accepts canonical bodies as v6 wire.
export function auditBodyFixture(response, protocol) {
  if (
    ![
      "lemma.source-audit.v6",
      "lemma.source-audit.v7",
      "lemma.source-audit.v8",
    ].includes(protocol)
  )
    return response;
  const { targetHash, sourceAudit, ...body } = response;
  if (!sourceAudit) return body;
  const { fidelity, ...source } = sourceAudit;
  return {
    ...body,
    ...source,
    fidelityStatus: fidelity.status,
    fidelityExplanation: fidelity.explanation,
    fidelityAnchors: fidelity.anchors,
  };
}
