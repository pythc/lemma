import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { CsReview } from "../server/cs-review.mjs";
import { ROCQ_PIN } from "../server/rocq.mjs";

const clean = `Theorem paper_claim : 1 + 1 = 2.
Proof.
  reflexivity.
Qed.
`;
const admitted = `Theorem paper_claim : 1 + 1 = 2.
Proof.
Admitted.
`;
const extra = `Axiom extra_assumption : False.
Theorem paper_claim : False.
Proof.
  exact extra_assumption.
Qed.
`;

async function settle(review, input) {
  const started = await review.start(input);
  for (let i = 0; i < 180; i++) {
    const run = await review.store.getRun(started.id);
    if (run.status === "incomplete") return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Rocq 检查没有归档。");
}

test("pinned Rocq replays a closed proof and records admits or extra axioms", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-cs-rocq-"));
  const store = new EvidenceStore(root);
  await store.init();
  const bytes = Buffer.from("rocq-fixture");
  const review = new CsReview({
    store,
    checker: async () => {
      throw new Error("Rocq 主张不应调用 Lean。");
    },
    experiment: async () => {
      throw new Error("Rocq 主张不应运行 Python。");
    },
    extract: async () => ({
      pages: [
        {
          index: 0,
          text: [
            "The closed sentence is one plus one equals two.",
            "The admitted sentence is one plus one equals two.",
            "The axiom sentence is falsehood from an extra assumption.",
          ].join("\n"),
        },
      ],
    }),
  });
  try {
    const run = await settle(review, {
      paperSha256: sha256(bytes),
      pdfBase64: bytes.toString("base64"),
      track: "cs",
      orchestration: "cs",
      claims: [
        {
          kind: "mechanized_artifact",
          prover: "coq",
          statement: "The closed sentence is one plus one equals two.",
          quote: "The closed sentence is one plus one equals two.",
          source: clean,
        },
        {
          kind: "mechanized_artifact",
          prover: "rocq",
          statement: "The admitted sentence is one plus one equals two.",
          quote: "The admitted sentence is one plus one equals two.",
          source: admitted,
        },
        {
          kind: "mechanized_artifact",
          prover: "coq",
          statement: "The axiom sentence is falsehood from an extra assumption.",
          quote: "The axiom sentence is falsehood from an extra assumption.",
          source: extra,
        },
        {
          kind: "mechanized_artifact",
          prover: "fstar",
          statement: "F* remains unwired.",
          source: "let x = 1",
        },
      ],
    });
    const [closed, admit, axiom, foreign] = run.csClaims;
    assert.equal(closed.outcome, "mechanized_checked");
    assert.equal(closed.certificate, null);
    assert.equal(closed.columns.make, "make check 已重放");
    assert.match(closed.reason, /不是整篇论文的证明完成/);
    assert.doesNotMatch(closed.reason, /成功|语句已对应/);
    assert.equal(closed.columns.axioms, "无 admit，无额外公理");
    assert.match(closed.columns.correspondence, /第 1 页/);
    assert.equal(closed.receipt.version, ROCQ_PIN.version);
    assert.deepEqual(closed.receipt.commands, ["make check", "make validate"]);
    assert.equal(admit.outcome, "mechanized_incomplete");
    assert.equal(admit.certificate, null);
    assert.ok(admit.receipt.admits.includes("paper_claim"));
    assert.match(admit.columns.axioms, /admit/);
    assert.equal(admit.columns.make, "make check 已重放，仍有未完成项");
    assert.doesNotMatch(admit.columns.make, /成功/);
    assert.equal(axiom.outcome, "mechanized_incomplete");
    assert.ok(axiom.receipt.extraAxioms.includes("extra_assumption"));
    assert.equal(foreign.outcome, "unsupported_prover");
    assert.equal(run.conclusion.theorem, "unknown");
    assert.equal(run.conclusion.reviewComplete, false);
    assert.deepEqual(run.conclusion.provedClaimIds, []);
    assert.equal(run.modelInvoked, false);
    const replayed = await review.replay(run.id, {});
    const preserved = await store.getRun(run.id);
    assert.equal(preserved.root, run.root);
    assert.equal(preserved.csClaims[1].outcome, "mechanized_incomplete");
    assert.notEqual(replayed.root, run.root);
    assert.equal(replayed.previousRoot, run.root);
    assert.equal(replayed.modelInvoked, false);
    assert.ok(replayed.csClaims[1].receipt.admits.includes("paper_claim"));
    assert.equal(replayed.csClaims[1].certificate, null);
    assert.equal(replayed.conclusion.theorem, "unknown");
    await assert.rejects(
      review.replay(run.id, { source: admitted }),
      /不接受新的期望输出/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
