import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { inspectTarget } from "../server/lean-query.mjs";
import { createContract } from "../server/contracts.mjs";
import { digest } from "../server/evidence.mjs";
import {
  ADJUDICATED_AUDIT_PROTOCOL,
  INDEXED_ANCHOR_V2,
  validateAuditWire,
} from "../server/audit-wire.mjs";
import {
  validateSourceAudit,
  BOUNDARY_KINDS,
} from "../server/source-audit.mjs";
import { sourceAnchorIndex } from "../server/source-anchor-index.mjs";
const out = process.argv[2];
await mkdir(out, { recursive: false });
const cases = [
  ["faithful-exists-forall", "∃ c : Int, ∀ z : Int, c + z = z", 2],
  ["alpha", "∀ a b : Int, a + b = b + a", 2],
  ["lambda", "∀ n : Nat, (fun x : Nat => x + n) n = n + n", 1],
  ["repeated", "(∀ x : Nat, x = x) ∧ (∀ x : Nat, x = x)", 2],
  ["multi", "∀ x y : Int, x + y = y + x", 2],
  ["forall-exists", "∀ n : Nat, ∃ m : Nat, n < m", 2],
  ["exists-forall", "∃ m : Nat, ∀ n : Nat, n < m", 2],
  ["shadow", "∀ x : Nat, x = x ∧ (∀ x : Nat, x = x)", 2],
  ["bounded", "∀ n : Nat, n > 0 → ∃ m : Nat, m ≤ n", 2],
  ["implicit", "∀ {α : Type}, ∀ x : α, x = x", 1],
  ["let", "∀ n : Nat, let m := n + 1; ∃ k : Nat, k = m", 2],
  ["function", "∀ f : Nat → Nat, ∀ n : Nat, f n = f n", 2],
  ["false-faithful", "∀ n : Nat, n + 1 = n", 1],
  ["empty-premise", "∀ n : Nat, n < 0 → n = 7", 1],
];
const rows = [];
let passed = false;
try {
  for (const [id, target, count] of cases) {
    const quote = `Explicit native structural fixture ${id}.`,
      paperSha256 = digest(quote);
    const contract = createContract(
      { text: quote, paperSha256, pageIndex: 0, artifact: digest(id) },
      {
        label: id,
        quote,
        statement: quote,
        assumptions: [],
        leanTarget: target,
      },
      "std-v1",
    );
    const check = await inspectTarget(contract),
      context = {
        paperSha256,
        selectedPage: 0,
        pages: [{ pageIndex: 0, text: quote }],
        supplements: [],
        omittedPages: [],
        semanticProtocol: ADJUDICATED_AUDIT_PROTOCOL,
        anchorProtocol: INDEXED_ANCHOR_V2,
      };
    const row = { id, contract, check };
    rows.push(row);
    await writeFile(out + `/${id}.json`, JSON.stringify(row, null, 2), {
      flag: "wx",
    });
    assert.equal(check.status, "well_typed", id);
    const st = check.targetStructure;
    assert(st?.complete, id);
    assert.equal(st.quantifiers.length, count, id);
    assert.equal(new Set(st.binders.map((n) => n.id)).size, st.binders.length);
    const ref = sourceAnchorIndex(context)[0].anchorId;
    const raw = {
      coverage: { status: "complete", anchors: [ref] },
      bindings: [],
      uses: [],
      quantifiers: st.quantifiers.map((n) => ({
        binderId: n.id,
        variable: n.name,
        kind: n.kind,
        lexicalScope: n.scope,
        typeDependencies: n.typeDependencies,
        sourceKind: n.kind,
        sourceType: n.type,
        mapping: "preserved",
        dependsOn:
          n.kind === "exists"
            ? n.scope.filter((id) =>
                st.quantifiers.some((q) => q.id === id && q.kind === "forall"),
              )
            : [],
        anchor: ref,
      })),
      boundaries: BOUNDARY_KINDS.map((kind) => ({
        kind,
        status: "matched",
        explanation: "Scripted structural fixture, not semantic judgement.",
        anchors: [ref],
      })),
      fidelity: {
        status: "preserved",
        explanation: "Scripted fixture.",
        anchors: [ref],
      },
      missing: [],
      corrections: [],
      mathematicalConcerns: [],
    };
    const response = {
      targetHash: contract.targetHash,
      backTranslation: quote,
      checks: [
        "variables",
        "quantifiers",
        "domain",
        "assumptions",
        "conclusion",
        "definitions",
      ].map((category) => ({
        category,
        status: "aligned",
        explanation: "Scripted fixture.",
        anchors: [ref],
      })),
      sourceAudit: raw,
    };
    validateAuditWire(response, { protocol: ADJUDICATED_AUDIT_PROTOCOL });
    assert.equal(
      validateSourceAudit(raw, contract, context, check).issues.length,
      0,
    );
    const bad = structuredClone(raw);
    bad.quantifiers[0].binderId = "foreign";
    assert(
      validateSourceAudit(bad, contract, context, check).issues.some(
        (i) => i.code === "native_quantifier_mapping_changed",
      ),
    );
    const foreign = structuredClone(check);
    foreign.targetStructure.environmentHash = digest("foreign");
    assert(
      validateSourceAudit(raw, contract, context, foreign).issues.some(
        (i) => i.code === "native_binding_structure_unavailable",
      ),
    );
    if (st.quantifiers.some((n) => n.kind === "exists" && n.scope.length)) {
      const changed = structuredClone(raw);
      changed.quantifiers.find((n) => n.kind === "exists").dependsOn = [];
      assert(
        validateSourceAudit(changed, contract, context, check).issues.some(
          (i) => i.code === "source_quantifier_dependency_unresolved",
        ),
      );
    }
    if (count > 1) {
      const reordered = structuredClone(raw);
      reordered.quantifiers.reverse();
      assert(
        validateSourceAudit(reordered, contract, context, check).issues.length >
          0,
      );
    }
    if (id === "empty-premise") {
      raw.mathematicalConcerns.push({
        kind: "vacuous_source_premise",
        explanation:
          "Original premise is retained; this fixture does not certify its mathematical truth.",
        anchors: [ref],
      });
      const v = validateSourceAudit(raw, contract, context, check);
      assert.equal(v.issues.length, 0);
      assert.equal(v.mathematicalConcerns.length, 1);
    }
    console.log(
      JSON.stringify({
        id,
        quantifiers: st.quantifiers.map((n) => ({
          id: n.id,
          name: n.name,
          kind: n.kind,
          scope: n.scope,
        })),
        passed: true,
      }),
    );
  }
  passed = true;
} catch (e) {
  await writeFile(out + "/failure.txt", e.stack);
  process.exitCode = 1;
} finally {
  await writeFile(
    out + "/report.json",
    JSON.stringify(
      {
        passed,
        cases: rows.length,
        scope: "native_structure_and_guard_mutations_not_model_semantics",
        rows,
      },
      null,
      2,
    ),
  );
}
