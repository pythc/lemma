import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { createContract } from "../server/contracts.mjs";
import { checkProof } from "../server/lean.mjs";
import { digest } from "../server/evidence.mjs";
// Generic logical laws only. Never loaded by the product model or acceptance stores.
const cases = [
  [
    "nonempty independent conjunction",
    "(∀ (α : Type) (a : α) (P : α → Prop) (Q : Prop), ((∀ x, P x) ∧ Q) ↔ (∀ x, P x ∧ Q))",
    "by\n  intro α a P Q\n  constructor\n  · intro h x; exact ⟨h.1 x, h.2⟩\n  · intro h; exact ⟨fun x => (h x).1, (h a).2⟩",
  ],
  [
    "empty domain forbids blanket movement",
    "(∀ x : Empty, True ∧ False) ∧ ¬ ((∀ x : Empty, True) ∧ False)",
    "by\n  constructor\n  · intro x; exact nomatch x\n  · intro h; exact h.2",
  ],
  [
    "dependent witnesses cannot be made uniform",
    "(∀ x : Bool, ∃ y : Bool, y = x) ∧ ¬ (∃ y : Bool, ∀ x : Bool, y = x)",
    "by\n  constructor\n  · intro x; exact ⟨x, rfl⟩\n  · intro ⟨y, h⟩\n    have bad : false = true := (h false).symm.trans (h true)\n    cases bad",
  ],
];
for (const [name, target, proof] of cases)
  test(name, { timeout: 180000 }, async () => {
    const base = path.resolve(
      process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/structure-equivalence",
    );
    await mkdir(base, { recursive: true });
    const out = await mkdtemp(path.join(base, "logical-"));
    const quote = "Developer controlled logical diagnostic: " + name;
    const contract = createContract(
      {
        text: quote,
        pageIndex: 0,
        paperSha256: digest(quote),
        artifact: digest("diagnostic"),
      },
      {
        label: name,
        quote,
        statement: quote,
        assumptions: [],
        leanTarget: target,
      },
      "std-v1",
    );
    const check = await checkProof(contract, proof);
    await writeFile(
      path.join(out, "result.json"),
      JSON.stringify(
        {
          classification:
            "controlled_kernel_law_not_autonomous_fidelity_or_paper_certificate",
          contract,
          proof,
          check,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    assert.equal(
      check.status,
      "verified",
      JSON.stringify({
        status: check.status,
        stdout: check.stdout,
        stderr: check.stderr,
      }),
    );
    assert.deepEqual(check.axioms, []);
  });
