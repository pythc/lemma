import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectTarget } from "../server/lean-query.mjs";
import { createContract } from "../server/contracts.mjs";
import { digest } from "../server/evidence.mjs";
import { validateSourceAudit } from "../server/source-audit.mjs";
import { ANCHORED_AUDIT_PROTOCOL as protocol } from "../server/audit-wire.mjs";
import { sourceAuditFixture } from "./source-audit-fixture.mjs";

for (const target of [
  "∀ n : Nat, n = n",
  "∀ x : Nat, ∃ y : Nat, x = y",
  "∃ y : Nat, ∀ x : Nat, x = y",
  "∀ x : Nat, (∀ x : Nat, x = x) ∧ x = x",
  "∀ (α : Type) (x : α), ∃ y : α, y = x",
]) {
  test(
    `v8 existential-only witness binding and negative source mappings: ${target}`,
    { timeout: 180000 },
    async () => {
      const root = path.resolve(
        process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/native-bound-native",
      );
      await mkdir(root, { recursive: true });
      const out = await mkdtemp(path.join(root, "bindings-"));
      const quote =
        "Controlled source mapping fixture; not an autonomous fidelity result.";
      const contract = createContract(
        {
          text: quote,
          pageIndex: 0,
          paperSha256: digest(quote),
          artifact: digest("controlled"),
        },
        {
          label: "controlled binding",
          quote,
          statement: quote,
          assumptions: [],
          leanTarget: target,
        },
        "std-v1",
      );
      const context = {
        semanticProtocol: protocol,
        paperSha256: contract.paperSha256,
        selectedPage: 0,
        pages: [{ pageIndex: 0, text: quote }],
        supplements: [],
        omittedPages: [],
      };
      const check = await inspectTarget(contract);
      assert.equal(check.status, "well_typed");
      const raw = sourceAuditFixture(contract, check.targetStructure, protocol);
      const run = (r, c = check) =>
        validateSourceAudit(r, contract, context, c);
      const good = run(raw);
      assert.deepEqual(good.issues, []);
      assert.deepEqual(
        good.quantifiers.map((q) => q.lexicalScope),
        check.targetStructure.quantifiers.map((q) => q.scope),
      );
      assert(
        good.quantifiers.every(
          (q) => q.nativeBinding.targetCheckHash === digest(check),
        ),
      );
      const negative = [];
      if (raw.witnessDependencies.length) {
        const missing = structuredClone(raw);
        missing.witnessDependencies.pop();
        assert.throws(() => run(missing), /见证/);
        const wrong = structuredClone(raw);
        wrong.witnessDependencies[0].dependsOn = ["unknown"];
        assert(
          run(wrong).issues.some(
            (i) => i.code === "source_quantifier_dependency_unresolved",
          ),
        );
        const duplicate = structuredClone(raw);
        duplicate.witnessDependencies.push(duplicate.witnessDependencies[0]);
        assert.throws(() => run(duplicate), /重复/);
      }
      for (const item of raw.witnessDependencies.filter(
        (w) => w.dependsOn.length,
      )) {
        const omitted = structuredClone(raw);
        omitted.witnessDependencies.find(
          (w) => w.binderId === item.binderId,
        ).dependsOn = [];
        assert(
          run(omitted).issues.some(
            (i) => i.code === "source_quantifier_dependency_unresolved",
          ),
        );
      }
      const forall = check.targetStructure.quantifiers.find(
        (q) => q.kind === "forall",
      );
      if (forall) {
        const injected = structuredClone(raw);
        injected.witnessDependencies.unshift({
          binderId: forall.id,
          dependsOn: [],
          anchor: raw.quantifiers[0].anchor,
        });
        assert.throws(() => run(injected), /存在量词/);
      }
      for (const [label, mutate] of [
        ["unknown-id", (r) => (r.quantifiers[0].binderId = "unknown")],
        ["duplicate", (r) => r.quantifiers.push({ ...r.quantifiers[0] })],
        [
          "kind-change",
          (r) =>
            (r.quantifiers[0].sourceKind =
              r.quantifiers[0].sourceKind === "forall" ? "exists" : "forall"),
        ],
        [
          "unknown-domain",
          (r) => {
            r.quantifiers[0].sourceType = "unknown";
            r.quantifiers[0].mapping = "unknown";
          },
        ],
        [
          "invented-dependency",
          (r) => (r.quantifiers[0].dependsOn = ["unknown"]),
        ],
        [
          "formal-field-injection",
          (r) => (r.quantifiers[0].lexicalScope = ["root"]),
        ],
        ...(raw.quantifiers.length > 1
          ? [["order", (r) => r.quantifiers.reverse()]]
          : []),
      ]) {
        const r = structuredClone(raw);
        mutate(r);
        let rejected = false,
          reason;
        try {
          const result = run(r);
          rejected = result.issues.length > 0;
          reason = result.issues;
        } catch (e) {
          rejected = true;
          reason = e.message;
        }
        negative.push({ label, rejected, reason });
        assert(rejected, label);
      }
      const wrongCheck = structuredClone(check);
      wrongCheck.targetStructure.environmentHash = "bad";
      if (raw.witnessDependencies.length)
        assert.throws(() => run(raw, wrongCheck), /已核验/);
      else
        assert(
          run(raw, wrongCheck).issues.some(
            (i) => i.code === "native_binding_structure_unavailable",
          ),
        );
      const legacy = sourceAuditFixture(
        contract,
        check.targetStructure,
        "lemma.source-audit.v5",
      );
      legacy.quantifiers[0].lexicalScope = ["root"];
      assert(
        validateSourceAudit(
          legacy,
          contract,
          { ...context, semanticProtocol: "lemma.source-audit.v5" },
          check,
        ).issues.some((i) => i.code === "native_quantifier_mapping_changed"),
      );
      await writeFile(
        path.join(out, "result.json"),
        JSON.stringify(
          {
            classification:
              "actual_Lean_controlled_source_mapping_not_model_accuracy",
            contract,
            context,
            check,
            raw,
            good,
            negative,
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
    },
  );
}
