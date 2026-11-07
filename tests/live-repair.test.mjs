import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvidenceStore, digest, sha256 } from "../server/evidence.mjs";
import {
  preparePaperContinuation,
  unknownContinuationAction,
} from "../server/paper-continuation.mjs";
import { reviewMetrics } from "../server/review-metrics.mjs";
import { budgetSnapshot } from "../server/review-budget.mjs";
import { AutonomousReview } from "../server/autonomous.mjs";

test("complete scope keeps its actual locator when earlier pages define symbols", async () => {
  const calls = [];
  const store = {
    get: async () => ({
      payload: { paperSha256: sha256("paper"), pdfBase64: "fixture" },
    }),
  };
  const pipeline = {
    reserve: (fn) => fn(),
    startReserved: async (input, internal) => {
      calls.push(input);
      return { id: internal.runId, status: "preparing" };
    },
  };
  const review = new AutonomousReview({
    store,
    pipeline,
    getConfig: async () => ({}),
    sourceScopes: false,
  });
  review.save = async () => {};
  const scope = {
    locator: {
      pageIndex: 6,
      quote: "Proposition about an earlier definition.",
    },
    spans: [
      { pageIndex: 0, quote: "A definition." },
      { pageIndex: 6, quote: "Proposition about an earlier definition." },
    ],
  };
  const claim = {
    id: "claim",
    libraryProfile: "std-v1",
    formalScope: scope,
    anchor: scope.locator,
  };
  const r = {
    id: "paper",
    uploadArtifact: "upload",
    tasks: [],
    claims: [claim],
  };
  await review.startChild(
    r,
    { id: "task", kind: "formalize" },
    claim,
    new AbortController().signal,
  );
  assert.equal(calls[0].pageIndex, 6);
  assert.equal(calls[0].focusQuote, scope.locator.quote);
  assert.deepEqual(calls[0].propositionScope, scope);
});

test("settled continuation retains budget, old evidence, unknown outcomes and source identity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paper-continuation-"));
  const store = new EvidenceStore(dir);
  await store.init();
  try {
    const prior = {
      id: "11111111-1111-4111-8111-111111111111",
      engine: "langgraph-v1",
      orchestrationVersion: 2,
      status: "cancelled",
      paperSha256: sha256("paper"),
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      limits: { maxModelCalls: 4096, maxRunMs: 172800000 },
      modelCalls: 524,
      modelBudget: {
        schemaVersion: "lemma.review-budget.v1",
        legacyCalls: 523,
        entries: [
          {
            state: "unknown",
            taskId: "experiment",
            ownerRunId: "owner",
            requestId: "unknown",
          },
        ],
      },
      claims: [
        {
          id: "c",
          label: "Test claim",
          anchor: { pageIndex: 0, quote: "source" },
          formalResult: { status: "blocked", contract: null },
          formalizationStalled: { reason: "old" },
        },
      ],
      tasks: [
        {
          id: "experiment",
          kind: "counterexample",
          claimId: "c",
          status: "interrupted",
          output: null,
        },
        {
          id: "env",
          kind: "environment_probe",
          key: "environment_probe:c",
          status: "succeeded",
          output: null,
        },
      ],
      events: [],
      sourceArtifact: sha256("source"),
      proofAutonomy: { sessionId: "session" },
    };
    const reservation = prior.modelBudget.entries[0];
    reservation.id = "reservation";
    reservation.receipt = await store.put(
      "review_budget_receipt",
      { reviewId: prior.id, reservation: reservation.id, model: null },
      [],
    );
    prior.root = await store.put(
      "adaptive_cancelled",
      { runId: prior.id, paperSha256: prior.paperSha256 },
      [reservation.receipt],
    );
    await store.saveRun(prior);
    const before = digest(await store.getRun(prior.id));
    const next = await preparePaperContinuation(store, prior.id, {
      implementationBefore: sha256("old"),
      implementationAfter: sha256("new"),
    });
    assert.equal(digest(await store.getRun(prior.id)), before);
    assert.notEqual(next.id, prior.id);
    assert.equal(next.status, "paused");
    assert.equal(next.root, null);
    assert.equal(next.budgetStartedAt, prior.createdAt);
    assert.equal(budgetSnapshot(next).used, 524);
    assert.equal(budgetSnapshot(next).remainingCalls, 3572);
    assert(budgetSnapshot(next).remainingMs < 172800000 - 3500000);
    assert.equal(next.proofAutonomy.sessionId, "session");
    assert.equal(next.modelBudget.entries[0].state, "unknown");
    assert.equal(
      next.tasks.find((t) => t.id === "experiment").status,
      "cancelled",
    );
    assert.equal(
      next.tasks.find((t) => t.id === "experiment").inheritedFrom.status,
      "interrupted",
    );
    assert(
      unknownContinuationAction(next, { kind: "counterexample", claimId: "c" }),
    );
    assert(
      !unknownContinuationAction(next, { kind: "formalize", claimId: "c" }),
    );
    assert.equal((await reviewMetrics(next, store)).modelCalls, 524);
    const tampered = structuredClone(next);
    tampered.modelBudget.entries[0].state = "received";
    await assert.rejects(reviewMetrics(tampered, store), /身份/);
    assert.equal(next.tasks.filter((t) => t.status === "queued").length, 1);
    assert.equal(
      (await store.get(next.continuation.originArtifact)).inputs[0],
      prior.root,
    );
    // A second continuation must dispatch its fresh task, even when a previous
    // continuation of the same claim remains in the inherited task history.
    const firstFormal = next.tasks.find((t) => t.kind === "formalize");
    firstFormal.status = "cancelled";
    next.status = "blocked";
    next.root = null;
    next.failureRoot = await store.put(
      "adaptive_failed",
      {
        runId: next.id,
        paperSha256: next.paperSha256,
      },
      [reservation.receipt, next.continuation.originArtifact],
    );
    await store.saveRun(next);
    const again = await preparePaperContinuation(store, next.id, {
      implementationBefore: sha256("new"),
      implementationAfter: sha256("third"),
    });
    const fresh = again.tasks.find(
      (t) => t.kind === "formalize" && t.status === "queued",
    );
    assert.notEqual(fresh.key, firstFormal.key);
    assert.equal(again.tasks.filter((t) => t.key === fresh.key).length, 1);
    assert.equal((await reviewMetrics(again, store)).modelCalls, 524);
    const dispatcher = new AutonomousReview({
      store,
      pipeline: {},
      getConfig: async () => ({}),
    });
    dispatcher.save = async () => {};
    let dispatchedId;
    await dispatcher.task(
      again,
      { key: fresh.key, kind: "formalize" },
      async (t) => {
        dispatchedId = t.id;
        return { value: { summary: "Controlled fresh task dispatch" } };
      },
    );
    assert.equal(dispatchedId, fresh.id);
    assert.equal(fresh.status, "succeeded");
    assert.equal(
      again.tasks.find((t) => t.id === firstFormal.id).status,
      "cancelled",
    );
    assert.equal(again.continuation.previousRoot, next.failureRoot);
    const running = { ...prior, status: "running" };
    await store.saveRun(running);
    await assert.rejects(
      preparePaperContinuation(store, prior.id, {
        implementationBefore: sha256("old"),
        implementationAfter: sha256("new"),
      }),
      /settled/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
