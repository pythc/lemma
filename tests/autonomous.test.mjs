import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AutonomousReview } from "../server/autonomous.mjs";
import { EvidenceStore, sha256, inspectBundle } from "../server/evidence.mjs";
import { ResourcePool } from "../server/resource-pool.mjs";
import {
  sourceAnchors,
  decision,
  referenceIdentity,
  activeFormalization,
} from "../server/autonomy-schema.mjs";
import { reviewMetrics } from "../server/review-metrics.mjs";

const bytes = Buffer.from("fixture parser input, not a real paper");
const q1 =
  "Every bounded sequence of real numbers has a convergent subsequence.";
const q2 = "For every natural number n, n + 0 = n.";
const source = {
  paperSha256: sha256(bytes),
  pageCount: 2,
  pages: [
    { index: 0, text: q1 },
    { index: 1, text: q2 },
  ],
};
const input = {
  paperSha256: source.paperSha256,
  pdfBase64: bytes.toString("base64"),
};
const inspected = (claim) => ({
  status: "unresolved",
  summary: "执行机制样本，数学结论仍未知。",
  anchors: [claim.anchor],
  assumptions: ["固定原文"],
  steps: ["检查已给出的条件；缺少实际推导，保留未知。"],
  dependencies: ["尚缺原证明"],
  nextQuestion: "",
});
const finish = (req) => ({
  mode: "finish",
  reason: "本次受控检查完成，保留未知。",
  coverage: req.input.claims.map((c) => ({
    claimId: c.id,
    formalization: "not_attempted",
    reason: "测试样本只验证调度，不冒充数学验证。",
  })),
});
const action = (req, kind, claim, index = 0) => ({
  kind,
  claimId: claim.id,
  title: `检查 ${claim.label}`,
  question: `具体问题 ${index}`,
  reason: "读取后的具体问题。",
  strategy: `策略 ${index}`,
  basedOn: [
    req.input.tasks.filter((t) => t.hasEvidence && t.kind !== "diagnose").at(-1)
      .id,
  ],
});
function script(hook = () => {}) {
  const calls = [];
  return {
    calls,
    model: async (_, req) => {
      calls.push({ role: req.role, input: req.input, at: Date.now() });
      let parsed = await hook(req);
      if (!parsed) {
        if (req.role === "A_READ")
          parsed = {
            summary: "两条用于调度测试的命题。",
            claims: req.input.pages.map((p) => ({
              label: `T${p.pageIndex}`,
              pageIndex: p.pageIndex,
              quote: p.text,
              statement: p.text,
            })),
          };
        else if (req.role === "A_ENV")
          parsed = {
            summary: "不同命题选择各自环境。",
            choices: req.input.paperMap.claims.map((c, i) => ({
              claimId: c.id,
              profile: i ? "std-v1" : "analysis-continuity-v1",
              reason: "依据数学对象选择。",
              queries: [],
              names: [],
            })),
          };
        else if (req.role === "A_COORDINATOR")
          parsed = req.input.tasks.some((t) => t.kind === "inspect_proof")
            ? finish(req)
            : {
                mode: "act",
                reason: "两项互不依赖的检查。",
                actions: req.input.claims.map((c, i) =>
                  action(req, i ? "inspect_definitions" : "inspect_proof", c),
                ),
              };
        else if (req.role === "A_DIAGNOSE")
          parsed = {
            category: "contract",
            action: "retry",
            guidance: "返回符合约定的字段，引用保持原文精确位置。",
          };
        else parsed = inspected(req.input.claim);
      }
      return {
        parsed,
        record: {
          testFixture: true,
          role: req.role,
          responseModel: "fixture",
          requestId: `fixture-${calls.length}`,
        },
      };
    },
  };
}
async function settled(
  a,
  id,
  statuses = [
    "completed",
    "blocked",
    "awaiting_confirmation",
    "paused",
    "cancelled",
  ],
) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const r = await a.store.getRun(id);
    if (statuses.includes(r.status) && !a.active.has(id)) return r;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Timed out: " + JSON.stringify(await a.store.getRun(id)));
}
async function harness(fn, hook, opts = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-autonomous-"));
  const store = new EvidenceStore(dir),
    s = script(hook);
  const a = new AutonomousReview({
    store,
    pipeline: { active: new Map(), reserved: false },
    getConfig: async () => ({ model: "fixture" }),
    model: s.model,
    extract: async () => source,
    probe: async () => ({
      ready: true,
      probe: { testFixture: true },
      scope: "environment_only_not_paper_verification",
    }),
    testFixture: true,
    autonomousSemantics: false,
    sourceScopes: false, // Legacy scheduler fixtures; separate tests cover scope selection.
    ...opts,
  });
  await a.init();
  try {
    await fn(a, s, dir);
  } finally {
    await a.close();
    await rm(dir, { recursive: true, force: true });
  }
}
test("direct start reads all pages before per-claim routing, runs independent workers concurrently and exports complete evidence", async () => {
  let running = 0,
    max = 0;
  await harness(
    async (a, s) => {
      const r = await settled(a, (await a.start(input)).id);
      assert.equal(r.status, "blocked", r.error);
      assert.equal(r.conclusion.reviewComplete, false);
      assert.equal(r.libraryProfile, null);
      assert.deepEqual(r.paperMap.readPages, [0, 1]);
      assert.equal(max, 2);
      assert.ok(
        s.calls.findIndex((c) => c.role === "A_ENV") >
          s.calls.findIndex((c) => c.role === "A_READ"),
      );
      assert.deepEqual(
        r.claims.map((c) => c.libraryProfile),
        ["analysis-continuity-v1", "std-v1"],
      );
      assert.equal(r.conclusion.statistics.actualLeanClaimChecks, 0);
      assert.equal(r.conclusion.unresolvedClaims.length, 2);
      assert.equal(r.coverage.length, 2);
      inspectBundle(await a.store.bundle(r.root), r.root);
    },
    async (req) => {
      if (["A_PROOF", "A_DEFINITION"].includes(req.role)) {
        running++;
        max = Math.max(max, running);
        await new Promise((r) => setTimeout(r, 120));
        running--;
        return inspected(req.input.claim);
      }
    },
  );
});
test("reading repair distinguishes changed source locators and accepts a short locator before full scope selection", async () => {
  let reads = 0;
  await harness(
    async (a, s) => {
      const r = await settled(a, (await a.start(input)).id);
      assert.equal(r.status, "blocked", r.error);
      assert.equal(r.conclusion.reviewComplete, false);
      const readingTask = r.tasks.find((t) => t.kind === "read");
      assert.equal(readingTask.attempts.length, 3);
      assert.notEqual(
        readingTask.attempts[0].failureFingerprint,
        readingTask.attempts[1].failureFingerprint,
      );
      assert.equal(r.claims[0].anchor.quote, "Every bounded sequence");
      assert.equal(
        r.claims[0].status,
        "unresolved",
        "A locator is not theorem verification",
      );
      const diagnostics = s.calls.filter((c) => c.role === "A_DIAGNOSE");
      assert.equal(diagnostics.length, 2);
      assert.equal(diagnostics[0].input.sourceValidation.claimIndex, 0);
      assert.equal(diagnostics[0].input.sourceValidation.pageIndex, 0);
      const artifact = await a.store.get(readingTask.attempts[0].output);
      assert(artifact.payload.readingValidation.quoteHash);
    },
    (req) => {
      if (req.role !== "A_READ") return;
      reads++;
      if (reads > 1) assert(req.input.repairFeedback.failureArtifact);
      return {
        summary: "Controlled source locator repair.",
        claims: [
          {
            label: "T0",
            pageIndex: 0,
            quote:
              reads === 1
                ? "Wrong source locator A"
                : reads === 2
                  ? "Wrong source locator B"
                  : "Every bounded sequence",
            statement: q1,
          },
          { label: "T1", pageIndex: 1, quote: q2, statement: q2 },
        ],
      };
    },
  );
});
test("renaming the same invalid reading locator cannot reset recovery", async () => {
  let reads = 0;
  await harness(
    async (a, s) => {
      const r = await settled(a, (await a.start(input)).id, ["blocked"]);
      assert.equal(r.status, "blocked");
      assert.equal(r.claims.length, 0);
      assert.equal(reads, 2);
      assert.equal(s.calls.filter((c) => c.role === "A_DIAGNOSE").length, 1);
      const task = r.tasks.find((t) => t.kind === "read");
      assert.equal(
        task.attempts[0].failureFingerprint,
        task.attempts[1].failureFingerprint,
      );
      assert.equal(task.recoveryStop, "repeated_failure_without_progress");
    },
    (req) => {
      if (req.role !== "A_READ") return;
      reads++;
      return {
        summary: "Controlled unchanged source failure.",
        claims: [
          {
            label: "renamed " + reads,
            pageIndex: 0,
            quote: "A nonexistent source sentence.",
            statement: q1,
          },
        ],
      };
    },
  );
});
test("a fast branch can advance while an independent slow branch is still running", async () => {
  let releaseSlow;
  const gate = new Promise((resolve) => (releaseSlow = resolve));
  let slowRunning = false,
    advanced = false;
  await harness(
    async (a) => {
      const r = await settled(a, (await a.start(input)).id);
      assert.equal(r.status, "blocked", r.error);
      assert.equal(r.conclusion.reviewComplete, false);
      assert.equal(advanced, true);
    },
    async (req) => {
      if (req.role === "A_PROOF") {
        slowRunning = true;
        await Promise.race([
          gate,
          new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(Error("Independent branch never advanced")),
              8000,
            );
            timer.unref();
          }),
        ]);
        slowRunning = false;
        return inspected(req.input.claim);
      }
      if (req.role === "A_DEFINITION") {
        await new Promise((r) => setTimeout(r, 50));
        return inspected(req.input.claim);
      }
      if (
        req.role === "A_COORDINATOR" &&
        req.input.tasks.some(
          (t) => t.kind === "inspect_definitions" && t.status === "succeeded",
        ) &&
        !req.input.tasks.some((t) => t.kind === "counterexample")
      )
        return {
          mode: "act",
          reason: "快速分支已返回。",
          actions: [action(req, "counterexample", req.input.claims[1], 1)],
        };
      if (req.role === "A_COUNTEREXAMPLE") {
        advanced = slowRunning;
        releaseSlow();
        return { ...inspected(req.input.claim), counterexample: null };
      }
    },
  );
});
test("bad anchors invoke a diagnostic child, retain raw response and retry the same logical task", async () => {
  let failed = false;
  await harness(
    async (a) => {
      const r = await settled(a, (await a.start(input)).id);
      assert.equal(r.status, "blocked", r.error);
      assert.equal(r.conclusion.reviewComplete, false);
      const tasks = r.tasks.filter((t) => t.kind === "inspect_proof");
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].attempts.length, 2);
      assert.equal(tasks[0].error, null);
      assert.equal(tasks[0].attempts[0].status, "failed");
      assert.ok(tasks[0].attempts[0].responseArtifact);
      assert.ok(
        r.tasks.some(
          (t) => t.kind === "diagnose" && t.recoveryFor === tasks[0].id,
        ),
      );
      inspectBundle(await a.store.bundle(r.root), r.root);
    },
    async (req) => {
      if (req.role === "A_PROOF" && !failed) {
        failed = true;
        return {
          ...inspected(req.input.claim),
          anchors: [
            {
              pageIndex: 0,
              quote: "This fabricated text is not in the paper.",
            },
          ],
        };
      }
    },
  );
});
test("unknown transport outcome stops only that branch and is never automatically replayed", async () => {
  let calls = 0;
  await harness(
    async (a) => {
      const r = await settled(a, (await a.start(input)).id);
      assert.equal(r.status, "blocked", r.error);
      assert.equal(r.conclusion.reviewComplete, false);
      assert.equal(calls, 1);
      assert.equal(
        r.tasks.find((t) => t.kind === "inspect_proof").status,
        "unresolved",
      );
      assert.equal(
        r.tasks.find((t) => t.kind === "inspect_definitions").status,
        "succeeded",
      );
      assert.equal(r.conclusion.theorem, "unknown");
    },
    async (req) => {
      if (req.role === "A_PROOF") {
        calls++;
        throw Error("fixture transport interrupted, outcome unknown");
      }
    },
  );
});
test("pause checkpoints then resumes without rereading or reselecting environment", async () => {
  let release;
  const barrier = new Promise((r) => (release = r));
  await harness(
    async (a, s) => {
      const id = (await a.start(input)).id;
      await a.pause(id);
      release();
      assert.equal((await settled(a, id)).status, "paused");
      const snapshot = await a.autonomousGraph.getState({
        configurable: { thread_id: id },
      });
      assert.ok(snapshot.tasks.some((t) => t.interrupts?.length));
      await a.resume(id);
      assert.equal((await settled(a, id)).status, "blocked");
      assert.equal(s.calls.filter((c) => c.role === "A_READ").length, 1);
      assert.equal(s.calls.filter((c) => c.role === "A_ENV").length, 1);
    },
    async (req) => {
      if (req.role === "A_READ") await barrier;
    },
  );
});
test("safe source repair maps punctuation spacing and adjacent-page spans, rejects different symbols and ambiguous anchors", () => {
  const s = {
    pages: [
      { index: 0, text: "Choose epsilon . Then take a finite interval" },
      { index: 1, text: "containing the center. End of proof." },
    ],
  };
  const parts = sourceAnchors(
    {
      pageIndex: 0,
      quote:
        "Choose epsilon. Then take a finite interval containing the center.",
    },
    s,
  );
  assert.equal(parts.length, 2);
  assert.equal(parts[0].quote, "Choose epsilon . Then take a finite interval");
  assert.throws(() =>
    sourceAnchors(
      { pageIndex: 0, quote: "Choose delta. Then take a finite interval" },
      s,
    ),
  );
  assert.throws(() =>
    sourceAnchors(
      { pageIndex: 0, quote: "Choose epsilon ." },
      { pages: [{ index: 0, text: "Choose epsilon . Choose epsilon ." }] },
    ),
  );
});
test("resource queue never starts aborted work and enforces actual execution limit", async () => {
  const pool = new ResourcePool(1);
  let release,
    second = false;
  const first = pool.run(() => new Promise((r) => (release = r)));
  await new Promise((r) => setTimeout(r, 5));
  const controller = new AbortController();
  const waiting = pool.run(
    () => {
      second = true;
    },
    { signal: controller.signal },
  );
  const assertion = assert.rejects(waiting);
  controller.abort();
  await assertion;
  release();
  await first;
  assert.equal(second, false);
  assert.deepEqual(pool.snapshot(), { limit: 1, running: 0, queued: 0 });
});

test("a pending semantic gate does not stop an independent claim; skip leaves the missing proof explicit", async () => {
  await harness(
    async (a) => {
      a.pipeline.reserve = (action) => action();
      a.pipeline.startReserved = async (input, internal) => {
        const child = {
          id: internal.runId,
          parentReviewId: internal.parentReviewId,
          parentTaskId: internal.parentTaskId,
          status: "awaiting_confirmation",
          paperSha256: input.paperSha256,
          contract: null,
          approval: null,
          check: null,
          tasks: [],
        };
        await a.store.saveRun(child);
        return child;
      };
      const id = (await a.start(input)).id;
      let r = await settled(a, id);
      assert.equal(r.status, "awaiting_confirmation", r.error);
      assert.equal(
        r.tasks.find((t) => t.kind === "inspect_definitions").status,
        "succeeded",
      );
      const formal = r.tasks.find((t) => t.childRunId);
      assert.equal((await a.store.getRun(formal.childRunId)).approval, null);
      await a.skipChild(id, formal.id);
      await a.continueChildren();
      r = await settled(a, id, ["completed", "blocked"]);
      assert.equal(r.status, "blocked", r.error);
      assert.equal(r.conclusion.reviewComplete, false);
      assert.equal(r.conclusion.statistics.actualLeanClaimChecks, 0);
      assert.equal(r.claims[0].formalResult.status, "cancelled");
    },
    async (req) => {
      if (req.role === "A_COORDINATOR")
        return req.input.tasks.some((t) => t.kind === "formalize")
          ? {
              ...finish(req),
              coverage: req.input.claims.map((c, i) => ({
                claimId: c.id,
                formalization: i ? "not_attempted" : "attempted",
                reason: "实际子任务状态决定核验记录。",
              })),
            }
          : {
              mode: "act",
              reason: "独立工作并行。",
              actions: [
                action(req, "formalize", req.input.claims[0]),
                action(req, "inspect_definitions", req.input.claims[1]),
              ],
            };
    },
  );
});

for (const outcome of [
  "blocked",
  "no_candidate",
  "external_unknown",
  "auxiliary_unknown",
]) {
  const completedWithoutCandidate = outcome !== "blocked";
  test(`formalization ${outcome} diagnoses recovery while preserving the target and unknown external outcomes`, async () => {
    let recovered = 0;
    await harness(
      async (a) => {
        a.pipeline.reserve = (fn) => fn();
        a.pipeline.startReserved = async (input, internal) => {
          const child = {
            id: internal.runId,
            parentReviewId: internal.parentReviewId,
            parentTaskId: internal.parentTaskId,
            status: completedWithoutCandidate ? "completed" : "blocked",
            error: "缺少定义，领域不足",
            pendingObligations: [{ type: "definition" }],
            paperSha256: input.paperSha256,
            ...(outcome === "auxiliary_unknown"
              ? { domainRecovery: { externalOutcomeUnknown: true } }
              : {}),
            tasks: [],
            approval: completedWithoutCandidate
              ? { confirmed: true, targetHash: "a".repeat(64) }
              : null,
            contract: completedWithoutCandidate
              ? { targetHash: "a".repeat(64) }
              : null,
            ...(completedWithoutCandidate
              ? {
                  provingSearch: {
                    stopReason:
                      outcome === "external_unknown"
                        ? "external_outcome_unknown"
                        : "model_budget",
                    environmentSuggestions: [
                      { queries: ["missing"], matches: [] },
                    ],
                  },
                }
              : {}),
          };
          await a.store.saveRun(child);
          return child;
        };
        a.pipeline.recoverDomain = async (previous, input, internal) => {
          recovered++;
          const old = await a.store.getRun(previous);
          const child = {
            ...old,
            id: internal.runId,
            parentTaskId: internal.parentTaskId,
            continuedFrom: previous,
            status: "awaiting_confirmation",
            error: null,
            approval: null,
          };
          await a.store.saveRun(child);
          return child;
        };
        const id = (await a.start(input)).id;
        const r = await settled(a, id);
        const diagnosis = r.tasks.find((t) => t.kind === "diagnose_child");
        assert.equal(diagnosis.status, "succeeded");
        if (outcome === "external_unknown" || outcome === "auxiliary_unknown") {
          assert.equal(r.status, "blocked", r.error);
          assert.equal(r.conclusion.reviewComplete, false);
          assert.equal(recovered, 0);
          assert.ok(!r.tasks.some((t) => t.kind === "recover_domain"));
          return;
        }
        assert.equal(r.status, "awaiting_confirmation", r.error);
        assert.equal(recovered, 1);
        if (completedWithoutCandidate)
          assert.equal(
            r.tasks.find((t) => t.kind === "formalize").status,
            "unresolved",
          );
        const recovery = r.tasks.find((t) => t.kind === "recover_domain");
        assert.ok(recovery.parents.includes(diagnosis.id));
        const child = await a.store.getRun(recovery.childRunId);
        assert.equal(child.parentTaskId, recovery.id);
        assert.equal(child.approval, null);
        await a.cancel(id);
      },
      async (req) => {
        if (req.role === "A_CHILD_DIAGNOSE") {
          if (completedWithoutCandidate)
            assert.equal(
              req.input.child.provingSearch.stopReason,
              outcome === "external_unknown"
                ? "external_outcome_unknown"
                : "model_budget",
            );
          return {
            action: "recover_domain",
            guidance: "根据实际缺失定义启动领域补全，不改变目标。",
          };
        }
        if (req.role === "A_COORDINATOR")
          return req.input.tasks.some((t) => t.kind === "formalize")
            ? {
                ...finish(req),
                coverage: req.input.claims.map((c, i) => ({
                  claimId: c.id,
                  formalization: i ? "not_attempted" : "attempted",
                  reason: "形式化返回待补定义或待确认。",
                })),
              }
            : {
                mode: "act",
                reason: "准备形式化并检查另一条命题。",
                actions: [
                  action(req, "formalize", req.input.claims[0]),
                  action(req, "inspect_definitions", req.input.claims[1]),
                ],
              };
      },
    );
  });
}

test("restart keeps pending approvals and completed work, without silently repeating external model calls", async () => {
  let release;
  const barrier = new Promise((resolve) => (release = resolve));
  await harness(
    async (a, s, dir) => {
      const id = (await a.start(input)).id;
      await a.pause(id);
      release();
      assert.equal((await settled(a, id)).status, "paused");
      await a.close();
      const before = s.calls.length;
      const b = new AutonomousReview({
        store: a.store,
        pipeline: a.pipeline,
        getConfig: a.getConfig,
        model: a.model,
        extract: a.extract,
        probe: a.probe,
        testFixture: true,
      });
      await b.init();
      assert.equal(s.calls.length, before);
      try {
        await b.resume(id);
        const r = await settled(b, id);
        assert.equal(r.status, "blocked", r.error);
        assert.equal(r.conclusion.reviewComplete, false);
        assert.equal(s.calls.filter((c) => c.role === "A_READ").length, 1);
        assert.equal(s.calls.filter((c) => c.role === "A_ENV").length, 1);
      } finally {
        await b.close();
      }
    },
    async (req) => {
      if (req.role === "A_READ") await barrier;
    },
  );
});

test("all reading and diagnosis requests failing cannot produce a completed zero-claim report; explicit resume reuses import", async () => {
  let fail = true;
  await harness(
    async (a, script) => {
      let r = await settled(a, (await a.start(input)).id);
      assert.equal(r.status, "blocked");
      assert.match(r.error, /正文阅读未完成/);
      assert.equal(r.root, null);
      assert.equal(r.conclusion, null);
      assert.ok(r.failureRoot);
      const failedRoot = r.failureRoot;
      const failedBundle = await a.store.bundle(failedRoot);
      inspectBundle(failedBundle, failedRoot);
      assert.equal((await a.store.get(failedRoot)).kind, "adaptive_failed");
      assert.equal(
        r.tasks.some((t) => t.kind === "conclude"),
        false,
      );
      assert.deepEqual(r.missingTextPages, []);
      assert.deepEqual(r.unreadPages, [0, 1]);
      assert.deepEqual(r.paperMap.readPages, []);
      assert.equal(script.calls.length, 1); // Provider outage is not sent to another model for diagnosis.
      const imported = r.sourceArtifact;
      fail = false;
      await a.resume(r.id);
      r = await settled(a, r.id);
      assert.equal(r.status, "blocked", r.error);
      assert.equal(r.conclusion.reviewComplete, false);
      assert.equal(r.sourceArtifact, imported);
      assert.equal(r.tasks.find((t) => t.kind === "import").attempts.length, 1);
      assert.equal(r.tasks.find((t) => t.kind === "read").attempts.length, 2);
      assert.deepEqual(r.unreadPages, []);
      assert.equal(r.claims.length, 2);
      assert.equal(r.failureRoot, failedRoot);
      const resumedBundle = await a.store.bundle(r.root);
      assert(resumedBundle.artifacts.some((a) => a.id === failedRoot));
    },
    (req) => {
      if (fail && ["A_READ", "A_DIAGNOSE"].includes(req.role))
        throw Object.assign(
          Error("模型接口返回 HTTP 502（upstream_error_event）"),
          {
            modelRecord: {
              http: { status: 502 },
              error: { code: "model_http_error" },
            },
          },
        );
    },
  );
});

test("failed reading chunk is explicit, other pages remain reviewable before automatic routing", async () => {
  await harness(
    async (a) => {
      const r = await settled(a, (await a.start(input)).id);
      assert.equal(r.status, "blocked");
      assert.equal(r.conclusion.reviewComplete, false);
      assert.deepEqual(r.paperMap.readPages, [1]);
      assert.deepEqual(r.unreadPages, [0]);
      assert.equal(r.claims.length, 1);
      assert.equal(r.paperMap.scope, "partial_reading_with_explicit_gaps");
      assert.equal(r.conclusion.headline, "评审未完成");
      assert.ok(
        r.conclusion.limitations.some((v) => v === "尚未完成阅读的页面：1"),
      );
      assert.ok(
        !r.conclusion.limitations.some((v) => v.startsWith("未提取到文本")),
      );
    },
    (req) => {
      if (req.role === "A_READ" && req.input.pages[0].pageIndex === 0)
        throw Error("fixture text quality error");
      if (req.role === "A_DIAGNOSE")
        return { action: "stop", guidance: "Missing formula remains unread." };
    },
    { limits: { chunkCharacters: 80 } },
  );
});
test("independent review concerns cannot disappear from the final coverage", async () => {
  await harness(
    async (a) => {
      const r = await settled(a, (await a.start(input)).id);
      assert.equal(r.conclusion.concerns, 2);
      assert.equal(r.conclusion.unresolvedClaims.length, 2);
    },
    (req) =>
      req.role === "A_REVIEW"
        ? { ...inspected(req.input.claim), status: "concern" }
        : null,
  );
});
test("failed child creation has a final local status instead of a permanent phantom pending gate", async () => {
  await harness(
    async (a) => {
      a.pipeline.reserve = async (fn) => fn();
      a.pipeline.startReserved = async () => {
        throw Error("fixture child could not start");
      };
      const r = await settled(a, (await a.start(input)).id);
      const t = r.tasks.find((t) => t.kind === "formalize");
      assert.equal(r.status, "blocked");
      assert.equal(r.conclusion.reviewComplete, false);
      assert.equal(t.childFinal, true);
      assert.equal(t.childStatus, "not_started");
    },
    (req) => {
      if (req.role === "A_COORDINATOR")
        return req.input.tasks.some((t) => t.kind === "formalize")
          ? finish(req)
          : {
              mode: "act",
              reason: "Attempt selected claim",
              actions: [action(req, "formalize", req.input.claims[0])],
            };
      if (req.role === "A_DIAGNOSE")
        return {
          action: "stop",
          guidance: "Keep the failed creation explicit.",
        };
    },
  );
});
test("planner must provide reference arguments and cannot invoke backend-only recovery actions", () => {
  const r = {
    claims: [{ id: "c" }],
    tasks: [{ id: "p", status: "succeeded", output: "e" }],
  };
  assert.throws(
    () =>
      decision(
        {
          mode: "act",
          reason: "Fetch reference",
          actions: [{ kind: "retrieve_reference", claimId: "c" }],
        },
        r,
      ),
    /reference/,
  );
  assert.throws(
    () =>
      decision(
        {
          mode: "act",
          reason: "Unsafe internal command",
          actions: [{ kind: "retry_translation", claimId: "c" }],
        },
        r,
      ),
    /未注册/,
  );
});
test("metrics measure completed request overlap and do not invent token or cost totals", async () => {
  const model = (id, start, end) => ({
    requestId: id,
    request: {},
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(end).toISOString(),
    usage: null,
  });
  const r = {
    createdAt: new Date(0).toISOString(),
    modelCalls: 2,
    claims: [],
    events: [],
    tasks: [
      {
        status: "succeeded",
        attempts: [
          { model: model("a", 0, 100) },
          { model: model("b", 50, 200) },
        ],
      },
    ],
  };
  const m = await reviewMetrics(r, {});
  assert.equal(m.maxConcurrentRequests, 2);
  assert.equal(m.overlappingRequestMs, 50);
  assert.equal(m.tokenUsage, null);
  assert.equal(m.cost, null);
  r.status = "completed";
  r.events = [{ type: "completed", at: new Date(250).toISOString() }];
  assert.equal((await reviewMetrics(r, {})).wallClockMs, 250);
});

test("metrics use unique shared receipts for SDK calls and exclude provider queue time", async () => {
  const model = (id, dispatched, end, usage = 20) => ({
    requestId: id,
    request: {},
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(end).toISOString(),
    resource: {
      executionStarted: true,
      executionStartedAt: new Date(dispatched).toISOString(),
    },
    usage: usage === null ? null : { total_tokens: usage },
  });
  const a = model("a", 0, 100),
    b = model("b", 100, 200);
  const run = {
    id: "parent",
    createdAt: new Date(0).toISOString(),
    modelCalls: 2,
    claims: [],
    events: [],
    tasks: [{ attempts: [{ model: a }] }],
    modelBudget: {
      entries: [
        { id: "one", receipt: "r1" },
        { id: "two", receipt: "r2" },
      ],
    },
  };
  const store = {
    get: async (id) => ({
      kind: "review_budget_receipt",
      payload: {
        reviewId: "parent",
        reservation: id === "r1" ? "one" : "two",
        model: id === "r1" ? a : b,
      },
    }),
  };
  let metrics = await reviewMetrics(run, store);
  assert.equal(metrics.recordedRequests, 2);
  assert.equal(metrics.tokenUsage, 40);
  assert.equal(metrics.maxConcurrentRequests, 1);
  assert.equal(metrics.overlappingRequestMs, 0);
  b.usage = null;
  metrics = await reviewMetrics(run, store);
  assert.equal(metrics.tokenUsageComplete, false);
  assert.equal(metrics.tokenUsage, null);
  b.usage = { total_tokens: 20 };
  run.modelCalls = 3;
  assert.equal((await reviewMetrics(run, store)).tokenUsageComplete, false);
  await assert.rejects(
    reviewMetrics({ ...run, id: "foreign" }, store),
    /身份不匹配/,
  );
});

test("retry artifacts and diagnostics do not wake the coordinator; terminal evidence does", async () => {
  await harness(async (a) => {
    const r = {
      tasks: [
        {
          id: "one",
          kind: "retrieve_reference",
          status: "recovering",
          output: "a".repeat(64),
        },
      ],
    };
    const before = a.evidenceKey(r);
    r.tasks[0].output = "b".repeat(64);
    r.tasks.push({
      id: "diag",
      kind: "diagnose",
      recoveryFor: "one",
      status: "succeeded",
      output: "c".repeat(64),
    });
    assert.equal(a.evidenceKey(r), before);
    r.tasks[0].status = "unresolved";
    const after = a.evidenceKey(r);
    assert.notEqual(after, before);
    r.tasks.push({
      id: "plan",
      kind: "decide",
      status: "succeeded",
      output: "d".repeat(64),
    });
    assert.equal(a.evidenceKey(r), after);
  });
});
test("an unchanged decision without workers or children terminates instead of planning again", async () => {
  await harness(async (a, s) => {
    const r = {
      id: "fixture",
      orchestrationVersion: 2,
      tasks: [],
      claims: [],
      createdAt: new Date().toISOString(),
    };
    a.runs.set(r.id, r);
    r.lastDecisionEvidence = a.evidenceKey(r);
    assert.deepEqual(await a.dispatch({ runId: r.id }), { route: "conclude" });
    assert.equal(s.calls.length, 0);
  });
});
test("identical failures stop after one repair attempt, while unknown outcomes are not retried", async () => {
  await harness(async (a, s) => {
    const r = {
      id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      orchestrationVersion: 2,
      tasks: [],
      events: [],
      claims: [],
    };
    let calls = 0;
    await assert.rejects(
      a.task(
        r,
        { key: "broken", kind: "inspect_proof", inputs: [] },
        async () => {
          calls++;
          throw Error("unchanged tool error");
        },
      ),
    );
    assert.equal(calls, 2);
    assert.equal(s.calls.filter((c) => c.role === "A_DIAGNOSE").length, 1);
    assert.equal(r.tasks[0].recoveryStop, "repeated_failure_without_progress");
    await assert.rejects(
      a.task(
        r,
        { key: "unknown", kind: "inspect_proof", inputs: [] },
        async () => {
          throw Error("socket transport interrupted");
        },
      ),
    );
    assert.equal(r.tasks.find((t) => t.key === "unknown").attempts.length, 1);
    const e = Error("文献返回 HTTP 202，未获得全文。");
    e.referenceFailure = { url: "https://example.com/reference", status: 202 };
    await assert.rejects(
      a.task(
        r,
        { key: "reference", kind: "retrieve_reference", inputs: [] },
        async () => {
          throw e;
        },
      ),
    );
    assert.equal(r.tasks.find((t) => t.key === "reference").attempts.length, 1);
    assert.equal(
      r.tasks.find((t) => t.key === "reference").recoveryStop,
      "non_retryable_reference_response",
    );
    const saved = await a.store.get(
      r.tasks.find((t) => t.key === "reference").output,
    );
    assert.deepEqual(saved.payload.referenceFailure, e.referenceFailure);
  });
});
test("the same reference cannot be redownloaded by changing its title, fragment or dependencies", () => {
  const r = {
    claims: [{ id: "c" }],
    tasks: [
      {
        id: "first",
        kind: "retrieve_reference",
        claimId: "c",
        status: "unresolved",
        output: "a".repeat(64),
        reference: { url: "https://example.org/book?b=2&a=1#page1" },
      },
      {
        id: "new",
        kind: "inspect_proof",
        status: "succeeded",
        output: "b".repeat(64),
      },
    ],
  };
  assert.equal(
    referenceIdentity({ url: "https://example.org/book?a=1&b=2#new" }),
    referenceIdentity(r.tasks[0].reference),
  );
  const filtered = decision(
    {
      mode: "act",
      reason: "new title",
      actions: [
        {
          kind: "retrieve_reference",
          claimId: "c",
          title: "new title",
          question: "same book",
          reason: "retry",
          strategy: "same",
          basedOn: ["new"],
          reference: { url: "https://example.org/book?a=1&b=2" },
        },
      ],
    },
    r,
  );
  assert.deepEqual(filtered.actions, []);
  assert.match(filtered.skippedActions[0].reason, /同一文献请求/);
});

for (const route of ["proof", "counterexample", "unresolved"]) {
  test(`Agent autonomously selects ${route} with no human confirmation wait`, async () => {
    let accepted = 0;
    await harness(
      async (a) => {
        a.pipeline.reserve = (fn) => fn();
        a.pipeline.startReserved = async (_input, internal) => {
          const child = {
            id: internal.runId,
            parentReviewId: internal.parentReviewId,
            parentTaskId: internal.parentTaskId,
            status: "awaiting_confirmation",
            contract: {
              label: "T0",
              leanTarget: "True",
              targetHash: "a".repeat(64),
            },
            semanticArtifact: "b".repeat(64),
            contractArtifact: "c".repeat(64),
            semanticReview: {
              issues: [],
              targetHash: "a".repeat(64),
              targetCheck: { status: "well_typed", targetHash: "a".repeat(64) },
            },
            tasks: [],
            approval: null,
          };
          // Use real evidence identities rather than dangling references.
          child.contractArtifact = await a.store.put(
            "fixture_contract",
            child.contract,
          );
          child.semanticArtifact = await a.store.put(
            "fixture_semantic",
            child.semanticReview,
          );
          await a.store.saveRun(child);
          return child;
        };
        a.pipeline.approveByAgent = async (id, evidence) => {
          accepted++;
          const d = await a.store.get(evidence),
            child = await a.store.getRun(id);
          assert.equal(d.payload.value.decision, route);
          assert.ok(d.inputs.includes(child.contractArtifact));
          child.status = "completed";
          child.approval = { authority: "fixture_agent" };
          await a.store.saveRun(child);
        };
        const r = await settled(a, (await a.start(input)).id);
        assert.equal(r.status, "blocked", r.error);
        assert.equal(r.conclusion.reviewComplete, false);
        assert.equal(r.semanticPolicy, "agent");
        assert.equal(accepted, route === "unresolved" ? 0 : 1);
        assert.equal(
          r.tasks.filter((t) => t.kind === "assess_target").length,
          1,
        );
      },
      async (req) => {
        if (req.role === "A_COORDINATOR")
          return req.input.tasks.some((t) => t.kind === "formalize")
            ? {
                ...finish(req),
                coverage: req.input.claims.map((c) => ({
                  claimId: c.id,
                  formalization: "not_attempted",
                  reason: "Fixture only.",
                })),
              }
            : {
                mode: "act",
                reason: "Formalization fixture.",
                actions: [action(req, "formalize", req.input.claims[0])],
              };
        if (req.role === "A_SEMANTIC_DECISION")
          return {
            targetHash: req.input.contract.targetHash,
            semanticArtifact: req.input.semanticArtifact,
            decision: route,
            summary:
              "Independent fixture route decision with immutable evidence.",
            resolutions: [],
          };
        if (req.role === "A_CHILD_DIAGNOSE")
          return {
            action: "stop",
            guidance: "The fixture remains unresolved without source fidelity.",
          };
      },
      { autonomousSemantics: true },
    );
  });
}

test("redundant proposals are filtered without dropping independent new work or invoking diagnosis", () => {
  const r = {
    claims: [{ id: "a" }, { id: "b" }],
    tasks: [
      {
        id: "old",
        kind: "retrieve_reference",
        claimId: "a",
        status: "unresolved",
        output: "1".repeat(64),
        reference: { url: "https://example.org/book" },
      },
      {
        id: "basis",
        kind: "read",
        status: "succeeded",
        output: "2".repeat(64),
      },
    ],
  };
  const base = {
    title: "Inspect",
    question: "Inspect this source",
    reason: "New evidence",
    strategy: "Concrete check",
    basedOn: ["basis"],
  };
  const result = decision(
    {
      mode: "act",
      reason: "Independent work",
      actions: [
        {
          ...base,
          kind: "retrieve_reference",
          claimId: "b",
          reference: { url: "https://example.org/book#p2" },
        },
        { ...base, kind: "inspect_proof", claimId: "b" },
      ],
    },
    r,
  );
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].kind, "inspect_proof");
  assert.equal(result.skippedActions.length, 1);
  const batch = decision(
    {
      mode: "act",
      reason: "Two requests",
      actions: [
        {
          ...base,
          kind: "retrieve_reference",
          claimId: "a",
          reference: { url: "https://example.org/new" },
        },
        {
          ...base,
          kind: "retrieve_reference",
          claimId: "b",
          reference: { url: "https://example.org/new" },
        },
      ],
    },
    r,
  );
  assert.equal(batch.actions.length, 1);
  assert.equal(batch.skippedActions.length, 1);
});

test("continuations from a known older version rejoin their task, never silently orphan or replace active work", async () => {
  await harness(async (a) => {
    const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      old = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      current = "cccccccc-cccc-4ccc-cccc-cccccccccccc",
      nextId = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
    const t = {
      id: "logical-task",
      childRunId: current,
      childFinal: true,
      status: "unresolved",
      previousChildRuns: [old],
    };
    const r = {
      id,
      status: "paused",
      paperSha256: source.paperSha256,
      tasks: [t],
      events: [],
    };
    a.runs.set(id, r);
    await a.store.saveRun({ id: current, status: "blocked" });
    const next = {
      id: nextId,
      parentReviewId: id,
      parentTaskId: t.id,
      continuedFrom: old,
      paperSha256: source.paperSha256,
      status: "awaiting_confirmation",
    };
    await assert.rejects(
      a.adoptChild(old, { ...next, paperSha256: "0".repeat(64) }),
      /版本链/,
    );
    await a.adoptChild(old, next);
    assert.equal(t.childRunId, nextId);
    assert.equal(t.childFinal, false);
    assert.ok(t.previousChildRuns.includes(current));
    const events = r.events.length;
    await a.adoptChild(old, next);
    assert.equal(r.events.length, events);
    await a.store.saveRun({ ...next, status: "running" });
    await assert.rejects(
      a.adoptChild(old, {
        ...next,
        id: "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee",
      }),
      /更新的子核验/,
    );
  });
});

test("reserved child identities block cross-kind duplicate work before child status arrives", () => {
  const r = {
    sourceArtifact: "source",
    claims: [{ id: "c" }, { id: "other" }],
    tasks: [
      { id: "p", status: "succeeded", output: "e" },
      {
        id: "reserved",
        kind: "retry_translation",
        claimId: "c",
        status: "running",
        childRunId: "reserved-child",
      },
    ],
  };
  assert.equal(activeFormalization(r, "c").id, "reserved");
  const a = {
    kind: "formalize",
    claimId: "c",
    title: "compile",
    question: "fixed claim",
    reason: "test",
    strategy: "test",
    basedOn: ["p"],
  };
  const plan = decision({ mode: "act", reason: "test", actions: [a] }, r);
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.skippedActions.length, 1);
  const coordinator = Object.create(AutonomousReview.prototype);
  const before = r.tasks.length;
  assert.equal(coordinator.schedule(r, a, null), null);
  assert.equal(r.tasks.length, before);
  assert(coordinator.schedule(r, { ...a, claimId: "other" }, null));
  r.tasks[1].childFinal = true;
  r.tasks[1].status = "unresolved";
  assert.equal(activeFormalization(r, "c"), undefined);
  assert(
    coordinator.schedule(r, a, null),
    "ended failures must remain recoverable",
  );
});

test("a late plan cannot reserve competing formalization after automatic recovery queues", () => {
  const coordinator = Object.create(AutonomousReview.prototype);
  const r = { sourceArtifact: "source", claims: [{ id: "c" }], tasks: [] };
  const a = {
    kind: "retry_translation",
    claimId: "c",
    basedOn: [],
    previousChildId: "finished-child",
  };
  const first = coordinator.schedule(r, a, null);
  assert(first);
  assert.equal(
    coordinator.schedule(r, { ...a, kind: "recover_domain" }, null),
    null,
  );
  assert.equal(r.tasks.length, 1);
});

test("coordinator transport failure archives an incomplete report; explicit resume retains the old root and completes without replaying reading", async () => {
  let unavailable = true;
  await harness(
    async (a, s) => {
      let r = await settled(a, (await a.start(input)).id);
      assert.equal(r.status, "blocked");
      assert.equal(r.conclusion.executionOutcome, "infrastructure_interrupted");
      assert(r.root);
      const oldRoot = r.root;
      inspectBundle(await a.store.bundle(oldRoot), oldRoot);
      assert(!s.calls.some((c) => c.role === "A_DIAGNOSE"));
      assert(!s.calls.some((c) => c.role === "A_REVIEW"));
      unavailable = false;
      await a.resume(r.id);
      r = await settled(a, r.id);
      assert.equal(r.status, "blocked", r.error);
      assert.equal(r.conclusion.reviewComplete, false);
      assert.notEqual(r.root, oldRoot);
      assert.equal(s.calls.filter((c) => c.role === "A_READ").length, 1);
      inspectBundle(await a.store.bundle(oldRoot), oldRoot);
      inspectBundle(await a.store.bundle(r.root), r.root);
    },
    async (req) => {
      if (req.role === "A_COORDINATOR" && unavailable)
        throw Object.assign(Error("Transport failed"), {
          modelRecord: { error: { code: "model_transport_error" } },
        });
    },
  );
});

test("independent review outage withdraws the initial no-issue status and does not call more reviewers", async () => {
  await harness(
    async (a, s) => {
      const r = await settled(a, (await a.start(input)).id);
      assert.equal(r.status, "blocked");
      assert.equal(s.calls.filter((c) => c.role === "A_REVIEW").length, 1);
      assert(r.claims.every((c) => c.status === "unresolved"));
      assert(
        r.claims.every((c) => c.independentReview.status === "unresolved"),
      );
      assert.equal(r.conclusion.unresolvedClaims.length, 2);
      inspectBundle(await a.store.bundle(r.root), r.root);
    },
    async (req) => {
      if (req.role === "A_REVIEW")
        throw Object.assign(Error("Transport failed"), {
          modelRecord: { error: { code: "model_transport_error" } },
        });
      if (["A_PROOF", "A_DEFINITION"].includes(req.role))
        return {
          ...inspected(req.input.claim),
          status: "no_issue_found",
          steps: ["Explicit controlled evidence step."],
        };
    },
  );
});

test("explicit single-claim scope probes and schedules only the Agent-selected claim", async () => {
  let probed = 0;
  await harness(
    async (a, s) => {
      const r = await settled(
        a,
        (
          await a.start({
            ...input,
            reviewIntent: "请阅读全文，自主选择一个命题核查。",
          })
        ).id,
      );
      assert.equal(r.status, "blocked", r.error);
      assert.equal(r.conclusion.reviewComplete, false);
      assert.equal(r.claims.length, 2);
      assert.equal(probed, 1);
      assert.equal(r.reviewScope.selectedClaimIds.length, 1);
      assert.equal(r.reviewScope.unselectedClaimIds.length, 1);
      assert.ok(
        r.tasks
          .filter(
            (t) =>
              t.kind === "inspect_proof" || t.kind === "inspect_definitions",
          )
          .every((t) => r.reviewScope.selectedClaimIds.includes(t.claimId)),
      );
      const plan = s.calls.find((c) => c.role === "A_COORDINATOR");
      assert.ok(plan.input.budget);
      assert.equal(plan.input.reviewScope.scopeHash, r.reviewScope.scopeHash);
    },
    (req) =>
      req.role === "A_ENV"
        ? {
            summary: "Select one claim from the source under the user scope.",
            choices: [
              {
                claimId: req.input.paperMap.claims[0].id,
                profile: "std-v1",
                reason: "Explicit scoped fixture.",
                queries: [],
                names: [],
              },
            ],
          }
        : null,
    {
      probe: async () => {
        probed++;
        return {
          ready: true,
          probe: {},
          scope: "environment_only_not_paper_verification",
        };
      },
    },
  );
});
