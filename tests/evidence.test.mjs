import { MODEL_RUNTIME } from "../server/runtime-limits.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { EvidenceStore, digest, inspectBundle } from "../server/evidence.mjs";
import {
  createContract,
  deriveConclusion,
  validateContract,
  validateLeanText,
} from "../server/contracts.mjs";
import { callModel, modelConfig } from "../server/model.mjs";

const source = {
  paperSha256: "a".repeat(64),
  artifact: "b".repeat(64),
  pageIndex: 0,
  text: "For every natural n, n + 0 = n.",
};
test("concurrent progress saves keep the latest complete run across store instances", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "lemma-run-save-"));
  try {
    const first = new EvidenceStore(folder);
    const second = new EvidenceStore(folder);
    await first.init();
    const id = "10000000-0000-4000-8000-000000000001";
    const older = {
      id,
      status: "running",
      payload: "x".repeat(8 * 1024 * 1024),
    };
    const completed = { id, status: "completed", root: "a".repeat(64) };
    await Promise.all([first.saveRun(older), second.saveRun(completed)]);
    assert.deepEqual(await first.getRun(id), completed);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
const proposal = {
  label: "Theorem 1",
  quote: source.text,
  statement: "自然数右加零不变",
  assumptions: ["n 为自然数"],
  leanTarget: "∀ n : Nat, n + 0 = n",
};

test("content-addressed bundle rejects changed evidence, missing parents and unrelated artifacts", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "lemma-evidence-test-"));
  try {
    const store = new EvidenceStore(folder);
    await store.init();
    const original = await store.put("paper", { bytes: "fixed" });
    const root = await store.put("report", { conclusion: "unknown" }, [
      original,
    ]);
    const bundle = await store.bundle(root);
    assert.equal(inspectBundle(bundle, root).artifacts.size, 2);
    const changed = structuredClone(bundle);
    changed.artifacts[0].payload.bytes = "altered";
    assert.throws(() => inspectBundle(changed), /修改/);
    assert.throws(
      () => inspectBundle({ ...bundle, artifacts: bundle.artifacts.slice(1) }),
      /缺少/,
    );
    const stray = { kind: "stray", payload: {}, inputs: [] };
    assert.throws(
      () =>
        inspectBundle({
          ...bundle,
          artifacts: [...bundle.artifacts, { id: digest(stray), ...stray }],
        }),
      /未关联/,
    );
    assert.throws(() => inspectBundle(bundle, "c".repeat(64)), /预期/);
    const disk = await readFile(
      path.join(folder, "artifacts", `${original}.json`),
      "utf8",
    );
    assert.equal(digest(JSON.parse(disk)), original);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("fixed target cannot be changed after approval; quote must occur in the actual source", () => {
  const contract = createContract(source, proposal);
  assert.throws(
    () => validateContract({ ...contract, leanTarget: "True" }),
    /修改/,
  );
  assert.throws(
    () => createContract(source, { ...proposal, quote: "Another theorem" }),
    /未在/,
  );
  for (const attack of [
    "by sorry",
    "by admit",
    "by native_decide",
    "by run_tac pure ()",
    "True\naxiom bad : False",
    "#eval IO.println 1",
  ])
    assert.throws(
      () => validateLeanText(attack, "proof", 1000),
      /不允许|未完成/,
    );
});

test("contracts freeze the library revision and import allowlist while retaining v1 evidence", () => {
  const current = createContract(source, proposal, "analysis-continuity-v1");
  assert.equal(current.schemaVersion, "lemma.contract.v2");
  for (const change of [
    { imports: ["Mathlib"] },
    { libraryRevision: "latest" },
    { libraryProfile: "unknown" },
  ]) {
    const { targetHash, ...body } = { ...current, ...change };
    assert.throws(
      () => validateContract({ ...body, targetHash: digest(body) }),
      /不支持|不受/,
    );
  }
  const { targetHash, libraryProfile, libraryRevision, ...body } =
    createContract(source, proposal);
  body.schemaVersion = "lemma.contract.v1";
  assert.equal(
    validateContract({ ...body, targetHash: digest(body) }).schemaVersion,
    "lemma.contract.v1",
  );
  assert.throws(() => createContract(source, proposal, "unknown"), /不支持/);
});

test("proof gaps, a foreign target, unapproved semantics and forbidden axioms cannot imply theorem correctness", () => {
  const contract = createContract(source, proposal);
  const approval = { confirmed: true, targetHash: contract.targetHash };
  const check = {
    status: "verified",
    mode: "proof",
    targetHash: contract.targetHash,
    exitCode: 0,
    axioms: [],
  };
  assert.equal(
    deriveConclusion({ contract, originalProof: { status: "gap_candidate" } })
      .theorem,
    "semantic_review_required",
  );
  assert.equal(
    deriveConclusion({
      contract,
      approval,
      check: { ...check, targetHash: "c".repeat(64) },
    }).theorem,
    "unknown",
  );
  assert.equal(
    deriveConclusion({
      contract,
      approval,
      check: { ...check, axioms: ["sorryAx"] },
    }).theorem,
    "unknown",
  );
  const result = deriveConclusion({
    contract,
    approval,
    check,
    originalProof: { status: "gap_candidate" },
  });
  assert.equal(result.theorem, "formalized_proved");
  assert.equal(result.originalProof, "gap_candidate");
  assert.equal(result.wholePaperVerified, false);
  assert.equal(
    deriveConclusion({
      contract,
      approval,
      check: { ...check, mode: "counterexample" },
    }).theorem,
    "refuted",
  );
  assert.equal(
    deriveConclusion({ contract, approval, check, status: "cancelled" })
      .theorem,
    "unknown",
  );
  assert.equal(
    deriveConclusion({
      contract,
      approval,
      check: { ...check, mode: "invalid" },
    }).theorem,
    "unknown",
  );
});

test("OpenAI-compatible adapter archives I/O without authentication headers and rejects incomplete replies", async () => {
  const config = {
    endpoint: "http://127.0.0.1/v1/chat/completions",
    model: "test-model",
    key: "TEST_ONLY_SECRET",
  };
  let authorization;
  const fetchImpl = async (_url, options) => {
    authorization = options.headers.Authorization;
    return new Response(
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { content: '{"ok":true}' } },
        ],
      }),
    );
  };
  const value = await callModel(config, {
    role: "R03",
    system: "test",
    input: { source: "fixture" },
    fetchImpl,
  });
  assert.equal(authorization, "Bearer TEST_ONLY_SECRET");
  assert.equal(value.parsed.ok, true);
  assert.ok(!JSON.stringify(value.record).includes("TEST_ONLY_SECRET"));
  assert.equal(value.record.responseModel, null);
  let cancelled = false;
  await assert.rejects(
    callModel(config, {
      role: "R03",
      system: "test",
      input: {},
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(70000));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    }),
    /响应超过/,
  );
  assert.equal(
    cancelled,
    true,
    "Oversize streams must stop before reading the full body",
  );
  await assert.rejects(
    callModel(config, {
      role: "R03",
      system: "test",
      input: {},
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "length", message: { content: "{}" } }],
          }),
        ),
    }),
    /不完整/,
  );
  await assert.rejects(
    modelConfig("/nonexistent", {
      LEMMA_MODEL_BASE_URL: "https://example.test/v1?key=bad",
      LEMMA_MODEL: "model",
      LEMMA_MODEL_API_KEY: "secret",
    }),
    /不要在地址/,
  );
});

test("explicit reasoning effort reaches the provider and actual metadata stays distinct", async () => {
  const config = await modelConfig("/nonexistent", {
    LEMMA_MODEL_BASE_URL: "http://127.0.0.1:5005/v1",
    LEMMA_MODEL: "gpt-6-thinking",
    LEMMA_MODEL_API_KEY: "TEST_ONLY_SECRET",
    LEMMA_MODEL_REASONING_EFFORT: "high",
    LEMMA_MODEL_TIMEOUT_MS: "300000",
  });
  assert.equal(config.timeoutMs, 300000);
  let sent;
  const result = await callModel(config, {
    role: "R03",
    system: "fixture",
    input: {},
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          model: "gpt-6-thinking",
          thinking_effort: "extended",
          choices: [
            { finish_reason: "stop", message: { content: '{"ok":true}' } },
          ],
        }),
      );
    },
  });
  assert.equal(sent.reasoning_effort, "high");
  assert.equal(result.record.request.reasoning_effort, "high");
  assert.equal(result.record.responseThinkingEffort, "extended");
  assert.equal(result.record.responseModel, "gpt-6-thinking");
  assert.ok(!JSON.stringify(result.record).includes(config.key));
  const defaults = await modelConfig("/nonexistent", {
    LEMMA_MODEL_BASE_URL: "https://example.test/v1",
    LEMMA_MODEL: "model",
    LEMMA_MODEL_API_KEY: "secret",
  });
  assert.equal(defaults.reasoningEffort, null);
  assert.equal(defaults.timeoutMs, MODEL_RUNTIME.defaultTimeoutMs);
  for (const override of [
    { LEMMA_MODEL_REASONING_EFFORT: "heavy" },
    { LEMMA_MODEL_TIMEOUT_MS: "0" },
    { LEMMA_MODEL_TIMEOUT_MS: String(MODEL_RUNTIME.timeoutMs + 1) },
    { LEMMA_MODEL_TIMEOUT_MS: "NaN" },
  ])
    await assert.rejects(
      modelConfig("/nonexistent", {
        LEMMA_MODEL_BASE_URL: "https://example.test/v1",
        LEMMA_MODEL: "model",
        LEMMA_MODEL_API_KEY: "secret",
        ...override,
      }),
      /思考强度|模型超时/,
    );
});

test("local escape wrapper preserves raw output without accepting malformed or mixed JSON", async () => {
  const config = {
    endpoint: "https://example.test/v1/chat/completions",
    model: "test",
    key: "secret",
  };
  const invoke = (content) =>
    callModel(config, {
      role: "R03",
      system: "fixture",
      input: {},
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content } }],
          }),
        ),
    });
  const raw = '  <escape>\n{"label":"A1"}\n</escape>  ';
  const value = await invoke(raw);
  assert.deepEqual(value.parsed, { label: "A1" });
  assert.equal(value.record.content, raw);
  assert.equal(value.record.contentWrapper, "escape");
  for (const bad of [
    '<escape>{"label":',
    "<escape>{}</escape>extra",
    "extra<escape>{}</escape>",
    "<escape>{} {}</escape>",
    "<escape><escape>{}</escape></escape>",
    "[]",
    "null",
    '"string"',
  ])
    await assert.rejects(invoke(bad), /JSON/);
});

test("model errors retain bounded redacted provider evidence and correlation ID", async () => {
  const config = {
    endpoint: "http://127.0.0.1/v1/chat/completions",
    model: "fixture",
    key: "TEST_PRIVATE_KEY_123",
  };
  let sentId;
  await assert.rejects(
    callModel(config, {
      role: "R03",
      system: "fixture",
      input: {},
      fetchImpl: async (_url, init) => {
        sentId = init.headers["X-Client-Request-Id"];
        return new Response(
          JSON.stringify({
            error: {
              code: "upstream_no_final",
              retryable: true,
              message: `Bearer ${config.key}`,
              access_token: "ANOTHER_PRIVATE_TOKEN",
              reasoning_content: "PRIVATE_INTERNAL_TEXT",
            },
          }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "X-Request-Id": "provider-42",
            },
          },
        );
      },
    }),
    (error) => {
      const r = error.modelRecord;
      assert.match(error.message, /HTTP 502.*upstream_no_final/);
      assert.equal(r.requestId, sentId);
      assert.equal(r.http.serverRequestId, "provider-42");
      assert.equal(r.http.status, 502);
      assert.equal(r.http.bodyDigestScope, "complete_body");
      assert.equal(r.error.retryable, true);
      assert.ok(r.http.errorBody.includes("upstream_no_final"));
      for (const secret of [
        config.key,
        "ANOTHER_PRIVATE_TOKEN",
        "PRIVATE_INTERNAL_TEXT",
      ])
        assert.ok(!JSON.stringify(r).includes(secret));
      assert.ok(Number.isFinite(r.elapsedMs));
      return true;
    },
  );
  let cancelled = false;
  await assert.rejects(
    callModel(config, {
      role: "R03",
      system: "fixture",
      input: {},
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array(20000));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 502 },
        ),
    }),
    (e) => {
      assert.equal(e.modelRecord.http.retainedBytes, 16384);
      assert.equal(e.modelRecord.http.truncated, true);
      assert.equal(e.modelRecord.http.bodyDigestScope, "retained_prefix");
      return true;
    },
  );
  assert.equal(cancelled, true);
});

test("configured large output survives the old response cap while malformed and nonfinal results stay rejected", async () => {
  const config = await modelConfig("/nonexistent", {
    LEMMA_MODEL_BASE_URL: "http://127.0.0.1/v1",
    LEMMA_MODEL: "fixture",
    LEMMA_MODEL_API_KEY: "TEST_PRIVATE_KEY_123",
    LEMMA_MODEL_TIMEOUT_MS: "3600000",
    LEMMA_MODEL_MAX_OUTPUT_TOKENS: "262144",
    LEMMA_MODEL_MAX_RESPONSE_BYTES: "16777216",
  });
  assert.equal(config.timeoutMs, 3600000);
  const payload = { text: "x".repeat(240000) };
  let sent;
  const result = await callModel(config, {
    role: "RDP",
    system: "fixture",
    input: {},
    maxTokens: 8000,
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: JSON.stringify(payload) },
            },
          ],
          usage: {
            prompt_tokens: 42,
            completion_tokens: 12,
            total_tokens: 54,
            reasoning_tokens: 3,
          },
          lifecycle: {
            thoughts_message_count: 2,
            snapshot_reads: 3,
            recovered_from_snapshot: true,
            analysis: "PRIVATE_ANALYSIS",
          },
          gateway_budget: {
            generation_posts: 1,
            snapshot_reads: 3,
            generation_retries: 0,
          },
        }),
      );
    },
  });
  assert.equal(result.record.usage.total_tokens, 54);
  assert.equal(result.record.usage.reasoning_tokens, 3);
  assert.equal(result.record.lifecycle.thoughts_message_count, 2);
  assert.equal(result.record.lifecycle.recovered_from_snapshot, true);
  assert.equal(result.record.gatewayBudget.generation_posts, 1);
  assert.equal(result.record.gatewayBudget.generation_retries, 0);
  assert.ok(!JSON.stringify(result.record).includes("PRIVATE_ANALYSIS"));
  assert.equal(sent.max_tokens, 262144);
  assert.equal(result.parsed.text.length, payload.text.length);
  assert.equal(result.record.http.truncated, false);
  for (const content of [
    "invalid envelope",
    JSON.stringify({
      choices: [
        {
          finish_reason: "length",
          message: {
            role: "assistant",
            channel: "analysis",
            content: "PRIVATE_ANALYSIS_MUST_NOT_BE_RECORDED",
          },
        },
      ],
    }),
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            channel: "analysis",
            content: '{"ok":true}',
          },
        },
      ],
    }),
  ]) {
    await assert.rejects(
      callModel(config, {
        role: "R03",
        system: "fixture",
        input: {},
        fetchImpl: async () => new Response(content),
      }),
      (e) => {
        assert.ok(
          ["model_invalid_envelope", "model_nonfinal"].includes(
            e.modelRecord.error.code,
          ),
        );
        assert.equal(e.modelRecord.content, null);
        return true;
      },
    );
  }
  for (const over of [
    { LEMMA_MODEL_MAX_OUTPUT_TOKENS: String(MODEL_RUNTIME.outputTokens + 1) },
    { LEMMA_MODEL_MAX_RESPONSE_BYTES: String(MODEL_RUNTIME.responseBytes + 1) },
  ])
    await assert.rejects(
      modelConfig("/nonexistent", {
        LEMMA_MODEL_BASE_URL: "http://127.0.0.1/v1",
        LEMMA_MODEL: "fixture",
        LEMMA_MODEL_API_KEY: "key",
        ...over,
      }),
    );
});

test("model cancellation and transport failure are archived without leaking credentials", async () => {
  const config = {
    endpoint: "http://127.0.0.1/v1/chat/completions",
    model: "fixture",
    key: "TEST_PRIVATE_KEY_123",
  };
  const cancelled = new AbortController();
  cancelled.abort();
  let called = false;
  await assert.rejects(
    callModel(config, {
      role: "R03",
      system: "fixture",
      input: {},
      signal: cancelled.signal,
      fetchImpl: async () => {
        called = true;
        return new Response();
      },
    }),
    (e) => e.modelRecord.error.code === "model_cancelled",
  );
  assert.equal(called, false);
  await assert.rejects(
    callModel(config, {
      role: "R03",
      system: "fixture",
      input: {},
      fetchImpl: async () => {
        throw new Error(`Network failed for Bearer ${config.key}`);
      },
    }),
    (e) => {
      assert.equal(e.modelRecord.error.code, "model_transport_error");
      assert.ok(!JSON.stringify(e.modelRecord).includes(config.key));
      return true;
    },
  );
  await assert.rejects(
    callModel(
      { ...config, timeoutMs: 1 },
      {
        role: "R03",
        system: "fixture",
        input: {},
        fetchImpl: async (_url, init) => {
          await new Promise((r) => setTimeout(r, 10));
          init.signal.throwIfAborted();
        },
      },
    ),
    (e) => e.modelRecord.error.code === "model_timeout",
  );
});

test("real HTTP model transport waits for final JSON and aborts both headers and body", async () => {
  let mode = "complete",
    calls = 0,
    receivedId = null;
  const timers = new Set();
  const later = (fn) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, 30);
    timers.add(timer);
  };
  const server = createServer((req, res) => {
    calls++;
    receivedId = req.headers["x-client-request-id"];
    req.resume();
    if (mode === "headers") return;
    res.writeHead(200, {
      "content-type": "application/json",
      "x-request-id": "local-fixture",
    });
    if (mode === "body") {
      res.write('{"choices":[');
      return;
    }
    later(() =>
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: '{"complete":true}' },
            },
          ],
        }),
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const config = {
    endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    model: "http-fixture",
    key: "LOCAL_FIXTURE_SECRET",
    timeoutMs: 3600000,
  };
  const options = { role: "R03", system: "fixture", input: {} };
  try {
    const result = await callModel(config, options);
    assert.deepEqual(result.parsed, { complete: true });
    assert.equal(receivedId, result.record.requestId);
    assert.equal(result.record.http.serverRequestId, "local-fixture");
    for (const waiting of ["headers", "body"]) {
      mode = waiting;
      await assert.rejects(
        callModel({ ...config, timeoutMs: 60 }, options),
        (e) => e.modelRecord.error.code === "model_timeout",
      );
    }
    mode = "body";
    const controller = new AbortController();
    const request = callModel(config, {
      ...options,
      signal: controller.signal,
    });
    const cancel = setTimeout(() => controller.abort(), 60);
    try {
      await assert.rejects(
        request,
        (e) => e.modelRecord.error.code === "model_cancelled",
      );
    } finally {
      clearTimeout(cancel);
    }
    mode = "headers";
    await assert.rejects(
      callModel(config, { ...options, signal: AbortSignal.timeout(60) }),
      (e) => {
        assert.equal(e.modelRecord.error.code, "model_timeout");
        assert.equal(e.modelRecord.error.timeoutScope, "caller_deadline");
        return true;
      },
    );
    assert.equal(calls, 5);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
