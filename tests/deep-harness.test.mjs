import { privateModelMessage } from "../server/public-model-view.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { callModel } from "../server/model.mjs";
import { safeArchiveEntries } from "../server/external-libraries.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import {
  createContract,
  withExternalLibraries,
  validateContract,
} from "../server/contracts.mjs";
import {
  DeepProofHarness,
  commandSandbox,
  harnessModelAdapter,
} from "../server/deep-harness.mjs";
import { runBounded } from "../server/lean.mjs";

const cfg = {
  endpoint: "https://example.test/v1/chat/completions",
  key: "unit-only-key",
  model: "fake",
  concurrency: 1,
  timeoutMs: 5000,
  maxOutputTokens: 1000,
};
test("source planning roles use tools with source context and fresh proof scope", async () => {
  const { freshProofSession } = await import("../server/proof-autonomy.mjs");
  const contract = { targetHash: "fixed", sourceArtifact: "source" },
    context = { pages: [{ text: "source" }] },
    autonomy = freshProofSession();
  const seen = [];
  const adapter = harnessModelAdapter({
    harness: {
      run: async (options) => {
        seen.push(options);
        return { parsed: { graph: {} }, contract };
      },
    },
    model: async () => ({ plain: true }),
  });
  for (const role of [
    "R06_GRAPH",
    "R06_INTERFACES",
    "R06_INTERFACE_REPAIR",
    "R06_BLUEPRINT_REPAIR",
    "R06_FORMALIZE",
    "R06_STEP",
  ]) {
    await adapter(cfg, {
      role,
      system: "fixture",
      input: { contract, context, autonomy },
    });
    const options = seen.at(-1);
    assert.equal(options.planningOnly, role !== "R06_STEP");
    assert.deepEqual(options.routeContext.sourceContext, context);
    assert.deepEqual(options.routeContext.autonomy, autonomy);
    assert.deepEqual(options.contract, contract);
  }
  assert.deepEqual(
    await adapter(cfg, { role: "R06_ALIGN", input: { contract } }),
    { plain: true },
  );
});
const fetchResult =
  (message, finish = "tool_calls") =>
  async (_url, o) => {
    const req = JSON.parse(o.body);
    assert(!req.response_format);
    return new Response(
      JSON.stringify({
        model: "fake",
        choices: [{ message, finish_reason: finish }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
test("structured stage rejects received prose while preserving its harness evidence", async () => {
  const record = {
    harnessRoot: "immutable-root",
    harnessRunId: "received-run",
    toolReceipts: [],
  };
  const adapter = harnessModelAdapter({
    harness: {
      run: async () => ({
        parsed: { answer: "No structured result." },
        record,
      }),
    },
  });
  await assert.rejects(
    adapter(cfg, {
      role: "R03",
      system: "fixture",
      input: { selectedQuote: "fixed source" },
    }),
    (e) => {
      assert.match(e.message, /格式/);
      assert.doesNotMatch(e.message, /改变.*范围/);
      assert.equal(e.modelRecord.harnessRoot, record.harnessRoot);
      assert.equal(e.modelRecord.error.code, "model_invalid_json");
      assert.equal(e.modelRecord.error.delivery.outcome, "received");
      assert.equal(
        record.error,
        undefined,
        "Original evidence is not rewritten",
      );
      return true;
    },
  );
});
test("tool transport accepts tool-only answers and keeps provider context private in receipts", async () => {
  const r = await callModel(cfg, {
    messages: [
      { role: "assistant", content: "", reasoning_content: "private-context" },
    ],
    tools: [
      {
        type: "function",
        function: { name: "check_lean", parameters: { type: "object" } },
      },
    ],
    fetchImpl: fetchResult({
      role: "assistant",
      content: null,
      reasoning_content: "next-private",
      tool_calls: [
        {
          id: "a",
          type: "function",
          function: { name: "check_lean", arguments: '{"proof":"by rfl"}' },
        },
      ],
    }),
  });
  assert.equal(r.message.tool_calls[0].id, "a");
  assert.equal(privateModelMessage({ ...r }).reasoning_content, "next-private");
  assert(
    !JSON.stringify({ ...r, message: { ...r.message } }).includes(
      "next-private",
    ),
  );
  assert(!JSON.stringify(r.record).includes("private-context"));
  assert(!JSON.stringify(r.record).includes("next-private"));
});
test("truncation, unregistered tools, malformed arguments and credential echo cannot become tool results", async () => {
  for (const [message, finish] of [
    [{ role: "assistant", content: "partial" }, "length"],
    [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "other", arguments: "{}" },
          },
        ],
      },
      "tool_calls",
    ],
    [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "check_lean", arguments: "[1]" },
          },
        ],
      },
      "tool_calls",
    ],
    [{ role: "assistant", content: cfg.key }, "stop"],
  ])
    await assert.rejects(
      callModel(cfg, {
        messages: [{ role: "user", content: "test" }],
        tools: [{ type: "function", function: { name: "check_lean" } }],
        fetchImpl: fetchResult(message, finish),
      }),
    );
});
test("archive extraction rejects traversal; external descriptors cannot silently change a target", () => {
  assert.throws(
    () =>
      safeArchiveEntries(zipSync({ "repo/../../escape.lean": strToU8("bad") })),
    /Unsafe/,
  );
  const c = createContract(
    {
      paperSha256: "a".repeat(64),
      pageIndex: 0,
      text: "same",
      artifact: "b".repeat(64),
    },
    {
      label: "test",
      quote: "same",
      statement: "same",
      assumptions: [],
      leanTarget: "1 = 1",
    },
  );
  const n = withExternalLibraries(c, [
    {
      id: "c".repeat(64),
      tree: { sha256: "d".repeat(64) },
      modules: ["External.Lemma"],
    },
  ]);
  assert.equal(n.leanTarget, c.leanTarget);
  assert.notEqual(n.targetHash, c.targetHash);
  assert.equal(validateContract(n), n);
  assert.throws(() => validateContract({ ...n, imports: ["Std"] }));
});
test("real Deep Agents loop invokes a tool and saves linked evidence without trusting final self-report", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-unit-"));
  let count = 0;
  const store = new EvidenceStore(root);
  await store.init();
  const source = await store.put("explicit_unit_fixture", { text: "same" });
  const contract = createContract(
    {
      paperSha256: sha256("same"),
      pageIndex: 0,
      text: "same",
      artifact: source,
    },
    {
      label: "test",
      quote: "same",
      statement: "same",
      assumptions: [],
      leanTarget: "1 = 1",
    },
  );
  const h = new DeepProofHarness({
    store,
    checker: async (c, p) => ({
      status: p === "by rfl" ? "verified" : "not_verified",
      mode: "proof",
      targetHash: c.targetHash,
      exitCode: 0,
      axioms: [],
    }),
    model: async (_c, r) => {
      count++;
      assert(r.tools.length > 0);
      return {
        message:
          count === 1
            ? {
                content: null,
                tool_calls: [
                  {
                    id: "test-call",
                    function: {
                      name: "check_lean",
                      arguments:
                        '{"proof":"by rfl","libraryIds":[],"mode":"proof"}',
                    },
                  },
                ],
              }
            : {
                content:
                  "Here is the requested candidate.\n```json\n" +
                  JSON.stringify({
                    mode: "proof",
                    proof: "by exact nope",
                    route: "original",
                  }) +
                  "\n```",
              },
        record: {
          role: r.role,
          finishReason: count === 1 ? "tool_calls" : "stop",
        },
      };
    },
  });
  try {
    const r = await h.run({
      config: cfg,
      contract,
      inputs: [source],
      goal: "test",
      maxCalls: 3,
    });
    assert.equal(count, 2);
    assert.equal(r.check.status, "not_verified");
    assert.equal(
      r.record.finalContentNormalization.kind,
      "single_fenced_json_object",
    );
    const bundle = await store.bundle(r.record.harnessRoot);
    assert(bundle.artifacts.some((a) => a.kind === "harness:tool"));
    assert.equal((await store.getRun(r.record.harnessRunId)).modelCalls, 2);
  } finally {
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("unknown model outcomes are archived and never automatically retried", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-unknown-"));
  let count = 0;
  const h = new DeepProofHarness({
    store: new EvidenceStore(root),
    model: async () => {
      count++;
      const e = Error("unknown transport outcome");
      e.modelRecord = { error: { code: "model_transport_error" } };
      throw e;
    },
  });
  try {
    await assert.rejects(
      h.run({ config: cfg, goal: "unit fixture", maxCalls: 3 }),
      /unknown/,
    );
    assert.equal(count, 1);
  } finally {
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});
test(
  "execution sandbox permits workspace writes and denies outside reads and network",
  { skip: process.platform !== "darwin" },
  async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "harness-sandbox-"));
    const { realpath } = await import("node:fs/promises");
    const root = await realpath(folder);
    const secret = path.join(os.tmpdir(), `harness-denied-${Date.now()}`);
    await writeFile(secret, "outside-secret");
    try {
      const r = await runBounded(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          commandSandbox(root),
          "/bin/sh",
          "-c",
          `printf ok > inside; cat ${secret}; /usr/bin/curl --connect-timeout 1 http://127.0.0.1:4178/`,
        ],
        {
          cwd: root,
          env: { PATH: "/usr/bin:/bin", HOME: root },
          timeoutMs: 5000,
        },
      );
      assert.equal(await readFile(path.join(root, "inside"), "utf8"), "ok");
      assert(!r.stdout.includes("outside-secret"));
      assert.notEqual(r.exitCode, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(secret, { force: true });
    }
  },
);

test("HTTP harness starts asynchronously and exposes a linked bundle and replay", async () => {
  const { createApp } = await import("../server/index.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-http-"));
  let calls = 0;
  const app = await createApp({
    dataRoot: dir,
    configProvider: async () => cfg,
    checker: async (c, p) => ({
      status: "verified",
      targetHash: c.targetHash,
      mode: "proof",
      exitCode: 0,
      axioms: [],
      sourceSha256: sha256("explicit controlled HTTP fixture"),
    }),
    model: async () => ({
      message:
        ++calls === 1
          ? {
              content: null,
              tool_calls: [
                {
                  id: "one",
                  function: {
                    name: "check_lean",
                    arguments:
                      '{"proof":"by rfl","libraryIds":[],"mode":"proof"}',
                  },
                },
              ],
            }
          : { content: JSON.stringify({ mode: "proof", proof: "by rfl" }) },
      record: { source: "explicit_controlled_http_fixture" },
    }),
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const source = await app.store.put("controlled_http_fixture", {
      text: "same",
    });
    const contract = createContract(
      {
        paperSha256: sha256("same"),
        pageIndex: 0,
        text: "same",
        artifact: source,
      },
      {
        label: "fixture",
        quote: "same",
        statement: "same",
        assumptions: [],
        leanTarget: "1 = 1",
      },
    );
    const start = await fetch(base + "/api/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "controlled test",
        contract,
        inputs: [source],
      }),
    });
    assert.equal(start.status, 202);
    const { id } = await start.json();
    let run;
    for (let n = 0; n < 100; n++) {
      run = await (await fetch(base + `/api/harness/${id}`)).json();
      if (run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(run.status, "completed");
    assert.equal(calls, 2);
    const bundle = await (
      await fetch(base + `/api/harness/${id}/bundle`)
    ).json();
    assert.equal(bundle.root, run.root);
    const replay = await (
      await fetch(base + `/api/harness/${id}/replay`, { method: "POST" })
    ).json();
    assert.equal(replay.reproduced, true);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
