import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { CsReview } from "../server/cs-review.mjs";
import { TLA_PIN } from "../server/tla.mjs";

const closed = `---- MODULE Paper ----
EXTENDS Integers
VARIABLE x
Init == x = 0
Next == x' = x + 1
Inv == x >= 0
Spec == Init /\\ [][Next]_x
====
`;
const closedConfig = `SPECIFICATION Spec
INVARIANT Inv
`;
const violated = `---- MODULE Paper ----
EXTENDS Integers
VARIABLE x
Init == x = 0
Next == x' = x + 1
Inv == x < 2
Spec == Init /\\ [][Next]_x
====
`;

async function settle(review, input) {
  const started = await review.start(input);
  for (let i = 0; i < 180; i++) {
    const run = await review.store.getRun(started.id);
    if (run.status === "incomplete") return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("TLA+ 检查没有归档。");
}

test("pinned TLC records a bound and does not call a counterexample proof completion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-cs-tla-"));
  const store = new EvidenceStore(root);
  await store.init();
  const bytes = Buffer.from("tla-fixture");
  const review = new CsReview({
    store,
    checker: async () => {
      throw new Error("TLA 主张不应调用 Lean。");
    },
    experiment: async () => {
      throw new Error("TLA 主张不应运行 Python。");
    },
    rocq: async () => {
      throw new Error("TLA 主张不应调用 Rocq。");
    },
    model: async () => {
      throw new Error("TLA 检查不应请求模型。");
    },
    extract: async () => ({
      pages: [
        {
          index: 0,
          text: "The counter stays non-negative.\nThe counter stays below two.",
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
          prover: "tla",
          statement: "The counter stays non-negative.",
          quote: "The counter stays non-negative.",
          source: closed,
          config: closedConfig,
          bound: 3,
        },
        {
          kind: "mechanized_artifact",
          prover: "tla",
          statement: "The counter stays below two.",
          quote: "The counter stays below two.",
          source: violated,
          config: closedConfig.replace("Inv", "Inv"),
          bound: 4,
        },
        {
          kind: "mechanized_artifact",
          prover: "fstar",
          statement: "F* remains unwired.",
          source: "let x = 1",
        },
      ],
    });
    const [safe, unsafe, foreign] = run.csClaims;
    assert.equal(safe.outcome, "bounded_checked");
    assert.equal(safe.certificate, null);
    assert.equal(safe.columns.make, "tlc check 在界内结束");
    assert.equal(
      safe.columns.bound,
      "仿真 1 条行为，深度不超过 3 层，其余行为与更深处未检查",
    );
    assert.match(safe.columns.correspondence, /第 1 页/);
    assert.equal(safe.receipt.version, TLA_PIN.version);
    assert.deepEqual(safe.receipt.commands, ["make check", "make bound"]);
    assert.equal(unsafe.outcome, "bounded_counterexample");
    assert.equal(unsafe.certificate, null);
    assert.match(unsafe.columns.make, /发现一条行为/);
    assert.match(unsafe.columns.trace, /State 1:/);
    assert.match(unsafe.columns.trace, /x = 2/);
    assert.doesNotMatch(unsafe.columns.trace, /make:|Progress:|states generated/);
    assert.equal(
      unsafe.columns.bound,
      "仿真 1 条行为，深度不超过 4 层，其余行为与更深处未检查",
    );
    assert.equal(foreign.outcome, "unsupported_prover");
    assert.equal(run.conclusion.theorem, "unknown");
    assert.equal(run.conclusion.reviewComplete, false);
    assert.deepEqual(run.conclusion.provedClaimIds, []);
    assert.equal(run.modelInvoked, false);
    const replayed = await review.replay(run.id, {});
    assert.equal(replayed.previousRoot, run.root);
    assert.notEqual(replayed.root, run.root);
    assert.equal(replayed.csClaims[1].outcome, "bounded_counterexample");
    assert.equal(replayed.modelInvoked, false);
    await assert.rejects(
      review.replay(run.id, { bound: 1 }),
      /不接受新的期望输出/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a simulation that cannot continue is a found behavior, not a clean finish", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-cs-tla-deadlock-"));
  const store = new EvidenceStore(root);
  await store.init();
  const bytes = Buffer.from("tla-deadlock-fixture");
  const review = new CsReview({
    store,
    checker: async () => {
      throw new Error("死锁行为不应调用 Lean。");
    },
    experiment: async () => {
      throw new Error("死锁行为不应运行 Python。");
    },
    rocq: async () => {
      throw new Error("死锁行为不应调用 Rocq。");
    },
    model: async () => {
      throw new Error("死锁行为不应请求模型。");
    },
    extract: async () => ({
      pages: [{ index: 0, text: "The counter stops after one step." }],
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
          prover: "tla",
          statement: "The counter stops after one step.",
          quote: "The counter stops after one step.",
          source: `---- MODULE Paper ----
EXTENDS Integers
VARIABLE x
Init == x = 0
Next == x' = x + 1 /\\ x < 1
Inv == TRUE
====
`,
          config: "INIT Init\nNEXT Next\nINVARIANT Inv\n",
          bound: 4,
        },
      ],
    });
    const claim = run.csClaims[0];
    assert.equal(claim.outcome, "bounded_counterexample");
    assert.equal(claim.certificate, null);
    assert.match(claim.reason, /无法继续/);
    assert.match(claim.reason, /不是整篇论文的否证/);
    assert.equal(claim.columns.make, "tlc check 在界内发现一条无法继续的行为");
    assert.match(claim.columns.trace, /x = 1/);
    assert.doesNotMatch(claim.columns.trace, /states generated|Finished in/);
    assert.equal(run.conclusion.theorem, "unknown");
    assert.equal(run.conclusion.reviewComplete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a violated temporal property is not reported as a clean simulation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-cs-tla-temporal-"));
  const store = new EvidenceStore(root);
  await store.init();
  const bytes = Buffer.from("tla-temporal-fixture");
  const review = new CsReview({
    store,
    checker: async () => {
      throw new Error("时序性质不应调用 Lean。");
    },
    experiment: async () => {
      throw new Error("时序性质不应运行 Python。");
    },
    rocq: async () => {
      throw new Error("时序性质不应调用 Rocq。");
    },
    model: async () => {
      throw new Error("时序性质不应请求模型。");
    },
    extract: async () => ({
      pages: [{ index: 0, text: "The counter eventually reaches five." }],
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
          prover: "tla",
          statement: "The counter eventually reaches five.",
          quote: "The counter eventually reaches five.",
          source: `---- MODULE Paper ----
EXTENDS Integers
VARIABLE x
Init == x = 0
Next == x' = x + 1
Prop == <>(x = 5)
Spec == Init /\\ [][Next]_x
====
`,
          config: "SPECIFICATION Spec\nPROPERTY Prop\n",
          bound: 4,
        },
      ],
    });
    const claim = run.csClaims[0];
    assert.equal(claim.outcome, "bounded_counterexample");
    assert.equal(claim.certificate, null);
    assert.match(claim.reason, /违反时序性质/);
    assert.match(claim.reason, /不是整篇论文的否证/);
    assert.equal(claim.columns.make, "tlc check 在界内发现一条违反时序性质的行为");
    assert.match(claim.columns.trace, /counter-example/);
    assert.match(claim.columns.trace, /State 1:/);
    assert.doesNotMatch(claim.columns.trace, /states generated|Finished in/);
    assert.equal(run.conclusion.theorem, "unknown");
    assert.equal(run.conclusion.reviewComplete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a TLC evaluation exception is not a clean simulation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-cs-tla-crash-"));
  const store = new EvidenceStore(root);
  await store.init();
  const bytes = Buffer.from("tla-crash-fixture");
  const review = new CsReview({
    store,
    checker: async () => {
      throw new Error("异常仿真不应调用 Lean。");
    },
    experiment: async () => {
      throw new Error("异常仿真不应运行 Python。");
    },
    rocq: async () => {
      throw new Error("异常仿真不应调用 Rocq。");
    },
    model: async () => {
      throw new Error("异常仿真不应请求模型。");
    },
    extract: async () => ({
      pages: [{ index: 0, text: "Division by zero stops the search." }],
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
          prover: "tla",
          statement: "Division by zero stops the search.",
          quote: "Division by zero stops the search.",
          source: `---- MODULE Paper ----
EXTENDS Integers
VARIABLE x
Init == x = 0
Next == x' = 1 \\div x
Inv == TRUE
====
`,
          config: "INIT Init\nNEXT Next\nINVARIANT Inv\n",
          bound: 3,
        },
      ],
    });
    const claim = run.csClaims[0];
    assert.equal(claim.outcome, "execution_failed");
    assert.equal(claim.certificate, null);
    assert.match(claim.reason, /遇到异常/);
    assert.doesNotMatch(claim.reason, /没有发现错误/);
    assert.equal(claim.columns.make, "tlc check 失败");
    assert.match(claim.columns.bound, /搜索没有完成/);
    assert.match(claim.columns.trace, /x = 0/);
    assert.doesNotMatch(claim.columns.trace, /states generated|Finished in/);
    assert.equal(run.conclusion.theorem, "unknown");
    assert.equal(run.conclusion.reviewComplete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
