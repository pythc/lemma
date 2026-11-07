import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { EvidenceStore, sha256, inspectBundle } from "../server/evidence.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { createApp } from "../server/index.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { callModel } from "../server/model.mjs";
import { createContract } from "../server/contracts.mjs";

test("pipeline rechecks an exact source-derived theorem certificate without requesting another proof", async () => {
  let checks = 0;
  await harness(
    async (pipeline) => {
      const contract = createContract(
        {
          text: "zero",
          paperSha256: sha256("zero"),
          pageIndex: 0,
          artifact: sha256("source"),
        },
        {
          label: "fixture",
          quote: "zero",
          statement: "fixture",
          assumptions: [],
          leanTarget: "∀ n : Nat, n + 0 = n",
        },
      );
      const check = {
        status: "verified",
        targetHash: contract.targetHash,
        mode: "proof",
        exitCode: 0,
        axioms: [],
      };
      const cert = {
        contract,
        check,
        proof: "by intro n; rfl",
        status: "verified",
      };
      cert.artifact = await pipeline.store.put("original:R06_THEOREM", cert);
      const run = {
        id: randomUUID(),
        mode: "model",
        status: "running",
        contract,
        tasks: [],
        contractArtifact: await pipeline.store.put("task:R05", contract),
        approvalArtifact: await pipeline.store.put("semantic_approval", {
          targetHash: contract.targetHash,
        }),
        originalProofRoute: { root: cert.artifact, independentTheorem: cert },
      };
      await pipeline.proveWithRepair(run, {}, {}, new AbortController(), {});
      assert.equal(checks, 1);
      assert.equal(run.check.status, "verified");
      assert.equal(run.repair.modelCalls, 0);
      assert.equal(run.repair.stopReason, "verified_received_source_theorem");
      assert.deepEqual(
        run.tasks.map((t) => t.role),
        ["R09", "R10"],
      );
      assert.equal(run.attempts.length, 1);
    },
    {
      model: async () => {
        throw Error("unexpected proof generation");
      },
      checker: async (contract) => {
        checks++;
        return {
          status: "verified",
          targetHash: contract.targetHash,
          mode: "proof",
          exitCode: 0,
          axioms: [],
        };
      },
    },
  );
});

test("child task states follow the real model queue before requests are transmitted", async () => {
  await harness(async (pipeline) => {
    const config = {
      endpoint: "https://queue-fixture.invalid/v1/chat/completions",
      model: "queue-fixture",
      key: "test",
      concurrency: 1,
      timeoutMs: 2000,
      maxOutputTokens: 100,
      maxResponseBytes: 32768,
    };
    const runs = [0, 1].map(() => ({
      id: randomUUID(),
      status: "running",
      tasks: [],
    }));
    let releaseFirst, startedFirst;
    const started = new Promise((resolve) => {
      startedFirst = resolve;
    });
    const release = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) {
        startedFirst();
        await release;
      }
      return new Response(
        JSON.stringify({
          model: "queue-fixture",
          choices: [
            { finish_reason: "stop", message: { content: '{"ok":true}' } },
          ],
        }),
        { status: 200 },
      );
    };
    const invoke = (run) =>
      pipeline.task(run, "R09G", "Build proof", "model", [], () =>
        callModel(config, {
          role: "R09",
          system: "fixture",
          input: {},
          fetchImpl,
        }),
      );
    const first = invoke(runs[0]);
    await started;
    const second = invoke(runs[1]);
    try {
      const until = Date.now() + 2000;
      while (runs[1].tasks[0]?.status !== "queued" && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(runs[0].tasks[0].status, "running");
      assert.equal(runs[1].tasks[0].status, "queued");
      assert.equal(calls, 1);
    } finally {
      releaseFirst();
    }
    await Promise.all([first, second]);
    assert.equal(calls, 2);
    assert.ok(runs.every((run) => run.tasks[0].status === "succeeded"));
    assert.ok(
      runs.every((run) => run.tasks[0].queuedAt && run.tasks[0].modelStartedAt),
    );
  });
});

const quote = "For every natural number n, n + 0 = n.";
async function fixture() {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman);
  pdf.addPage([612, 792]).drawText(quote, { x: 50, y: 700, font });
  const bytes = Buffer.from(await pdf.save());
  return {
    mode: "manual",
    pdfBase64: bytes.toString("base64"),
    paperSha256: sha256(bytes),
    pageIndex: 0,
    proposal: {
      label: "Theorem 1",
      quote,
      statement: "自然数右加零不变",
      assumptions: ["n 为自然数"],
      leanTarget: "∀ n : Nat, n + 0 = n",
    },
  };
}
async function waitFor(pipeline, id, states) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const run = await pipeline.store.getRun(id);
    if (states.includes(run.status) && !pipeline.active.has(id)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Pipeline did not reach the expected terminal stage");
}
async function harness(action, overrides = {}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "lemma-pipeline-test-"));
  try {
    const store = new EvidenceStore(folder);
    const pipeline = new ReviewPipeline({
      store,
      getConfig: async () => null,
      targetChecker: async (c) => ({
        status: "well_typed",
        targetHash: c.targetHash,
        reason: "Synthetic type-check fixture; real Lean tests are separate.",
      }),
      ...overrides,
    });
    await pipeline.init();
    return await action(pipeline, folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("PDF extraction ignores actual Node watch notifications and preserves parser failures", async () => {
  const input = await fixture();
  const script = `
    import(${JSON.stringify(new URL("../server/pipeline.mjs", import.meta.url).href)})
      .then(async ({ extractInWorker }) => {
        const paper = await extractInWorker(${JSON.stringify(input.pdfBase64)}, null);
        let failure;
        try { await extractInWorker(Buffer.from('not a PDF').toString('base64'), 0); }
        catch (error) { failure = error.message; }
        console.log('RESULT_JSON=' + JSON.stringify({
          hash: paper.paperSha256, pages: paper.pages.length,
          text: paper.pages[0].text, failure
        }));
      }).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--eval", script],
    {
      env: { ...process.env, WATCH_REPORT_DEPENDENCIES: "1" },
      timeout: 10000,
    },
  );
  const result = JSON.parse(
    stdout
      .split("\n")
      .find((line) => line.startsWith("RESULT_JSON="))
      .slice(12),
  );
  assert.equal(result.hash, input.paperSha256);
  assert.equal(result.pages, 1);
  assert.ok(result.text.includes(quote));
  assert.match(result.failure, /读取 PDF 原文失败.*PDF/);
});

test("empty executor errors still persist a readable blocked reason in the task and evidence", async () => {
  await harness(async (pipeline) => {
    const run = {
      id: randomUUID(),
      paperSha256: "a".repeat(64),
      status: "running",
      tasks: [],
    };
    await assert.rejects(
      pipeline.task(
        run,
        "R02",
        "固定论文与原文",
        "pdf_parser",
        [],
        async () => {
          throw new Error("");
        },
      ),
      /固定论文与原文失败/,
    );
    const saved = await pipeline.store.getRun(run.id);
    assert.equal(saved.tasks[0].status, "blocked");
    assert.match(saved.tasks[0].error, /执行器没有返回具体错误信息/);
    const evidence = await pipeline.store.get(saved.tasks[0].output);
    assert.equal(evidence.payload.reason, saved.tasks[0].error);
  });
});

test("manual workflow fixes source/target and exports a complete graph without inventing a model run", async () => {
  await harness(
    async (pipeline) => {
      const started = await pipeline.start(await fixture());
      const draft = await waitFor(pipeline, started.id, [
        "awaiting_confirmation",
      ]);
      assert.equal(
        draft.tasks.some((t) => t.type === "model"),
        false,
      );
      await assert.rejects(
        pipeline.approve(draft.id, {
          targetHash: "b".repeat(64),
          confirmed: true,
        }),
        /不匹配/,
      );
      await assert.rejects(
        pipeline.approve(draft.id, {
          targetHash: draft.contract.targetHash,
          confirmed: true,
          leanTarget: "True",
        }),
        /不能修改/,
      );
      await pipeline.approve(draft.id, {
        targetHash: draft.contract.targetHash,
        semanticArtifact: draft.semanticArtifact,
        resolutions: draft.semanticReview.issues.map((i) => ({
          issueId: i.id,
          decision: "confirmed_with_reason",
          reason:
            "Test-only human attestation of this authored arithmetic fixture.",
        })),
        confirmed: true,
        proof: "by intro n; rfl",
        proofMode: "proof",
      });
      const final = await waitFor(pipeline, draft.id, ["blocked"]);
      assert.equal(final.conclusion.reviewComplete, false);
      assert.equal(final.conclusion.theorem, "unknown");
      assert.equal(final.check.status, "tool_unavailable");
      const bundle = await pipeline.store.bundle(final.root);
      assert.equal(
        inspectBundle(bundle).root.payload.coverage.wholePaperVerified,
        false,
      );
      assert.ok(bundle.artifacts.some((a) => a.payload.pdfBase64));
    },
    {
      checker: async (contract) => ({
        status: "tool_unavailable",
        targetHash: contract.targetHash,
        reason: "test fixture: no executable",
      }),
    },
  );
});

test("mismatched PDF bytes and invented model quotes block before mathematical checking", async () => {
  await harness(async (pipeline) => {
    const input = await fixture();
    input.paperSha256 = "c".repeat(64);
    const start = await pipeline.start(input);
    const final = await waitFor(pipeline, start.id, ["blocked"]);
    assert.match(final.error, /摘要/);
    assert.equal(final.contract, null);
  });
  await harness(
    async (pipeline) => {
      const input = await fixture();
      input.mode = "model";
      const start = await pipeline.start(input);
      const final = await waitFor(pipeline, start.id, ["blocked"]);
      assert.match(final.error, /引句/);
    },
    {
      getConfig: async () => ({ configured: true }),
      model: async () => ({
        parsed: { ...(await fixture()).proposal, quote: "invented source" },
        record: { provider: "mock_for_test_only" },
      }),
    },
  );
});

test("loopback API rejects cross-site calls and malformed inputs", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "lemma-http-test-"));
  const { server } = await createApp({
    dataRoot: folder,
    configProvider: async () => null,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/status`, {
      headers: { Origin: "https://unrelated.example" },
    });
    assert.equal(response.status, 403);
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.model.configured, false);
    const bad = await fetch(`${base}/api/reviews`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});

test("concurrent start requests reserve the execution slot before asynchronous work", async () => {
  await harness(async (pipeline) => {
    const input = await fixture();
    const results = await Promise.allSettled([
      pipeline.start(input),
      pipeline.start(input),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const run = results.find((r) => r.status === "fulfilled").value;
    await waitFor(pipeline, run.id, ["awaiting_confirmation"]);
    const history = await pipeline.store.listRuns(input.paperSha256);
    assert.equal(history.total, 1);
  });
});

test("restart records interrupted execution without silently requesting the model again", async () => {
  await harness(async (pipeline) => {
    const run = {
      id: randomUUID(),
      mode: "model",
      status: "running",
      createdAt: new Date().toISOString(),
      paperSha256: "d".repeat(64),
      pageIndex: 0,
      contract: null,
      root: null,
      tasks: [{ id: randomUUID(), role: "R03", status: "running" }],
    };
    await pipeline.store.saveRun(run);
    let requests = 0;
    const restarted = new ReviewPipeline({
      store: pipeline.store,
      getConfig: async () => {
        requests++;
        return {};
      },
    });
    await restarted.init();
    const saved = await restarted.store.getRun(run.id);
    assert.equal(saved.status, "interrupted");
    assert.equal(saved.tasks[0].status, "interrupted");
    assert.equal(requests, 0);
    assert.equal(saved.root, null);
  });
});

test("a final archive failure withdraws the summary verdict even after a successful checker", async () => {
  await harness(
    async (pipeline) => {
      const started = await pipeline.start(await fixture());
      const draft = await waitFor(pipeline, started.id, [
        "awaiting_confirmation",
      ]);
      const put = pipeline.store.put.bind(pipeline.store);
      pipeline.store.put = (kind, ...rest) => {
        if (kind === "review_report")
          throw new Error("fixture: disk unavailable");
        return put(kind, ...rest);
      };
      await pipeline.approve(draft.id, {
        targetHash: draft.contract.targetHash,
        semanticArtifact: draft.semanticArtifact,
        resolutions: draft.semanticReview.issues.map((i) => ({
          issueId: i.id,
          decision: "confirmed_with_reason",
          reason:
            "Test-only human attestation of this authored arithmetic fixture.",
        })),
        confirmed: true,
        proof: "by intro n; rfl",
        proofMode: "proof",
      });
      const final = await waitFor(pipeline, draft.id, ["blocked"]);
      assert.equal(final.check.status, "verified");
      assert.equal(final.root, null);
      assert.equal(final.conclusion.theorem, "unknown");
      assert.match(final.error, /归档失败/);
    },
    {
      checker: async (contract) => ({
        status: "verified",
        targetHash: contract.targetHash,
        mode: "proof",
        exitCode: 0,
        axioms: [],
      }),
    },
  );
});

test("Agent semantic acceptance binds model evidence and exact target without inventing a human signature", async () => {
  await harness(
    async (p) => {
      const first = await p.start(await fixture());
      const draft = await waitFor(p, first.id, ["awaiting_confirmation"]);
      draft.proofStrategy = "model";
      await p.store.saveRun(draft);
      const value = {
        childRunId: draft.id,
        targetHash: draft.contract.targetHash,
        semanticArtifact: draft.semanticArtifact,
        decision: "counterexample",
        summary: "Fixture verifies route and provenance only.",
        resolutions: draft.semanticReview.issues.map((i) => ({
          issueId: i.id,
          decision: "confirmed_with_reason",
          reason:
            "Fixture independently resolves this exact source interpretation.",
        })),
      };
      const inputs = [draft.contractArtifact, draft.semanticArtifact];
      const invalid = await p.store.put(
        "adaptive:assess_target",
        { value },
        inputs,
      );
      await assert.rejects(p.approveByAgent(draft.id, invalid), /独立模型/);
      const wrong = await p.store.put(
        "adaptive:assess_target",
        {
          value: { ...value, targetHash: "b".repeat(64) },
          model: { testFixture: true },
        },
        inputs,
      );
      await assert.rejects(p.approveByAgent(draft.id, wrong), /对应目标/);
      const valid = await p.store.put(
        "adaptive:assess_target",
        {
          value,
          model: { testFixture: true, requestId: "fixture-agent-decision" },
        },
        inputs,
      );
      let executed;
      p.execute = async (run, input) => {
        executed = input;
        run.status = "completed";
        await p.store.saveRun(run);
      };
      await p.approveByAgent(draft.id, valid);
      const final = await waitFor(p, draft.id, ["completed"]);
      assert.equal(
        final.approval.authority,
        "autonomous_agent_semantic_assessment_not_human",
      );
      assert.equal(final.approval.decisionArtifact, valid);
      assert.equal(executed.proofMode, "counterexample");
      const approval = await p.store.get(final.approvalArtifact);
      assert.ok(approval.inputs.includes(valid));
      assert.equal(final.check, null);
    },
    { getConfig: async () => ({ model: "fixture" }) },
  );
});

test("successful and failed harness workers remain reachable from pipeline task evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-harness-links-"));
  const store = new EvidenceStore(dir);
  await store.init();
  const pipeline = new ReviewPipeline({ store });
  const run = { id: randomUUID(), status: "running", tasks: [] };
  try {
    const detail = await store.put("harness:model", { fixture: true });
    const root = await store.put("harness:report", { fixture: true }, [detail]);
    await pipeline.task(
      run,
      "R06_GRAPH",
      "fixture",
      "original-proof",
      [],
      async () => ({ model: { source: "deepagents-js", harnessRoot: root } }),
    );
    assert(
      (await store.bundle(run.tasks.at(-1).output)).artifacts.some(
        (a) => a.id === detail,
      ),
    );
    const failed = await store.put("harness:interrupted", { fixture: true }, [
      detail,
    ]);
    const error = new Error("known received fixture failure");
    error.harnessRoot = failed;
    await assert.rejects(
      pipeline.task(
        run,
        "R06_STEP",
        "fixture",
        "original-proof",
        [],
        async () => {
          throw error;
        },
      ),
    );
    assert(
      (await store.bundle(run.tasks.at(-1).output)).artifacts.some(
        (a) => a.id === failed,
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
