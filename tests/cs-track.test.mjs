import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { CsReview, refuseMathReplay } from "../server/cs-review.mjs";
import { unknownModelOutcome } from "../server/model-delivery.mjs";
import {
  CS_ENGINE,
  OUTCOME_LABELS,
  classifyCsClaim,
  locateEach,
  locateQuote,
} from "../shared/cs-track.mjs";
import { parseAssumptions } from "../server/rocq.mjs";
import { checkTlaArtifact } from "../server/tla.mjs";
import { runNumericExperiment } from "../server/numeric-execution.mjs";

const quote = "For every natural number n, n + 0 = n.";

function paperBytes() {
  const bytes = Buffer.from("cs-review-fixture");
  return {
    bytes,
    paperSha256: sha256(bytes),
    pdfBase64: bytes.toString("base64"),
  };
}

async function reviewWith(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-cs-"));
  const store = new EvidenceStore(root);
  await store.init();
  const calls = { checker: 0, experiment: 0, rocq: 0 };
  const review = new CsReview({
    store,
    checker: async (contract) => {
      calls.checker += 1;
      return {
        status: "verified",
        targetHash: contract.targetHash,
        axioms: [],
      };
    },
    experiment: async (_workspace, code) => {
      calls.experiment += 1;
      return {
        exitCode: 0,
        stdout: code.includes("print(2)") ? "2\n" : "9\n",
        stderr: "",
      };
    },
    rocq: async () => {
      calls.rocq += 1;
      throw new Error("不应调用 Rocq。");
    },
    extract: async () => ({ pages: [{ index: 0, text: quote }] }),
    ...overrides,
    store,
  });
  return { review, store, calls, root };
}

async function settle(review, input) {
  const started = await review.start(input);
  assert.equal(started.modelInvoked, false);
  assert.equal(started.status, "running");
  for (let i = 0; i < 80; i++) {
    const run = await review.store.getRun(started.id);
    if (run.status === "incomplete") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("计算机评审没有归档。");
}

test("a Rocq result label does not say the paper sentence was replayed", () => {
  assert.equal(
    OUTCOME_LABELS.mechanized_checked,
    "Rocq 已重放提交的证明，没有 admit 或额外公理",
  );
  assert.doesNotMatch(OUTCOME_LABELS.mechanized_checked, /该语句/);
});

test("a numeric quote cannot be sliced out of a longer number", async () => {
  let tlaRuns = 0;
  const { review, calls, root } = await reviewWith({
    extract: async () => ({
      pages: [
        {
          index: 0,
          text: "The reading is 2.0. The stored total is 20. The budget is 12,000.",
        },
      ],
    }),
    tla: async () => {
      tlaRuns += 1;
      return {
        ready: true,
        make: "ok",
        bound: 3,
        boundRecorded: true,
        counterexample: false,
        commands: ["make check", "make bound"],
      };
    },
  });
  try {
    const run = await settle(review, {
      ...paperBytes(),
      claims: [
        { kind: "prose_proof", statement: "2" },
        {
          kind: "mechanized_artifact",
          prover: "tla",
          statement: "截出来的二。",
          quote: "2",
          source: "---- MODULE Paper ----\n====\n",
          config: "SPECIFICATION Spec\nINVARIANT Inv\n",
          bound: 3,
        },
        { kind: "prose_proof", statement: "The stored total is 20." },
        { kind: "prose_proof", statement: "2." },
        {
          kind: "computation",
          statement: "从一万二里截两千。",
          code: "print(2000)",
          expected: "2,000",
        },
      ],
    });
    assert.equal(run.csClaims[0].outcome, "source_unlocated");
    assert.match(run.csClaims[0].reason, /只出现在更长的数字里/);
    assert.equal(run.csClaims[1].outcome, "source_unlocated");
    assert.match(run.csClaims[1].reason, /只出现在更长的数字里/);
    assert.equal(run.csClaims[2].outcome, "unmechanized");
    assert.equal(run.csClaims[3].outcome, "source_unlocated");
    assert.match(run.csClaims[3].reason, /只出现在更长的数字里/);
    assert.equal(run.csClaims[4].outcome, "source_unlocated");
    assert.match(run.csClaims[4].reason, /只出现在更长的数字里/);
    assert.equal(calls.experiment, 0);
    assert.equal(tlaRuns, 0);
    assert.equal(calls.checker, 0);
    assert.equal(calls.rocq, 0);
    assert.equal(run.conclusion.theorem, "unknown");
    assert.equal(run.conclusion.reviewComplete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prose, missing artifacts, foreign provers and blocked environments stay uncertified", async () => {
  const { review, calls, root } = await reviewWith();
  try {
    const paper = paperBytes();
    const run = await settle(review, {
      ...paper,
      track: "cs",
      orchestration: "cs",
      claims: [
        { kind: "prose_proof", statement: "算法在最坏情况下是 O(n log n)。" },
        {
          kind: "mechanized_artifact",
          prover: "coq",
          artifactPresent: false,
          statement: "没有 Coq 脚本。",
        },
        {
          kind: "mechanized_artifact",
          prover: "coq",
          artifactPresent: true,
          statement: "Theorem sound : True.",
        },
        {
          kind: "math",
          profileId: "std-v1",
          quote,
          leanTarget: "∀ n : Nat, n + 0 = n",
          proof: "sorry",
          statement: "带 sorry 的脚本。",
        },
        {
          kind: "other",
          environment: "gpu",
          code: "print(1)",
          statement: "训练准确率。",
        },
        {
          kind: "computation",
          code: "print(1)",
          statement: "没有对照数字。",
        },
        {
          kind: "mechanized_artifact",
          prover: "isabelle",
          source: "lemma foo: True",
          statement: "Isabelle stays unwired.",
        },
      ],
    });
    assert.deepEqual(
      run.csClaims.map((claim) => claim.outcome),
      [
        "source_unlocated",
        "artifact_absent",
        "artifact_absent",
        "incomplete_proof",
        "environment_unsupported",
        "not_run",
        "unsupported_prover",
      ],
    );
    assert.equal(calls.checker, 0);
    assert.equal(calls.experiment, 0);
    assert.equal(calls.rocq, 0);
    assert.equal(run.conclusion.theorem, "unknown");
    assert.equal(run.conclusion.reviewComplete, false);
    assert.equal(run.modelCalls, 0);
    assert.equal(run.csClaims.every((claim) => claim.certificate == null), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a numeric comparison records match and mismatch without becoming a proof", async () => {
  const { review, calls, root } = await reviewWith({
    extract: async () => ({
      pages: [
        {
          index: 0,
          text: `${quote}\nThe matching line says 2.\nThe mismatch line says 3.`,
        },
      ],
    }),
  });
  try {
    const paper = paperBytes();
    const run = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          label: "一致",
          statement: "计数等于 2。",
          code: "print(2)",
          expected: "2",
        },
        {
          kind: "computation",
          label: "不符",
          statement: "计数等于 3。",
          code: "print(2)",
          expected: "3",
        },
      ],
    });
    assert.deepEqual(
      run.csClaims.map((claim) => claim.outcome),
      ["reproduced", "mismatch"],
    );
    assert.equal(calls.experiment, 2);
    assert.equal(calls.checker, 0);
    assert.equal(
      run.csClaims[0].receipt.scope,
      "executed_finite_experiment_not_a_theorem_certificate",
    );
    assert.equal(run.csClaims[0].receipt.verified, false);
    assert.equal(run.conclusion.theorem, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an in-profile Lean target can be certified alone, and an unknown profile cannot", async () => {
  const { review, calls, root, store } = await reviewWith();
  try {
    const paper = paperBytes();
    const run = await settle(review, {
      ...paper,
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
        {
          kind: "math",
          profileId: "cs-v1",
          statement: "不存在的计算机配置。",
          quote,
          leanTarget: "True",
          proof: "trivial",
        },
      ],
    });
    assert.equal(run.csClaims[0].outcome, "formalized_proved");
    assert.equal(run.csClaims[0].certificate, "lean");
    assert.equal(run.csClaims[1].outcome, "profile_unsupported");
    assert.equal(calls.checker, 1);
    assert.deepEqual(run.conclusion.provedClaimIds, ["c0"]);
    assert.equal(run.conclusion.theorem, "unknown");
    const archived = await store.get(run.root);
    assert.equal(archived.payload.modelInvoked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty computer review stays unknown and math orchestration is refused", async () => {
  const { review, calls, root } = await reviewWith();
  try {
    const paper = paperBytes();
    const run = await settle(review, { ...paper, claims: [] });
    assert.equal(run.csClaims[0].outcome, "unknown");
    assert.equal(calls.checker, 0);
    await assert.rejects(
      review.start({ ...paper, orchestration: "adaptive", claims: [] }),
      /不能进入数学自主评审/,
    );
    await assert.rejects(
      review.start({ ...paper, paperSha256: "a".repeat(64), claims: [] }),
      /摘要与文件不一致/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classification keeps a blocked environment ahead of a computation", () => {
  const claim = classifyCsClaim({
    kind: "computation",
    environment: "exploit",
    code: "print(1)",
    expected: "1",
  });
  assert.equal(claim.disposition, "record");
  assert.equal(claim.outcome, "environment_unsupported");
});

test("the real sandbox compares output and does not treat it as a theorem", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-cs-real-"));
  const store = new EvidenceStore(root);
  await store.init();
  const review = new CsReview({
    store,
    checker: async () => {
      throw new Error("计算核对不应调用 Lean。");
    },
    extract: async () => ({
      pages: [{ index: 0, text: "The printed total is 4." }],
    }),
  });
  try {
    const paper = paperBytes();
    const run = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "两加二。",
          code: "print(2 + 2)",
          expected: "4",
        },
      ],
    });
    assert.equal(run.csClaims[0].outcome, "reproduced");
    assert.equal(run.csClaims[0].certificate, null);
    assert.equal(run.modelInvoked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the real sandbox reads an archived file and checks two source values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-cs-files-"));
  const store = new EvidenceStore(root);
  await store.init();
  const review = new CsReview({
    store,
    checker: async () => {
      throw new Error("计算核对不应调用 Lean。");
    },
    extract: async () => ({
      pages: [{ index: 0, text: "The first total is 2.\nThe second total is 3." }],
    }),
  });
  try {
    const paper = paperBytes();
    const run = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "文件里的两个数。",
          code: "value = open('data.txt').read().strip()\nprint(value)\nprint(int(value) + 1)",
          expected: "2\n3",
          command: "python3 experiment.py",
          files: [{ name: "data.txt", content: "2\n" }],
        },
      ],
    });
    assert.equal(run.csClaims[0].outcome, "reproduced");
    assert.equal(run.csClaims[0].execution.command, "python3 experiment.py");
    assert.deepEqual(run.csClaims[0].execution.expectedValues, ["2", "3"]);
    assert.equal(run.csClaims[0].certificate, null);
    assert.equal(run.conclusion.theorem, "unknown");
    assert.equal(run.conclusion.reviewComplete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a comparison that is not uniquely in the paper does not run", async () => {
  const { review, calls, root } = await reviewWith({
    extract: async () => ({ pages: [{ index: 0, text: "4\n4" }] }),
  });
  try {
    const paper = paperBytes();
    const missing = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "不在原文中。",
          code: "print(9)",
          expected: "9",
        },
      ],
    });
    const repeated = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "重复的四。",
          code: "print(4)",
          expected: "4",
        },
      ],
    });
    assert.equal(missing.csClaims[0].outcome, "source_unlocated");
    assert.equal(repeated.csClaims[0].outcome, "source_unlocated");
    assert.equal(calls.experiment, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prose and Rocq sentences that are not unique do not run", async () => {
  const { review, calls, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "same sentence\nsame sentence" }],
    }),
  });
  try {
    const paper = paperBytes();
    const run = await settle(review, {
      ...paper,
      claims: [
        { kind: "prose_proof", statement: "same sentence" },
        {
          kind: "mechanized_artifact",
          prover: "coq",
          statement: "missing sentence",
          quote: "missing sentence",
          source: "Theorem paper_claim : True.\nProof.\nreflexivity.\nQed.\n",
        },
        {
          kind: "mechanized_artifact",
          prover: "rocq",
          statement: "same sentence",
          quote: "same sentence",
          source: "Theorem paper_claim : True.\nProof.\nreflexivity.\nQed.\n",
        },
      ],
    });
    assert.deepEqual(
      run.csClaims.map((claim) => claim.outcome),
      ["source_unlocated", "source_unlocated", "source_unlocated"],
    );
    assert.equal(calls.rocq, 0);
    assert.equal(calls.checker, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tolerance is only numeric, and a located prose sentence stays unmechanized", async () => {
  const { review, calls, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: `${quote}\nThe stored total is 4.` }],
    }),
    experiment: async (_workspace, code) => {
      calls.experiment += 1;
      return {
        exitCode: 0,
        stdout: code.includes("close") ? "4.2\n" : "9\n",
        stderr: "",
      };
    },
  });
  try {
    const paper = paperBytes();
    const run = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "接近四。",
          code: "print(close)",
          expected: "4",
          tolerance: 0.5,
        },
        {
          kind: "computation",
          statement: "不是四。",
          code: "print(other)",
          expected: "4",
          tolerance: 0,
        },
        { kind: "prose_proof", statement: quote },
      ],
    });
    assert.deepEqual(
      run.csClaims.map((claim) => claim.outcome),
      ["within_tolerance", "mismatch", "unmechanized"],
    );
    assert.match(run.csClaims[0].reason, /相差不超过 0\.5/);
    assert.equal(run.csClaims[0].comparisons[0].toleranceUsed, true);
    assert.equal(run.csClaims[0].comparisons[0].actual, "4.2");
    assert.equal(run.csClaims[0].certificate, null);
    assert.equal(run.conclusion.theorem, "unknown");
    assert.equal(calls.experiment, 2);
    assert.equal(calls.rocq, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tolerance does not rewrite a text line or an exact number", async () => {
  const { review, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The label is ok.\nThe stored total is 4." }],
    }),
    experiment: async (_workspace, code) => ({
      exitCode: 0,
      stdout: code.includes("near") ? "ok\n4.2\n" : "ok\n",
      stderr: "",
    }),
  });
  try {
    const paper = paperBytes();
    const near = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "文字保持原样，数字用容差。",
          code: "print('near')",
          expected: "ok\n4",
          tolerance: 0.5,
        },
      ],
    });
    assert.equal(near.csClaims[0].outcome, "within_tolerance");
    assert.equal(near.csClaims[0].comparisons[0].toleranceUsed, false);
    assert.equal(near.csClaims[0].comparisons[0].matched, true);
    assert.equal(near.csClaims[0].comparisons[1].toleranceUsed, true);
    assert.match(near.csClaims[0].reason, /不是数学证明/);
    const exact = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "文字不能靠容差改写。",
          code: "print('ok')",
          expected: "ok.",
          tolerance: 0.5,
        },
      ],
    });
    assert.equal(exact.csClaims[0].outcome, "mismatch");
    assert.equal(exact.csClaims[0].comparisons[0].toleranceUsed, false);
    const changed = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "文字不能靠容差改写。",
          code: "print('ok')",
          expected: "ok",
          tolerance: 0.5,
        },
      ],
    });
    assert.equal(changed.csClaims[0].outcome, "reproduced");
    assert.equal(changed.csClaims[0].comparisons[0].toleranceUsed, false);
    assert.equal(changed.conclusion.reviewComplete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tolerance does not collapse different integers past the safe range", async () => {
  const wide = "9007199254740993";
  const near = "9007199254740992";
  const reading = "0.1000000000000000055511151231257827";
  const { review, root } = await reviewWith({
    extract: async () => ({
      pages: [
        {
          index: 0,
          text: `The exact total is ${wide}. The round total is 100000000000000000000. The reading is 0.1.`,
        },
      ],
    }),
    experiment: async (_workspace, code) => ({
      exitCode: 0,
      stdout: code.includes("near")
        ? `${near}\n`
        : code.includes("same")
          ? "1e20\n"
          : `${reading}\n`,
      stderr: "",
    }),
  });
  try {
    const paper = paperBytes();
    const collapsed = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "相邻大整数不能靠浮点容差算成同一个。",
          code: "print('near')",
          expected: wide,
          tolerance: 0,
        },
      ],
    });
    assert.equal(collapsed.csClaims[0].outcome, "mismatch");
    assert.equal(collapsed.csClaims[0].comparisons[0].toleranceUsed, false);
    assert.equal(collapsed.csClaims[0].comparisons[0].actual, near);
    assert.match(collapsed.csClaims[0].reason, /不符/);
    const spelled = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "同值的不同写法仍按十进制比较。",
          code: "print('same')",
          expected: "100000000000000000000",
          tolerance: 0,
        },
      ],
    });
    assert.equal(spelled.csClaims[0].outcome, "within_tolerance");
    assert.equal(spelled.csClaims[0].comparisons[0].actual, "1e20");
    assert.equal(spelled.csClaims[0].comparisons[0].toleranceUsed, true);
    const equal = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "差一仍在所给容差内。",
          code: "print('near')",
          expected: wide,
          tolerance: 2,
        },
      ],
    });
    assert.equal(equal.csClaims[0].outcome, "within_tolerance");
    assert.equal(equal.csClaims[0].comparisons[0].toleranceUsed, true);
    const fraction = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "小数展开不能靠浮点变成原文。",
          code: "print('reading')",
          expected: "0.1",
          tolerance: 0,
        },
      ],
    });
    assert.equal(fraction.csClaims[0].outcome, "mismatch");
    assert.equal(fraction.csClaims[0].comparisons[0].toleranceUsed, false);
    assert.equal(fraction.conclusion.theorem, "unknown");
    assert.equal(fraction.conclusion.reviewComplete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replay keeps the old root and refuses a new expected value", async () => {
  let runs = 0;
  const { review, store, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The matching line says 2." }],
    }),
    experiment: async () => {
      runs += 1;
      return {
        exitCode: 0,
        stdout: runs === 1 ? "2\n" : "9\n",
        stderr: "",
      };
    },
  });
  try {
    const paper = paperBytes();
    const first = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "应该是二。",
          code: "print(2)",
          expected: "2",
        },
      ],
    });
    const oldRoot = first.root;
    const oldArtifact = await store.get(oldRoot);
    await assert.rejects(
      review.replay(first.id, { expected: "9" }),
      /不接受新的期望输出/,
    );
    const replayed = await review.replay(first.id, {});
    const preserved = await store.getRun(first.id);
    assert.equal(preserved.root, oldRoot);
    assert.equal(preserved.csClaims[0].outcome, "reproduced");
    assert.deepEqual(await store.get(oldRoot), oldArtifact);
    assert.notEqual(replayed.root, oldRoot);
    assert.equal(replayed.previousRoot, oldRoot);
    assert.equal(replayed.csClaims[0].outcome, "mismatch");
    assert.equal(replayed.conclusion.differs, true);
    assert.equal(replayed.modelInvoked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replay does not run when archived file names collide", async () => {
  let runs = 0;
  const { review, store, root } = await reviewWith({
    experiment: async () => {
      runs += 1;
      return { exitCode: 0, stdout: "2\n", stderr: "" };
    },
  });
  try {
    const paperSha256 = "ab".repeat(32);
    const claim = {
      id: "c0",
      kind: "computation",
      label: "计算核对",
      statement: "文件名相撞。",
      outcome: "reproduced",
      reason: "旧记录。",
      certificate: null,
      sourceQuote: "2",
      pageIndex: 0,
      execution: {
        kind: "computation",
        code: "print(open('data.txt').read())",
        command: "python3 experiment.py",
        expectedValues: ["2"],
        expected: "2",
        tolerance: null,
        files: [
          { name: "data.txt", content: "2" },
          { name: "Data.txt", content: "9" },
        ],
      },
    };
    const artifact = await store.put("cs_claim", { paperSha256, claim });
    const run = {
      id: randomUUID(),
      engine: CS_ENGINE,
      track: "cs",
      orchestration: "cs",
      status: "incomplete",
      createdAt: new Date().toISOString(),
      paperSha256,
      sourceArtifact: artifact,
      root: artifact,
      modelCalls: 0,
      modelInvoked: false,
      csClaims: [{ id: "c0", artifact }],
      tasks: [],
      conclusion: { theorem: "unknown", reviewComplete: false },
    };
    await store.saveRun(run);
    const replayed = await review.replay(run.id, {});
    const preserved = await store.getRun(run.id);
    assert.equal(runs, 0);
    assert.equal(replayed.csClaims[0].outcome, "not_run");
    assert.match(replayed.csClaims[0].reason, /不区分大小写/);
    assert.equal(replayed.csClaims[0].comparisons, undefined);
    assert.deepEqual(
      replayed.csClaims[0].execution.files.map((file) => file.name),
      ["data.txt", "Data.txt"],
    );
    assert.equal(replayed.conclusion.theorem, "unknown");
    assert.equal(replayed.conclusion.reviewComplete, false);
    assert.equal(replayed.conclusion.differs, true);
    assert.equal(preserved.root, run.root);
    assert.notEqual(replayed.root, run.root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replay keeps both outputs when they differ inside the same tolerance", async () => {
  let runs = 0;
  const { review, store, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The stored total is 4." }],
    }),
    experiment: async () => {
      runs += 1;
      return {
        exitCode: 0,
        stdout: runs === 1 ? "4.2\n" : "4.4\n",
        stderr: "",
      };
    },
  });
  try {
    const paper = paperBytes();
    const first = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "四附近。",
          code: "print(4.2)",
          expected: "4",
          tolerance: 0.5,
        },
      ],
    });
    const replayed = await review.replay(first.id, {});
    const preserved = await store.getRun(first.id);
    assert.equal(preserved.root, first.root);
    assert.equal(preserved.csClaims[0].comparisons[0].actual, "4.2");
    assert.equal(replayed.csClaims[0].outcome, "within_tolerance");
    assert.equal(replayed.csClaims[0].comparisons[0].actual, "4.4");
    assert.equal(replayed.conclusion.differs, true);
    assert.match(replayed.conclusion.notice, /不一致/);
    assert.match(replayed.conclusion.notice, /整篇论文没有验证结论/);
    assert.equal(replayed.conclusion.theorem, "unknown");
    assert.equal(replayed.previousRoot, first.root);
    assert.notEqual(replayed.root, first.root);
    const again = await review.replay(replayed.id, {});
    assert.equal(again.csClaims[0].comparisons[0].actual, "4.4");
    assert.equal(again.conclusion.differs, false);
    assert.match(again.conclusion.notice, /沙箱代码/);
    assert.match(again.conclusion.notice, /整篇论文没有验证结论/);
    assert.doesNotMatch(again.conclusion.notice, /归档的 ?TLA\+/);
    assert.equal(again.conclusion.reviewComplete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lean replay uses the archived proof and does not replace the old root", async () => {
  let checks = 0;
  const { review, store, root } = await reviewWith({
    checker: async (contract) => {
      checks += 1;
      return {
        status: checks === 1 ? "verified" : "not_verified",
        targetHash: contract.targetHash,
        axioms: [],
        reason: "第二次检查没有通过。",
      };
    },
  });
  try {
    const paper = paperBytes();
    const first = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "math",
          profileId: "std-v1",
          statement: quote,
          quote,
          leanTarget: "∀ n : Nat, n + 0 = n",
          proof: "by simp",
        },
      ],
    });
    const replayed = await review.replay(first.id);
    const preserved = await store.getRun(first.id);
    assert.equal(preserved.csClaims[0].outcome, "formalized_proved");
    assert.equal(preserved.root, first.root);
    assert.equal(replayed.csClaims[0].outcome, "lean_unproved");
    assert.notEqual(replayed.root, first.root);
    assert.equal(checks, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quote location and Rocq assumption parsing stay separate from proof completion", () => {
  assert.equal(
    locateQuote([{ index: 0, text: "4\n4" }], "4").status,
    "repeated",
  );
  assert.equal(
    locateQuote([{ index: 0, text: "only once 4" }], "4").status,
    "unique",
  );
  assert.deepEqual(
    parseAssumptions("paper_claim is closed under the global context\n", "paper_claim"),
    { closed: true, admits: [], extraAxioms: [] },
  );
  assert.deepEqual(
    parseAssumptions("Closed under the global context\n", "paper_claim"),
    { closed: true, admits: [], extraAxioms: [] },
  );
  assert.deepEqual(
    parseAssumptions("Axioms:\npaper_claim : True\n", "paper_claim").admits,
    ["paper_claim"],
  );
  assert.deepEqual(
    parseAssumptions("Axioms:\nextra_assumption : False\n", "paper_claim")
      .extraAxioms,
    ["extra_assumption"],
  );
  assert.throws(() => refuseMathReplay("cs-review-v1"), /不走数学复现入口/);
});

test("rocq replay re-runs the archived source and keeps the old root", async () => {
  let runs = 0;
  const seen = [];
  const source = "Theorem paper_claim : True.\nProof.\nreflexivity.\nQed.\n";
  const { review, store, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The closed sentence is one plus one equals two." }],
    }),
    rocq: async (text) => {
      runs += 1;
      seen.push(text);
      return {
        ready: true,
        make: "ok",
        validate: "ok",
        closed: runs === 1,
        admits: runs === 1 ? [] : ["paper_claim"],
        extraAxioms: [],
        commands: ["make check", "make validate"],
        version: "9.3.0",
        theoremName: "paper_claim",
      };
    },
    model: async () => {
      throw new Error("重放不应请求模型。");
    },
  });
  try {
    const paper = paperBytes();
    const first = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "mechanized_artifact",
          prover: "coq",
          statement: "The closed sentence is one plus one equals two.",
          quote: "The closed sentence is one plus one equals two.",
          source,
        },
      ],
    });
    const oldRoot = first.root;
    await assert.rejects(
      review.replay(first.id, { source: "Theorem other : True." }),
      /不接受新的期望输出/,
    );
    const replayed = await review.replay(first.id, {});
    const preserved = await store.getRun(first.id);
    assert.equal(runs, 2);
    assert.equal(seen[1], source);
    assert.equal(preserved.root, oldRoot);
    assert.equal(preserved.csClaims[0].outcome, "mechanized_checked");
    assert.equal(replayed.csClaims[0].outcome, "mechanized_incomplete");
    assert.match(replayed.csClaims[0].columns.axioms, /admit/);
    assert.equal(replayed.conclusion.differs, true);
    assert.equal(replayed.previousRoot, oldRoot);
    assert.notEqual(replayed.root, oldRoot);
    assert.equal(replayed.modelInvoked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a model candidate is located text and does not run a checker", async () => {
  let calls = 0;
  const { review, calls: checkers, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "only once 4\nsame sentence\nsame sentence" }],
    }),
    model: async () => {
      calls += 1;
      return {
        parsed: {
          candidates: [
            { kind: "computation", sentence: "only once 4", code: "print(9)", expected: "9" },
            { kind: "prose_proof", sentence: "missing sentence", proof: "by simp" },
            { kind: "math", sentence: "same sentence", source: "Theorem t : True." },
            { kind: "gpu", sentence: "only once 4" },
          ],
        },
        record: { requestId: "candidate-test", model: "stub", finishReason: "stop" },
      };
    },
  });
  try {
    const paper = paperBytes();
    const result = await review.proposeCandidates(paper);
    assert.equal(calls, 1);
    assert.equal(checkers.experiment, 0);
    assert.equal(checkers.checker, 0);
    assert.equal(checkers.rocq, 0);
    assert.equal(result.modelInvoked, true);
    assert.equal(result.theorem, "unknown");
    assert.equal(result.reviewComplete, false);
    assert.equal(result.candidates[0].status, "candidate");
    assert.equal("kind" in result.candidates[0], false);
    assert.equal("code" in result.candidates[0], false);
    assert.equal("expected" in result.candidates[0], false);
    assert.deepEqual(result.candidates[0].discarded, ["code", "expected", "kind"]);
    assert.equal(result.candidates[1].status, "source_unlocated");
    assert.equal(result.candidates[2].status, "source_unlocated");
    assert.match(result.notice, /这些只是原文候选/);
    assert.match(result.notice, /才会检查对应的原句/);
    assert.doesNotMatch(result.notice, /还没有检查结果/);
    assert.equal(result.candidates[3].status, "candidate");
    assert.ok(result.candidates[3].discarded.includes("kind"));
    await assert.rejects(
      review.proposeCandidates({ ...paper, code: "print(1)" }),
      /不接受代码/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown model outcome is archived once and not retried", async () => {
  const record = {
    error: { code: "model_timeout", delivery: { outcome: "unknown" } },
    http: { status: 504 },
    resource: { executionStarted: true },
    requestId: "unknown-test",
    model: "stub",
  };
  assert.equal(unknownModelOutcome(record), true);
  let calls = 0;
  const { review, root } = await reviewWith({
    model: async () => {
      calls += 1;
      throw Object.assign(new Error("模型超时。"), { modelRecord: record });
    },
  });
  try {
    const result = await review.proposeCandidates(paperBytes());
    assert.equal(calls, 1);
    assert.equal(result.status, "unknown");
    assert.equal(result.retried, false);
    assert.match(result.notice, /没有自动重试，也没有运行检查/);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.modelCalls, 1);
    assert.equal(result.theorem, "unknown");
    const archived = await review.store.get(result.root);
    assert.equal(archived.payload.unknown, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("several located values stay a mismatch when one line differs", async () => {
  let runs = 0;
  const { review, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The first total is 2.\nThe second total is 3." }],
    }),
    experiment: async () => {
      runs += 1;
      return { exitCode: 0, stdout: runs === 1 ? "2\n9\n" : "2\n3\n", stderr: "" };
    },
  });
  try {
    const paper = paperBytes();
    const run = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "两个总数。",
          code: "print(2); print(3)",
          expected: "2\n3",
        },
        {
          kind: "computation",
          statement: "重复的二。",
          code: "print(2)",
          expected: "2\n2",
        },
      ],
    });
    assert.deepEqual(
      run.csClaims.map((claim) => claim.outcome),
      ["mismatch", "source_unlocated"],
    );
    assert.equal(runs, 1);
    assert.equal(run.csClaims[0].certificate, null);
    assert.equal(run.csClaims[0].comparisons[0].matched, true);
    assert.equal(run.csClaims[0].comparisons[1].matched, false);
    assert.equal(run.csClaims[0].comparisons[1].actual, "9");
    assert.match(run.csClaims[0].reason, /对照「3」得到「9」/);
    assert.equal(run.conclusion.theorem, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a computation that does not finish does not list line comparisons", async () => {
  const { review, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The first total is 2." }],
    }),
    experiment: async () => ({
      exitCode: 1,
      stdout: "2\n",
      stderr: "stopped",
      termination: null,
    }),
  });
  try {
    const paper = paperBytes();
    const run = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "没有跑完。",
          code: "raise SystemExit(1)",
          expected: "2",
        },
      ],
    });
    assert.equal(run.csClaims[0].outcome, "execution_failed");
    assert.equal(run.csClaims[0].comparisons, undefined);
    assert.match(run.csClaims[0].reason, /没有正常结束/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a digit inside an ordinal is not a source value", async () => {
  let runs = 0;
  const { review, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The 2nd total is ready." }],
    }),
    experiment: async () => {
      runs += 1;
      return { exitCode: 0, stdout: "2\n", stderr: "" };
    },
  });
  try {
    const run = await settle(review, {
      ...paperBytes(),
      claims: [
        {
          kind: "computation",
          statement: "从序数里截二。",
          code: "print(2)",
          expected: "2",
        },
      ],
    });
    assert.equal(run.csClaims[0].outcome, "source_unlocated");
    assert.match(run.csClaims[0].reason, /只出现在更长的数字里/);
    assert.equal(runs, 0);
    assert.equal(run.conclusion.reviewComplete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a digit inside a longer number is not a source value", async () => {
  let runs = 0;
  const experiment = async () => {
    runs += 1;
    return { exitCode: 0, stdout: "2\n", stderr: "" };
  };
  const buried = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The stored total is 20." }],
    }),
    experiment,
  });
  const standalone = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The other total is 2. The stored total is 20." }],
    }),
    experiment,
  });
  try {
    const paper = paperBytes();
    const hidden = await settle(buried.review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "从二十里截二。",
          code: "print(2)",
          expected: "2",
        },
      ],
    });
    assert.equal(hidden.csClaims[0].outcome, "source_unlocated");
    assert.match(hidden.csClaims[0].reason, /只出现在更长的数字里/);
    assert.equal(runs, 0);
    assert.equal(
      locateEach([{ index: 0, text: "The count is 2,000." }], ["2"]).status,
      "embedded",
    );
    assert.equal(
      locateEach([{ index: 0, text: "The count is 2e10." }], ["2"]).status,
      "embedded",
    );
    assert.equal(
      locateEach([{ index: 0, text: "The counts are 2, 3." }], ["2"]).status,
      "unique",
    );
    assert.equal(
      locateEach([{ index: 0, text: "The counts are 2 3." }], ["2"]).status,
      "unique",
    );
    assert.equal(
      locateEach([{ index: 0, text: "The total is 12 000." }], ["12"]).status,
      "embedded",
    );
    assert.equal(
      locateEach([{ index: 0, text: "The total is 12 000." }], ["000"]).status,
      "embedded",
    );
    assert.equal(
      locateEach([{ index: 0, text: "The total is 12 000." }], ["12 000"]).status,
      "unique",
    );
    assert.equal(
      locateEach([{ index: 0, text: "The count is 2, 000." }], ["2"]).status,
      "embedded",
    );
    assert.equal(
      locateEach([{ index: 0, text: "The count is 1 000 000." }], ["1 000"]).status,
      "embedded",
    );
    assert.equal(
      locateEach([{ index: 0, text: "The reading is 2.0." }], ["2."]).status,
      "embedded",
    );
    assert.equal(
      locateEach([{ index: 0, text: "The count is 2." }], ["2."]).status,
      "unique",
    );
    assert.equal(
      locateEach([{ index: 0, text: "The budget is 12,000." }], ["2,000"]).status,
      "embedded",
    );
    assert.equal(
      locateEach([{ index: 0, text: "The budget is 2,000." }], ["2,000"]).status,
      "unique",
    );
    assert.equal(
      locateEach([{ index: 0, text: "The 2nd total is ready." }], ["2"]).status,
      "embedded",
    );
    assert.equal(
      locateEach([{ index: 0, text: "Figure 2 shows the total." }], ["2"]).status,
      "unique",
    );
    assert.equal(
      locateEach([{ index: 0, text: "The count is 2." }], ["2", "2"]).status,
      "used",
    );
    const shown = await settle(standalone.review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "独立的二。",
          code: "print(2)",
          expected: "2",
        },
      ],
    });
    assert.equal(shown.csClaims[0].outcome, "reproduced");
    assert.equal(runs, 1);
  } finally {
    await rm(buried.root, { recursive: true, force: true });
    await rm(standalone.root, { recursive: true, force: true });
  }
});

test("a repeated expected value needs another independent occurrence", async () => {
  let runs = 0;
  const { review, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The count is 2." }],
    }),
    experiment: async () => {
      runs += 1;
      return { exitCode: 0, stdout: "2\n2\n", stderr: "" };
    },
  });
  try {
    const run = await settle(review, {
      ...paperBytes(),
      claims: [
        {
          kind: "computation",
          statement: "同一个二写了两行。",
          code: "print(2)",
          expected: "2\n2",
        },
      ],
    });
    assert.equal(run.csClaims[0].outcome, "source_unlocated");
    assert.match(run.csClaims[0].reason, /没有另一处独立出现/);
    assert.equal(runs, 0);
    assert.equal(run.conclusion.theorem, "unknown");
    assert.equal(run.conclusion.reviewComplete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a numeric candidate inside a longer number stays unlocated", async () => {
  const { review, calls, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The stored total is 20." }],
    }),
    model: async () => ({
      parsed: { candidates: [{ sentence: "2", kind: "computation" }] },
      record: { requestId: "embedded-candidate", model: "stub", finishReason: "stop" },
    }),
  });
  try {
    const result = await review.proposeCandidates(paperBytes());
    assert.equal(result.candidates[0].status, "source_unlocated");
    assert.match(result.candidates[0].reason, /只出现在更长的数字里/);
    assert.equal(calls.experiment, 0);
    assert.equal(calls.checker, 0);
    assert.equal(calls.rocq, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trailing spaces and a blank line stay mismatches", async () => {
  const { review, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The stored total is 2. The other total is 3." }],
    }),
    experiment: async (_workspace, code) => ({
      exitCode: 0,
      stdout: code.includes("blank")
        ? "2\n\n"
        : code.includes("pair")
          ? "2\n3\n\n"
          : "2 \n",
      stderr: "",
    }),
  });
  try {
    const paper = paperBytes();
    const spaced = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "行尾空格不能算一致。",
          code: "print('spaced')",
          expected: "2",
        },
      ],
    });
    assert.equal(spaced.csClaims[0].outcome, "mismatch");
    assert.equal(spaced.csClaims[0].comparisons[0].actual, "2 ");
    assert.equal(spaced.csClaims[0].comparisons[0].toleranceUsed, false);
    assert.match(spaced.csClaims[0].reason, /不符/);
    const blank = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "多出的空行不能算一致。",
          code: "print('blank')",
          expected: "2",
        },
      ],
    });
    assert.equal(blank.csClaims[0].outcome, "mismatch");
    assert.equal(blank.csClaims[0].comparisons[1].actual, "");
    assert.match(blank.csClaims[0].reason, /空行/);
    const pair = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "两行后面的空行也不能算一致。",
          code: "print('pair')",
          expected: "2\n3",
        },
      ],
    });
    assert.equal(pair.csClaims[0].outcome, "mismatch");
    assert.equal(pair.conclusion.theorem, "unknown");
    assert.equal(pair.conclusion.reviewComplete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an extra output line is recorded as having no source value", async () => {
  const { review, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The first total is 2.\nThe second total is 3." }],
    }),
    experiment: async () => ({ exitCode: 0, stdout: "2\n3\n4\n", stderr: "" }),
  });
  try {
    const paper = paperBytes();
    const run = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "多了一行。",
          code: "print(2); print(3); print(4)",
          expected: "2\n3",
        },
      ],
    });
    assert.equal(run.csClaims[0].outcome, "mismatch");
    assert.equal(run.csClaims[0].comparisons[2].expected, "");
    assert.equal(run.csClaims[0].comparisons[2].actual, "4");
    assert.match(run.csClaims[0].reason, /多出「4」/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an archived extra file is replayed without a new expected value", async () => {
  const seen = [];
  const { review, store, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The stored total is 2." }],
    }),
    experiment: async (_workspace, _code, options) => {
      seen.push(options.files);
      return { exitCode: 0, stdout: "2\n", stderr: "" };
    },
  });
  try {
    const paper = paperBytes();
    const first = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "读出二。",
          code: "print(open('data.txt').read())",
          expected: "2",
          command: "python3 experiment.py",
          files: [{ name: "data.txt", content: "2" }],
        },
      ],
    });
    await assert.rejects(
      review.replay(first.id, { files: [{ name: "data.txt", content: "9" }] }),
      /不接受新的期望输出/,
    );
    const replayed = await review.replay(first.id, {});
    const preserved = await store.getRun(first.id);
    assert.equal(seen[1][0].content, "2");
    assert.equal(preserved.root, first.root);
    assert.equal(preserved.csClaims[0].outcome, "reproduced");
    assert.equal(replayed.previousRoot, first.root);
    assert.notEqual(replayed.root, first.root);
    assert.equal(replayed.modelInvoked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an extra module beside the program can be imported", async () => {
  const { review, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The helper total is 2." }],
    }),
    experiment: runNumericExperiment,
  });
  try {
    const paper = paperBytes();
    const imported = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "旁边的模块也能被程序导入。",
          code: "import helper\nprint(helper.VALUE)\n",
          expected: "2",
          files: [{ name: "helper.py", content: "VALUE = 2\n" }],
        },
      ],
    });
    assert.equal(imported.csClaims[0].outcome, "reproduced");
    assert.match(imported.csClaims[0].reason, /不是数学证明/);
    assert.equal(imported.csClaims[0].execution.files[0].name, "helper.py");
    assert.equal(imported.csClaims[0].certificate, null);
    assert.equal(imported.conclusion.theorem, "unknown");
    assert.equal(imported.conclusion.reviewComplete, false);
    const opened = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "数据文件仍按原文对照。",
          code: "print(open('data.txt').read(), end='')\n",
          expected: "2",
          files: [{ name: "data.txt", content: "2" }],
        },
      ],
    });
    assert.equal(opened.csClaims[0].outcome, "reproduced");
    assert.match(opened.csClaims[0].reason, /不是数学证明/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an extra file cannot replace the program or collide by case", async () => {
  let runs = 0;
  const { review, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The count is 2." }],
    }),
    experiment: async () => {
      runs += 1;
      return { exitCode: 0, stdout: "2\n", stderr: "" };
    },
  });
  try {
    const paper = paperBytes();
    const replaced = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "换掉主程序。",
          code: "print(2)",
          expected: "2",
          command: "python3 experiment.py",
          files: [{ name: "Experiment.py", content: "print(9)\n" }],
        },
      ],
    });
    assert.equal(replaced.csClaims[0].outcome, "not_run");
    assert.match(replaced.csClaims[0].reason, /不能替换主程序/);
    const collided = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "computation",
          statement: "两个文件名相撞。",
          code: "print(2)",
          expected: "2",
          files: [
            { name: "data.txt", content: "2" },
            { name: "Data.txt", content: "9" },
          ],
        },
      ],
    });
    assert.equal(collided.csClaims[0].outcome, "not_run");
    assert.match(collided.csClaims[0].reason, /不区分大小写/);
    assert.equal(runs, 0);
    assert.equal(collided.conclusion.theorem, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a TLA config without an invariant does not start TLC", async () => {
  let runs = 0;
  const { review, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The counter stays non-negative." }],
    }),
    tla: async () => {
      runs += 1;
      return {
        ready: true,
        make: "ok",
        bound: 3,
        boundRecorded: true,
        counterexample: false,
        commands: ["make check", "make bound"],
      };
    },
  });
  try {
    const run = await settle(review, {
      ...paperBytes(),
      claims: [
        {
          kind: "mechanized_artifact",
          prover: "tla",
          statement: "没有不变量。",
          quote: "The counter stays non-negative.",
          source: "---- MODULE Paper ----\n====\n",
          config: "SPECIFICATION Spec\n\\* INVARIANT Inv\n",
          bound: 3,
        },
      ],
    });
    assert.equal(run.csClaims[0].outcome, "not_run");
    assert.match(run.csClaims[0].reason, /没有不变量或性质/);
    assert.equal(runs, 0);
    assert.equal(run.conclusion.reviewComplete, false);
    const direct = await checkTlaArtifact("---- MODULE Paper ----\n====\n", {
      config: "SPECIFICATION Spec\n",
      bound: 3,
    });
    assert.equal(direct.make, "not_run");
    assert.equal(direct.counterexample, false);
    const disabled = await checkTlaArtifact("---- MODULE Paper ----\n====\n", {
      config: "SPECIFICATION Spec\nINVARIANT Inv\nCHECK_DEADLOCK FALSE\n",
      bound: 3,
    });
    assert.equal(disabled.make, "not_run");
    assert.match(disabled.reason, /关闭了死锁检查/);
    const narrowed = await checkTlaArtifact("---- MODULE Paper ----\n====\n", {
      config: "SPECIFICATION Spec\nINVARIANT Inv\nCONSTRAINT Inv\n",
      bound: 3,
    });
    assert.equal(narrowed.make, "not_run");
    assert.match(narrowed.reason, /会藏起一部分行为/);
    const vacuous = await checkTlaArtifact("---- MODULE Paper ----\n====\n", {
      config: "INIT Init\nNEXT Next\nINVARIANT TRUE\n",
      bound: 4,
    });
    assert.equal(vacuous.make, "not_run");
    assert.match(vacuous.reason, /恒为 TRUE/);
    const propertyTrue = await checkTlaArtifact("---- MODULE Paper ----\n====\n", {
      config: "INIT Init\nNEXT Next\nPROPERTIES\nTRUE\n",
      bound: 4,
    });
    assert.equal(propertyTrue.make, "not_run");
    assert.match(propertyTrue.reason, /恒为 TRUE/);
    const multiline = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source: "---- MODULE Paper ----\n====\n",
        config: "INIT Init\nNEXT Next\nINVARIANTS\nTRUE\n",
        bound: 4,
      },
      [],
    );
    assert.equal(multiline.outcome, "not_run");
    assert.match(multiline.reason, /恒为 TRUE/);
    const mixed = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source: "---- MODULE Paper ----\n====\n",
        config: "INIT Init\nNEXT Next\nINVARIANT Inv\nPROPERTY TRUE\n",
        bound: 4,
      },
      [],
    );
    assert.equal(mixed.disposition, "execute_tla");
    const alias = await checkTlaArtifact(
      "---- MODULE Paper ----\nInv == TRUE\n====\n",
      {
        config: "INIT Init\nNEXT Next\nINVARIANT Inv\n",
        bound: 4,
      },
    );
    assert.equal(alias.make, "not_run");
    assert.match(alias.reason, /恒为 TRUE/);
    const localTrue = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source: "---- MODULE Paper ----\nLOCAL Inv == TRUE\n====\n",
        config: "INIT Init\nNEXT Next\nINVARIANT Inv\n",
        bound: 4,
      },
      [],
    );
    assert.equal(localTrue.outcome, "not_run");
    const folded = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source: "---- MODULE Paper ----\nInv ==\n  (TRUE)\n====\n",
        config: "INIT Init\nNEXT Next\nINVARIANT Inv\n",
        bound: 4,
      },
      [],
    );
    assert.equal(folded.outcome, "not_run");
    const commentedTrue = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source:
          "---- MODULE Paper ----\n\\* Inv == TRUE\n(* Inv == TRUE *)\nInv == x < 1\n====\n",
        config: "INIT Init\nNEXT Next\nINVARIANT Inv\n",
        bound: 4,
      },
      [],
    );
    assert.equal(commentedTrue.disposition, "execute_tla");
    const overridden = await checkTlaArtifact(
      "---- MODULE Paper ----\nInv == x < 1\n====\n",
      {
        config: "CONSTANT Inv = TRUE\nINIT Init\nNEXT Next\nINVARIANT Inv\n",
        bound: 4,
      },
    );
    assert.equal(overridden.make, "not_run");
    assert.match(overridden.reason, /恒为 TRUE/);
    const chained = await checkTlaArtifact(
      "---- MODULE Paper ----\nCONSTANTS A\nInv == x < 1\n====\n",
      {
        config:
          "CONSTANT A = TRUE\nInv <- A\nINIT Init\nNEXT Next\nINVARIANT Inv\n",
        bound: 4,
      },
    );
    assert.equal(chained.make, "not_run");
    assert.match(chained.reason, /恒为 TRUE/);
    const hidden = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source: "---- MODULE Paper ----\nInv == TRUE \\/ x < 1\n====\n",
        config: "INIT Init\nNEXT Next\nINVARIANT Inv\n",
        bound: 4,
      },
      [],
    );
    assert.equal(hidden.outcome, "not_run");
    const implied = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source: "---- MODULE Paper ----\nInv == x < 1 => TRUE\n====\n",
        config: "INIT Init\nNEXT Next\nINVARIANT Inv\n",
        bound: 4,
      },
      [],
    );
    assert.equal(implied.outcome, "not_run");
    const stillChecked = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source: "---- MODULE Paper ----\nInv == TRUE /\\ x < 1\n====\n",
        config: "INIT Init\nNEXT Next\nINVARIANT Inv\n",
        bound: 4,
      },
      [],
    );
    assert.equal(stillChecked.disposition, "execute_tla");
    const boxed = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source: "---- MODULE Paper ----\nLive == [](TRUE \\/ x < 1)\n====\n",
        config: "INIT Init\nNEXT Next\nPROPERTY Live\n",
        bound: 4,
      },
      [],
    );
    assert.equal(boxed.outcome, "not_run");
    assert.match(boxed.reason, /恒为 TRUE/);
    const holds = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source: "---- MODULE Paper ----\nLive == [](x >= 0)\n====\n",
        config: "INIT Init\nNEXT Next\nPROPERTY Live\n",
        bound: 4,
      },
      [],
    );
    assert.equal(holds.disposition, "execute_tla");
    const nested = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source: "---- MODULE Paper ----\nLive == [][]TRUE\n====\n",
        config: "INIT Init\nNEXT Next\nPROPERTY Live\n",
        bound: 4,
      },
      [],
    );
    assert.equal(nested.disposition, "execute_tla");
    const compact = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source: "---- MODULE Paper ----\nLive == <>(x = 5)\n====\n",
        config: "CONSTANT Live<-TRUE\nINIT Init\nNEXT Next\nPROPERTY Live\n",
        bound: 4,
      },
      [],
    );
    assert.equal(compact.outcome, "not_run");
    const unrelated = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source: "---- MODULE Paper ----\nInv == x < 1\n====\n",
        config: "CONSTANT N = TRUE\nINIT Init\nNEXT Next\nINVARIANT Inv\n",
        bound: 4,
      },
      [],
    );
    assert.equal(unrelated.disposition, "execute_tla");
    const commented = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source: "---- MODULE Paper ----\n====\n",
        config: "SPECIFICATION Spec\nINVARIANT Inv\n\\* CONSTRAINT Inv\n",
        bound: 3,
      },
      [],
    );
    assert.equal(commented.disposition, "execute_tla");
    const property = classifyCsClaim(
      {
        kind: "mechanized_artifact",
        prover: "tla",
        source: "---- MODULE Paper ----\n====\n",
        config: "SPECIFICATION Spec\nPROPERTY Live\n",
        bound: 3,
      },
      [],
    );
    assert.equal(property.disposition, "execute_tla");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bounded TLA search is not proof completion and keeps the old root", async () => {
  let runs = 0;
  const { review, store, root } = await reviewWith({
    extract: async () => ({
      pages: [{ index: 0, text: "The counter stays non-negative." }],
    }),
    tla: async () => {
      runs += 1;
      return {
        ready: true,
        make: runs === 1 ? "ok" : "counterexample",
        bound: 3,
        boundRecorded: true,
        counterexample: runs !== 1,
        commands: ["make check", "make bound"],
        version: "1.7.4",
        jarSha256: "abc",
      };
    },
    model: async () => {
      throw new Error("重放不应请求模型。");
    },
  });
  try {
    const paper = paperBytes();
    const first = await settle(review, {
      ...paper,
      claims: [
        {
          kind: "mechanized_artifact",
          prover: "tla",
          statement: "The counter stays non-negative.",
          quote: "The counter stays non-negative.",
          source: "---- MODULE Paper ----\n====\n",
          config: "SPECIFICATION Spec\nINVARIANT Inv\n",
          bound: 3,
        },
        {
          kind: "mechanized_artifact",
          prover: "isabelle",
          statement: "Isabelle stays unwired.",
          source: "lemma foo: True",
        },
      ],
    });
    assert.equal(first.csClaims[0].outcome, "bounded_checked");
    assert.equal(first.csClaims[0].certificate, null);
    assert.equal(
      first.csClaims[0].columns.bound,
      "仿真 1 条行为，深度不超过 3 层，其余行为与更深处未检查",
    );
    assert.equal(first.csClaims[1].outcome, "unsupported_prover");
    assert.equal(first.csClaims[1].label, "机器证明工件");
    assert.deepEqual(first.conclusion.provedClaimIds, []);
    await assert.rejects(review.replay(first.id, { bound: 9 }), /不接受新的期望输出/);
    const replayed = await review.replay(first.id, {});
    const preserved = await store.getRun(first.id);
    assert.equal(preserved.csClaims[0].outcome, "bounded_checked");
    assert.equal(preserved.root, first.root);
    assert.equal(replayed.csClaims[0].outcome, "bounded_counterexample");
    assert.equal(replayed.conclusion.differs, true);
    assert.equal(replayed.previousRoot, first.root);
    assert.equal(replayed.modelInvoked, false);
    assert.equal(replayed.conclusion.theorem, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
