import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AdaptiveReview } from "../server/adaptive.mjs";
import { EvidenceStore, sha256, inspectBundle } from "../server/evidence.mjs";
import {
  validateDecision,
  validateInspection,
} from "../server/adaptive-schema.mjs";

const quote =
  "Every bounded sequence of real numbers has a convergent subsequence.";
const bytes = Buffer.from("Test-only PDF stand-in. Parser is injected.");
const source = {
  paperSha256: sha256(bytes),
  pageCount: 2,
  pages: [
    { index: 0, text: quote },
    {
      index: 1,
      text: "Proof. Apply the lemma. Reference [1] is not included.",
    },
  ],
};
const input = {
  pdfBase64: bytes.toString("base64"),
  paperSha256: source.paperSha256,
  libraryProfile: "std-v1",
};
const reading = {
  summary: "本文提出一个命题并引用引理。",
  claims: [
    {
      label: "Theorem 1",
      pageIndex: 0,
      quote,
      statement: "有界实数序列有收敛子列。",
    },
  ],
};
const anchor = { pageIndex: 0, quote };
function scripted(planKinds = ["inspect_proof", "inspect_definitions"]) {
  const calls = [];
  const model = async (config, req) => {
    calls.push(req.role);
    let parsed;
    if (req.role === "A_READ") parsed = reading;
    else if (req.role === "A_COORDINATOR") {
      const n = req.input.tasks.filter((t) =>
        t.kind.startsWith("inspect_"),
      ).length;
      parsed =
        n >= planKinds.length
          ? { mode: "finish", reason: "本轮检查已结束，保留引用未解决项。" }
          : {
              mode: "act",
              reason: "上一产物需要进一步核对。",
              actions: [
                {
                  kind: planKinds[n],
                  title: "检查实际发现的问题",
                  question: `question-${n}`,
                  reason: "前一步发现依赖。",
                  claimId: req.input.claims[0].id,
                  basedOn: [req.input.tasks.at(-1).id],
                },
              ],
            };
    } else
      parsed = {
        status: "unresolved",
        summary: "仍需验证依赖。",
        anchors: [anchor],
        nextQuestion: "核对定义。",
      };
    return { parsed, record: { testFixture: true, role: req.role } };
  };
  return { calls, model };
}
async function wait(
  a,
  id,
  statuses = ["completed", "blocked", "paused", "awaiting_confirmation"],
) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const r = await a.store.getRun(id);
    if (statuses.includes(r.status) && !a.active.has(id)) return r;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("adaptive run timed out");
}
async function harness(fn, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-adaptive-"));
  const store = new EvidenceStore(dir);
  const script = scripted(options.planKinds);
  const pipeline = { active: new Map(), reserved: false };
  let a = new AdaptiveReview({
    store,
    pipeline,
    getConfig: async () => ({ model: "fixture" }),
    model: script.model,
    extract: async () => source,
    ...options,
  });
  await a.init();
  try {
    await fn(a, script, dir);
  } finally {
    await a.close();
    await rm(dir, { recursive: true, force: true });
  }
}
test("LangGraph executes two different paper-driven paths and exports actual evidence", async () => {
  for (const kinds of [
    ["inspect_proof", "inspect_definitions"],
    ["inspect_citation"],
  ])
    await harness(
      async (a, { calls }) => {
        const started = await a.start(input),
          r = await wait(a, started.id);
        assert.equal(r.status, "completed", r.error);
        assert.deepEqual(
          r.tasks
            .filter((t) => t.kind.startsWith("inspect_"))
            .map((t) => t.kind),
          kinds,
        );
        assert.equal(r.findings.length, kinds.length);
        assert.ok(!calls.includes("R03"));
        for (const t of r.tasks)
          for (const id of t.parents || [])
            assert.ok(r.tasks.some((p) => p.id === id));
        assert.equal(new Set(r.events.map((e) => e.seq)).size, r.events.length);
        inspectBundle(await a.store.bundle(r.root), r.root);
        assert.equal(r.conclusion.theorem, "unknown");
      },
      { planKinds: kinds },
    );
});
test("parallel Send branches preserve both results, queue states, and causal dependencies", async () => {
  await harness(async (a) => {
    const original = a.model;
    a.model = async (c, req) => {
      if (req.role === "A_COORDINATOR" && !req.input.findings.length)
        return {
          parsed: {
            mode: "act",
            reason: "两个独立问题。",
            actions: ["inspect_proof", "inspect_definitions"].map((kind) => ({
              kind,
              title: kind,
              question: kind,
              reason: "独立检查。",
              claimId: req.input.claims[0].id,
              basedOn: [req.input.tasks.at(-1).id],
            })),
          },
          record: { testFixture: true },
        };
      if (req.role === "A_COORDINATOR")
        return {
          parsed: { mode: "finish", reason: "两个结果已返回。" },
          record: { testFixture: true },
        };
      return original(c, req);
    };
    const r = await wait(a, (await a.start(input)).id);
    assert.equal(r.status, "completed", r.error);
    assert.equal(r.findings.length, 2);
    const branch = r.tasks.filter((t) => t.kind.startsWith("inspect_"));
    assert.equal(branch[0].parents[0], branch[1].parents[0]);
    const executionOrder = [...branch].sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt),
    );
    assert.ok(executionOrder[1].startedAt >= executionOrder[0].endedAt);
  });
});
test("checkpoint retry reuses successful reading and retains the failed attempt", async () => {
  await harness(async (a, { calls }) => {
    const model = a.model;
    let fail = true;
    a.model = async (c, req) => {
      if (req.role === "A_PROOF" && fail) {
        fail = false;
        throw Error("fixture transport failure");
      }
      return model(c, req);
    };
    const id = (await a.start(input)).id;
    let r = await wait(a, id);
    assert.equal(r.status, "blocked");
    await a.resume(id);
    r = await wait(a, id);
    assert.equal(r.status, "completed", r.error);
    assert.equal(calls.filter((v) => v === "A_READ").length, 1);
    const attempts = r.tasks.filter((t) => t.kind === "inspect_proof");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].status, "blocked");
    assert.equal(attempts[1].status, "succeeded");
  });
});
test("pause uses a real LangGraph interrupt and continues without replaying reading", async () => {
  await harness(async (a, { calls }) => {
    const original = a.model;
    let unblock;
    const barrier = new Promise((r) => (unblock = r));
    a.model = async (c, req) => {
      if (req.role === "A_READ") await barrier;
      return original(c, req);
    };
    const id = (await a.start(input)).id;
    await a.pause(id);
    unblock();
    let r = await wait(a, id);
    assert.equal(r.status, "paused");
    const snapshot = await a.graph.getState({
      configurable: { thread_id: id },
    });
    assert.ok(snapshot.tasks.some((t) => t.interrupts?.length));
    await a.resume(id);
    r = await wait(a, id);
    assert.equal(r.status, "completed", r.error);
    assert.equal(calls.filter((v) => v === "A_READ").length, 1);
  });
});
test("unknown capabilities, missing source anchors and imaginary dependencies are rejected", () => {
  const run = {
    claims: [{ id: "c" }],
    tasks: [{ id: "t", output: "hash", kind: "read" }],
  };
  const action = {
    kind: "inspect_proof",
    claimId: "c",
    title: "proof",
    question: "check",
    reason: "reason",
    basedOn: ["t"],
  };
  assert.throws(() =>
    validateDecision(
      {
        mode: "act",
        reason: "reason",
        actions: [{ ...action, kind: "shell" }],
      },
      run,
    ),
  );
  assert.throws(() =>
    validateDecision(
      {
        mode: "act",
        reason: "reason",
        actions: [{ ...action, basedOn: ["fiction"] }],
      },
      run,
    ),
  );
  assert.throws(() =>
    validateInspection(
      {
        status: "no_issue_found",
        summary: "verified",
        anchors: [{ pageIndex: 0, quote: "does not exist" }],
      },
      source,
      run.claims[0],
    ),
  );
  assert.throws(() =>
    validateDecision({ mode: "finish", reason: "all correct" }, run),
  );
});
test("restart resumes a failed checkpoint from disk and does not rerun successful model calls", async () => {
  await harness(async (a, { calls }, dir) => {
    const original = a.model;
    let failed = false;
    a.model = async (c, req) => {
      if (req.role === "A_PROOF" && !failed) {
        failed = true;
        throw Error("transport interrupted");
      }
      return original(c, req);
    };
    const id = (await a.start(input)).id;
    assert.equal((await wait(a, id)).status, "blocked");
    await a.close();
    const b = new AdaptiveReview({
      store: a.store,
      pipeline: a.pipeline,
      getConfig: a.getConfig,
      model: original,
      extract: async () => source,
    });
    await b.init();
    try {
      await b.resume(id);
      const r = await wait(b, id);
      assert.equal(r.status, "completed", r.error);
      assert.equal(calls.filter((c) => c === "A_READ").length, 1);
    } finally {
      await b.close();
    }
  });
});
test("invalid model output is retained before semantic validation rejects it", async () => {
  await harness(async (a) => {
    a.model = async () => ({
      parsed: {
        summary: "fabricated",
        claims: [
          { label: "T", pageIndex: 99, quote: "fiction", statement: "fiction" },
        ],
      },
      record: { testFixture: true, requestId: "fixture-id" },
    });
    const r = await wait(a, (await a.start(input)).id);
    assert.equal(r.status, "blocked");
    const failed = r.tasks.find((t) => t.kind === "read");
    const inputArtifacts = await Promise.all(
      failed.inputs.map((id) => a.store.get(id)),
    );
    const response = inputArtifacts.find(
      (a) => a.kind === "adaptive_model_response",
    );
    assert.equal(response.payload.parsed.claims[0].pageIndex, 99);
    assert.equal(response.payload.model.requestId, "fixture-id");
  });
});
test("cancellation prevents queued branches from invoking the model and records a terminal state", async () => {
  await harness(async (a) => {
    const original = a.model;
    let readStarted;
    const started = new Promise((r) => (readStarted = r));
    a.model = async (c, req) => {
      if (req.role === "A_READ") {
        readStarted();
        await new Promise((resolve, reject) => {
          req.signal.addEventListener(
            "abort",
            () => reject(Error("cancelled")),
            { once: true },
          );
        });
      }
      return original(c, req);
    };
    const id = (await a.start(input)).id;
    await started;
    await a.cancel(id);
    const r = await wait(a, id, ["cancelled"]);
    assert.equal(r.status, "cancelled");
    assert.ok(!r.tasks.some((t) => t.kind === "decide"));
    assert.equal(r.root, null);
  });
});
test("concurrent resumes reserve one execution slot", async () => {
  await harness(async (a) => {
    const original = a.model;
    let fail = true;
    a.model = async (c, req) => {
      if (req.role === "A_PROOF" && fail) {
        fail = false;
        throw Error("retry fixture");
      }
      return original(c, req);
    };
    const id = (await a.start(input)).id;
    await wait(a, id);
    const results = await Promise.allSettled([a.resume(id), a.resume(id)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await wait(a, id)).status, "completed");
  });
});

test("restart does not auto-plan after a child with an unknown external outcome", async () => {
  await harness(async (a, { calls }) => {
    const r = await wait(a, (await a.start(input)).id);
    await a.close();
    const childId = "9cf330b6-ae8f-493f-9cec-d3ed67b45010";
    await a.store.saveRun({
      id: childId,
      status: "interrupted",
      tasks: [],
      error: "unknown external outcome",
    });
    r.status = "awaiting_confirmation";
    r.tasks.push({
      id: "child-task-fixture",
      kind: "formalize",
      childRunId: childId,
      childFinal: false,
    });
    await a.store.saveRun(r);
    const before = calls.length;
    const b = new AdaptiveReview({
      store: a.store,
      pipeline: a.pipeline,
      getConfig: a.getConfig,
      model: a.model,
      extract: a.extract,
    });
    await b.init();
    try {
      await b.continueChildren();
      assert.equal((await b.store.getRun(r.id)).status, "interrupted");
      assert.equal(b.active.size, 0);
      assert.equal(calls.length, before);
    } finally {
      await b.close();
    }
  });
});
