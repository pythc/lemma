import { cleanupTestEvidence } from "./retain-test-evidence.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { AutonomousReview } from "../server/autonomous.mjs";
import { EvidenceStore, sha256, inspectBundle } from "../server/evidence.mjs";

for (const mode of ["active", "paused"])
  test(
    `cancelled ${mode} parent archives settled owned child roots and excludes foreign roots`,
    { timeout: 10000 },
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cancel-links-")),
        store = new EvidenceStore(dir);
      await store.init();
      const id = randomUUID(),
        paperSha256 = sha256("lifecycle fixture; no mathematical verdict"),
        source = await store.put("paper_source", { paperSha256, pages: [] });
      const tasks = Array.from({ length: 3 }, (_, i) => ({
        id: randomUUID(),
        kind: "formalize",
        status: i === 0 ? "running" : "succeeded",
        childRunId: randomUUID(),
        childStatus: i === 0 ? "running" : "blocked",
        childFinal: i === 2,
        inputs: [source],
        attempts: i === 0 ? [{ status: "running" }] : [],
      }));
      const roots = [];
      for (const t of tasks)
        roots.push(
          await store.put(
            "review_blocked",
            {
              runId: t.childRunId,
              scope: "controlled_lifecycle_fixture_not_a_proof",
            },
            [source],
          ),
        );
      const live = {
        id: tasks[0].childRunId,
        parentReviewId: id,
        parentTaskId: tasks[0].id,
        paperSha256,
        status: "running",
        tasks: [],
      };
      await store.saveRun(live);
      await store.saveRun({
        id: tasks[1].childRunId,
        parentReviewId: id,
        parentTaskId: tasks[1].id,
        paperSha256,
        status: "blocked",
        root: roots[1],
        tasks: [],
      });
      await store.saveRun({
        id: tasks[2].childRunId,
        parentReviewId: randomUUID(),
        parentTaskId: tasks[2].id,
        paperSha256,
        status: "blocked",
        root: roots[2],
        tasks: [],
      });
      let finish;
      const done = new Promise((resolve) => {
        finish = resolve;
      });
      const pipeline = {
        active: new Map([[live.id, new AbortController()]]),
        completions: new Map([[live.id, done]]),
        async cancel(childId) {
          assert.equal(childId, live.id);
          this.active.delete(childId);
          setTimeout(() => {
            void store
              .saveRun({ ...live, status: "cancelled", root: roots[0] })
              .then(finish);
          }, 15);
        },
      };
      const a = new AutonomousReview({
        store,
        pipeline,
        getConfig: async () => ({ model: "fixture" }),
        model: async () => {
          throw Error("no model call allowed");
        },
        testFixture: true,
      });
      await a.init();
      try {
        const run = {
          id,
          engine: "langgraph-v1",
          orchestrationVersion: 2,
          paperSha256,
          status: mode === "active" ? "running" : "paused",
          createdAt: new Date().toISOString(),
          events: [],
          claims: [],
          tasks,
          uploadArtifact: source,
          sourceArtifact: source,
        };
        a.runs.set(id, run);
        await store.saveRun(run);
        if (mode === "active") {
          let enter;
          const ready = new Promise((resolve) => {
            enter = resolve;
          });
          a.autonomousGraph = {
            invoke: async () => {
              const signal = a.active.get(id).signal;
              enter();
              return new Promise((_resolve, reject) =>
                signal.addEventListener(
                  "abort",
                  () => reject(Error("controlled cancellation")),
                  { once: true },
                ),
              );
            },
          };
          a.launch(run, { runId: id });
          await ready;
        }
        await a.cancel(id);
        await Promise.allSettled([...(a.jobs || [])]);
        await done;
        const stopped = await store.getRun(id);
        assert.equal(stopped.status, "cancelled");
        assert.ok(
          stopped.root,
          "cancellation must archive a fresh evidence root",
        );
        assert.ok(
          stopped.tasks.every(
            (t) => !["queued", "running", "recovering"].includes(t.status),
          ),
        );
        const bundle = await store.bundle(stopped.root);
        inspectBundle(bundle, stopped.root);
        const ids = new Set(bundle.artifacts.map((a) => a.id));
        assert.ok(ids.has(roots[0]), "late child root missing");
        assert.ok(ids.has(roots[1]), "finished child root missing");
        assert.ok(
          !ids.has(roots[2]),
          "foreign review evidence must not be adopted",
        );
      } finally {
        await a.close();
        await cleanupTestEvidence(dir);
      }
    },
  );

test(
  "SDK cancellation drains late transport receipts before sealing the harness root",
  { timeout: 10000 },
  async () => {
    const { DeepProofHarness } = await import("../server/deep-harness.mjs");
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-late-receipt-"));
    const store = new EvidenceStore(dir);
    await store.init();
    const controller = new AbortController();
    let entered;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const harness = new DeepProofHarness({
      store,
      model: async (_config, request) => {
        calls++;
        entered();
        return new Promise((_resolve, reject) => {
          const late = () =>
            setTimeout(() => {
              const error = Object.assign(
                Error("Controlled transport returned after SDK cancellation"),
                {
                  modelRecord: {
                    requestId: "controlled-late-cancel",
                    content: "",
                    model: "scripted-test-only",
                    error: { code: "model_cancelled" },
                    http: { status: null },
                  },
                },
              );
              reject(error);
            }, 30);
          if (request.signal.aborted) late();
          else request.signal.addEventListener("abort", late, { once: true });
        });
      },
    });
    try {
      const running = harness.run({
        config: { model: "scripted-test-only" },
        goal: "Cancellation receipt lifecycle fixture; no mathematical task.",
        toolProfile: "review",
        signal: controller.signal,
      });
      const caught = running.catch((error) => error);
      await ready;
      controller.abort();
      const error = await caught;
      await new Promise((resolve) => setTimeout(resolve, 80));
      const bundle = await store.bundle(error.harnessRoot);
      inspectBundle(bundle, error.harnessRoot);
      assert.equal(calls, 1, "unknown outcomes must not be replayed");
      assert.ok(
        bundle.artifacts.some(
          (a) =>
            a.kind === "harness:model" &&
            a.payload.requestId === "controlled-late-cancel",
        ),
        "late transport receipt omitted from sealed root",
      );
      assert.equal(
        bundle.artifacts.find((a) => a.id === error.harnessRoot).payload
          .unknownExternalOutcome,
        true,
      );
    } finally {
      await harness.close();
      await cleanupTestEvidence(dir);
    }
  },
);

test(
  "SDK cancellation waits for a late tool failure receipt before sealing",
  { timeout: 10000 },
  async () => {
    const { DeepProofHarness } = await import("../server/deep-harness.mjs");
    const { createContract } = await import("../server/contracts.mjs");
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-late-tool-")),
      store = new EvidenceStore(dir);
    await store.init();
    const text = "For every natural n, n = n.",
      paperSha256 = sha256(text),
      sourceArtifact = await store.put("fixture_source", { paperSha256, text });
    const contract = createContract(
      { paperSha256, pageIndex: 0, text, artifact: sourceArtifact },
      {
        label: "lifecycle fixture",
        quote: text,
        statement: "Explicit lifecycle fixture",
        assumptions: [],
        leanTarget: "∀ n : Nat, n = n",
      },
    );
    const ctrl = new AbortController();
    let enter;
    const ready = new Promise((resolve) => {
      enter = resolve;
    });
    let checks = 0;
    const h = new DeepProofHarness({
      store,
      model: async () => ({
        message: {
          content: null,
          tool_calls: [
            {
              id: "controlled-check",
              function: {
                name: "check_lean",
                arguments: JSON.stringify({ proof: "by intro n; rfl" }),
              },
            },
          ],
        },
        record: { scripted: true },
      }),
      checker: async (_contract, _proof, { signal }) => {
        checks++;
        enter();
        return new Promise((_resolve, reject) => {
          const late = () =>
            setTimeout(
              () => reject(Error("Controlled delayed native cancellation")),
              30,
            );
          if (signal.aborted) late();
          else signal.addEventListener("abort", late, { once: true });
        });
      },
    });
    try {
      const caught = h
        .run({
          config: { model: "scripted-test-only" },
          goal: "Explicit tool-cancellation fixture only.",
          contract,
          inputs: [sourceArtifact],
          signal: ctrl.signal,
        })
        .catch((error) => error);
      await ready;
      ctrl.abort();
      const error = await caught;
      await new Promise((resolve) => setTimeout(resolve, 80));
      const bundle = await store.bundle(error.harnessRoot);
      inspectBundle(bundle, error.harnessRoot);
      assert.equal(checks, 1);
      assert.ok(
        bundle.artifacts.some(
          (a) =>
            a.kind === "harness:tool_failure" &&
            a.payload.name === "check_lean",
        ),
        "late tool receipt omitted from sealed root",
      );
    } finally {
      await h.close();
      await cleanupTestEvidence(dir);
    }
  },
);
