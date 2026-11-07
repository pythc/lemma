import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { cleanupTestEvidence } from "./retain-test-evidence.mjs";
import os from "node:os";
import path from "node:path";
import { AutonomousReview } from "../server/autonomous.mjs";
import { EvidenceStore, sha256, inspectBundle } from "../server/evidence.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { createContract } from "../server/contracts.mjs";
import { preparePaperContinuation } from "../server/paper-continuation.mjs";

test(
  "a raw cross-page claim is expanded and independently reviewed; unchanged failures do not spawn a recovery chain",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-scope-loop-")),
      store = new EvidenceStore(dir);
    await store.init();
    const bytes = Buffer.from("explicit source fixture not a real PDF"),
      paperSha256 = sha256(bytes);
    const pages = [
      { index: 0, text: "Proposition R. If x belongs to S," },
      { index: 1, text: "then f(x) belongs to T." },
    ];
    let children = 0,
      scopeCalls = 0;
    const model = async (_config, req) => {
      let parsed;
      if (req.role === "A_READ")
        parsed = {
          summary: "Cross-page statement fixture.",
          claims: [
            {
              label: "R",
              pageIndex: 0,
              quote: "Proposition R.",
              statement: "A scoped implication, not a proof fixture.",
            },
          ],
        };
      else if (req.role === "A_ENV")
        parsed = {
          summary: "Execution fixture.",
          choices: req.input.paperMap.claims.map((c) => ({
            claimId: c.id,
            profile: "std-v1",
            reason: "fixture",
            queries: [],
            names: [],
          })),
        };
      else if (req.role === "A_SOURCE_SCOPE") {
        scopeCalls++;
        parsed = {
          spans: pages.map((p) => ({ pageIndex: p.index, quote: p.text })),
          premises: [{ pageIndex: 0, quote: "If x belongs to S," }],
          conclusion: [{ pageIndex: 1, quote: pages[1].text }],
          explanation: "The implication continues onto the next page.",
        };
      } else if (req.role === "A_SCOPE_REVIEW")
        parsed = {
          scopeHash: req.input.scope.scopeHash,
          decision: "complete",
          explanation: "Both the premise and conclusion are selected.",
          anchors: [req.input.scope.spans[1]],
        };
      else if (req.role === "A_CHILD_DIAGNOSE")
        parsed = {
          action: "retry_translation",
          guidance: "Fixture tests repeated-state termination.",
        };
      else if (req.role === "A_COORDINATOR")
        parsed = req.input.tasks.some((t) => t.kind === "formalize")
          ? {
              mode: "finish",
              reason: "No mathematical certificate; keep unresolved.",
              coverage: req.input.claims.map((c) => ({
                claimId: c.id,
                formalization: "attempted",
                reason: "fixture remained unresolved",
              })),
            }
          : {
              mode: "act",
              reason: "Attempt source-bound formalization.",
              actions: [
                {
                  kind: "formalize",
                  claimId: req.input.claims[0].id,
                  title: "Formalize source fixture",
                  question: "Keep the full implication.",
                  reason: "Test the execution path.",
                  strategy: "raw source only",
                  basedOn: [
                    req.input.tasks.filter((t) => t.hasEvidence).at(-1).id,
                  ],
                },
              ],
            };
      else if (req.role === "A_DIAGNOSE")
        parsed = {
          category: "contract",
          action: "stop",
          guidance: "Preserve the fixture failure.",
        };
      else
        parsed = {
          status: "unresolved",
          summary: "Controlled fixture, no mathematical conclusion.",
          anchors: [req.input.claim.anchor],
          assumptions: [],
          steps: [],
          dependencies: [],
          nextQuestion: "",
        };
      return { parsed, record: { testFixture: true, role: req.role } };
    };
    const pipeline = {
      active: new Map(),
      reserve: (fn) => fn(),
      async startReserved(input, internal) {
        children++;
        assert.equal(input.focusQuote, input.propositionScope.locator.quote);
        assert.equal(input.focusQuote, "Proposition R.");
        assert.equal(input.propositionScope.spans[0].quote, pages[0].text);
        assert.equal(input.propositionScope.spans[1].quote, pages[1].text);
        const child = {
          id: internal.runId,
          parentReviewId: internal.parentReviewId,
          parentTaskId: internal.parentTaskId,
          createdAt: new Date().toISOString(),
          paperSha256,
          libraryProfile: "std-v1",
          status: "blocked",
          error: "Known unresolved fixture dependency",
          tasks: [{ role: "R03", status: "blocked" }],
          sourceArtifact: input.propositionScope.scopeHash,
        };
        await store.saveRun(child);
        return child;
      },
    };
    const a = new AutonomousReview({
      store,
      pipeline,
      getConfig: async () => ({ model: "fixture" }),
      model,
      extract: async () => ({ paperSha256, pageCount: 2, pages }),
      probe: async () => ({ ready: true, scope: "fixture" }),
      testFixture: true,
      sourceScopes: true,
    });
    await a.init();
    try {
      const id = (
        await a.start({ paperSha256, pdfBase64: bytes.toString("base64") })
      ).id;
      const deadline = Date.now() + 15000;
      let r;
      while (Date.now() < deadline) {
        r = await store.getRun(id);
        if (!a.active.has(id)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Completion can occur after getRun resolves but before active.has; read
      // the settled receipt instead of asserting against that older snapshot.
      r = await store.getRun(id);
      assert.equal(r.status, "blocked", r.error);
      assert.equal(r.conclusion.reviewComplete, false);
      assert.equal(scopeCalls, 1);
      assert.equal(children, 2);
      assert.ok(r.claims[0].formalizationStalled);
      assert.equal(
        r.tasks.filter((t) => t.kind === "diagnose_child").length,
        1,
      );
      assert.equal(r.conclusion.statistics.actualLeanClaimChecks, 0);
      inspectBundle(await store.bundle(r.root), r.root);
      // Exercise real LangGraph dispatch twice across continuation generations.
      // A duplicate key previously selected a historical task and spun until
      // the graph recursion limit, despite the fresh task staying queued.
      for (let generation = 1; generation <= 2; generation++) {
        await a.cancel(r.id);
        const prepared = await preparePaperContinuation(store, r.id, {
          implementationBefore: sha256(`implementation-${generation - 1}`),
          implementationAfter: sha256(`implementation-${generation}`),
        });
        const fresh = prepared.tasks.find(
          (t) => t.kind === "formalize" && t.status === "queued",
        );
        const countBefore = children;
        await a.resume(prepared.id);
        const until = Date.now() + 10000;
        while (a.active.has(prepared.id) && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(
          a.active.has(prepared.id),
          false,
          "Continuation graph must settle, not spin",
        );
        r = await store.getRun(prepared.id);
        assert.equal(r.status, "blocked");
        assert(!/recursion/i.test(r.error || ""));
        assert.equal(r.conclusion.reviewComplete, false);
        const dispatched = r.tasks.find((t) => t.id === fresh.id);
        assert(dispatched.childRunId, "Fresh continuation task owns its child");
        assert.notEqual(dispatched.status, "queued");
        assert(children > countBefore && children <= countBefore + 2);
        inspectBundle(await store.bundle(r.root), r.root);
      }
    } finally {
      await a.close();
      await cleanupTestEvidence(dir);
    }
  },
);

test(
  "cancelling a source-planning worker before any proof exists still archives a valid cancelled report",
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-cancel-report-")),
      store = new EvidenceStore(dir);
    await store.init();
    const text = "A fixed generic source statement.",
      paperSha256 = sha256(text),
      sourceArtifact = await store.put("task:R02", {
        paperSha256,
        pageIndex: 0,
        text,
        pages: [{ index: 0, text }],
      });
    const contract = createContract(
      { paperSha256, pageIndex: 0, text, artifact: sourceArtifact },
      {
        label: "fixture",
        quote: text,
        statement: "Explicit cancellation fixture",
        assumptions: [],
        leanTarget: "∀ n : Nat, n = n",
      },
    );
    const contractArtifact = await store.put("task:R05", contract, [
        sourceArtifact,
      ]),
      approval = { targetHash: contract.targetHash, confirmed: true },
      approvalArtifact = await store.put("semantic_approval", approval, [
        contractArtifact,
      ]);
    const { randomUUID } = await import("node:crypto");
    let entered;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const controller = new AbortController();
    const pipeline = new ReviewPipeline({
      store,
      model: async () => ({
        parsed: {
          status: "unchecked",
          quote: "",
          explanation: "Fixture audit has no mathematical verdict.",
        },
        record: { testFixture: true },
      }),
      getConfig: async () => ({ model: "fixture" }),
      originalProofEngine: {
        review: async ({ signal }) => {
          entered();
          await new Promise((_resolve, reject) => {
            if (signal.aborted) reject(Error("aborted"));
            else
              signal.addEventListener("abort", () => reject(Error("aborted")), {
                once: true,
              });
          });
        },
      },
    });
    const run = {
      id: randomUUID(),
      mode: "model",
      status: "running",
      paperSha256,
      sourceArtifact,
      contract,
      contractArtifact,
      approval,
      approvalArtifact,
      tasks: [],
      context: { pages: [{ pageIndex: 0, text }], supplements: [] },
    };
    pipeline.active.set(run.id, controller);
    try {
      const task = pipeline.execute(run, {}, { model: "fixture" }, controller);
      await ready;
      await pipeline.cancel(run.id);
      await task;
      assert.equal(run.status, "cancelled", run.error);
      assert.ok(run.root);
      const bundle = await store.bundle(run.root);
      inspectBundle(bundle, run.root);
      assert.equal(
        bundle.artifacts.find((a) => a.id === run.root).payload.check,
        null,
      );
    } finally {
      await cleanupTestEvidence(dir);
    }
  },
);
