import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { CsReview } from "../server/cs-review.mjs";
import { checkProof } from "../server/lean.mjs";

const quote = "For every natural number n, n + 0 = n.";

test("a standard-library proposition is checked by the real Lean kernel", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-cs-lean-"));
  const store = new EvidenceStore(root);
  await store.init();
  const bytes = Buffer.from("cs-lean-fixture");
  const review = new CsReview({
    store,
    checker: checkProof,
    experiment: async () => {
      throw new Error("这条数学主张不应运行 Python。");
    },
    extract: async () => ({ pages: [{ index: 0, text: quote }] }),
  });
  try {
    const started = await review.start({
      paperSha256: sha256(bytes),
      pdfBase64: bytes.toString("base64"),
      track: "cs",
      orchestration: "cs",
      claims: [
        {
          kind: "math",
          profileId: "std-v1",
          label: "加法零",
          statement: quote,
          quote,
          leanTarget: "∀ n : Nat, n + 0 = n",
          proof: "by simp",
        },
      ],
    });
    let run;
    for (let i = 0; i < 120; i++) {
      run = await store.getRun(started.id);
      if (run.status === "incomplete") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(run.status, "incomplete");
    assert.equal(run.csClaims[0].outcome, "formalized_proved");
    assert.equal(run.csClaims[0].certificate, "lean");
    assert.equal(run.csClaims[0].receipt.status, "verified");
    assert.equal(run.conclusion.theorem, "unknown");
    assert.equal(run.conclusion.reviewComplete, false);
    assert.equal(run.modelInvoked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
