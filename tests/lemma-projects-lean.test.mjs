import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LemmaProjects } from "../server/lemma-projects.mjs";
import { createContract } from "../server/contracts.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { checkProof } from "../server/lean.mjs";
const root = (target) =>
  createContract(
    {
      text: "native fixture",
      artifact: sha256("s"),
      paperSha256: sha256("p"),
      pageIndex: 0,
    },
    {
      label: "native fixture",
      quote: "native fixture",
      statement: "fixture",
      assumptions: [],
      leanTarget: target,
    },
  );
test(
  "native recursive lemmas repair failure then close and replay the exact root",
  { timeout: 240000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-project-native-")),
      store = new EvidenceStore(dir);
    await store.init();
    try {
      const c = root("(∀ n : Nat, n + 0 = n) ∧ (∀ n : Nat, (n + 0) + 0 = n)");
      const p = new LemmaProjects({
        contract: c,
        checker: checkProof,
        persist: (...args) => store.put(...args),
      });
      const plan = await p.plan({
        parts: [
          {
            name: "Once",
            target: "∀ n : Nat, n + 0 = n",
            purpose: "zero identity",
            dependsOn: [],
          },
          {
            name: "Twice",
            target: "∀ n : Nat, (n + 0) + 0 = n",
            purpose: "apply identity twice",
            dependsOn: ["Once"],
          },
        ],
        assembly: "by intro h1 h2; exact ⟨h1,h2⟩",
      });
      assert.equal(plan.ready, true, JSON.stringify(plan));
      assert.equal(
        (await p.check(plan.projectId, "Once", "by exact noSuchProof"))
          .accepted,
        false,
      );
      const child = await p.plan(
        {
          parts: [
            {
              name: "Identity",
              target: "∀ n : Nat, n + 0 = n",
              purpose: "base identity",
              dependsOn: [],
            },
          ],
          assembly: "by intro h; exact h",
        },
        { projectId: plan.projectId, name: "Twice" },
      );
      // The child parent target quantifies its own Once parameter, unlike Identity.
      assert.equal(child.ready, false);
      const repaired = await p.plan(
        {
          parts: [
            {
              name: "Identity",
              target: "∀ n : Nat, n + 0 = n",
              purpose: "base identity",
              dependsOn: [],
            },
          ],
          assembly: "by intro h _ n; exact (h (n+0)).trans (h n)",
        },
        { projectId: plan.projectId, name: "Twice" },
      );
      assert.equal(repaired.ready, true, JSON.stringify(repaired));
      await p.check(repaired.projectId, "Identity", "by intro n; rfl");
      assert.equal(
        (await p.assemble(repaired.projectId)).parentCheck.accepted,
        true,
      );
      assert.deepEqual((await p.assemble(plan.projectId)).missing, ["Once"]);
      await p.check(plan.projectId, "Once", "by intro n; rfl");
      const final = await p.assemble(plan.projectId);
      assert.equal(final.accepted, true, JSON.stringify(final));
      assert.equal((await checkProof(c, final.proof)).status, "verified");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "native preflight accepts a False signature without proving False and rejects non-Prop targets",
  { timeout: 120000 },
  async () => {
    const p = new LemmaProjects({
      contract: root("False"),
      checker: checkProof,
      persist: async () => sha256("a"),
    });
    const result = await p.plan({
      parts: [
        {
          name: "Absurd",
          target: "0 = 1",
          purpose: "invalid mathematical assertion",
          dependsOn: [],
        },
      ],
      assembly: "by intro h; exact Nat.noConfusion h",
    });
    assert.equal(result.ready, true, JSON.stringify(result));
    assert.equal(
      (await p.check(result.projectId, "Absurd", "by rfl")).accepted,
      false,
    );
    assert.deepEqual((await p.assemble(result.projectId)).missing, ["Absurd"]);
    const invalid = await p.plan({
      parts: [
        { name: "BadSort", target: "Nat", purpose: "bad sort", dependsOn: [] },
      ],
      assembly: "by intro _; contradiction",
    });
    assert.equal(invalid.ready, false);
    assert.equal(invalid.preflight.status, "incomplete");
  },
);
