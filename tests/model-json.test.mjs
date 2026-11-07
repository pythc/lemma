import test from "node:test";
import assert from "node:assert/strict";
import {
  parseModelJson,
  parseModelFinalObject,
} from "../server/model-json.mjs";
test("one complete final JSON fence preserves exact mathematical strings and framing provenance", () => {
  const object = {
    quote: "Exact source.",
    leanTarget: "∀ n : Nat, n = n",
    proof: "by\n  intro n\n  rfl",
  };
  for (const raw of [
    "```json\n" + JSON.stringify(object) + "\n```",
    "Type inspection completed; this is not a proof.\n\n```json\n" +
      JSON.stringify(object) +
      "\n```\nThe payload follows the requested schema.",
  ]) {
    const r = parseModelFinalObject(raw);
    assert.deepEqual(r.parsed, object);
    assert.equal(r.normalization.kind, "single_fenced_json_object");
    assert.match(r.normalization.rawSha256, /^[a-f0-9]{64}$/);
    assert.match(r.normalization.normalizedSha256, /^[a-f0-9]{64}$/);
    assert.throws(
      () => parseModelJson(raw),
      "Strict JSON parsing remains strict",
    );
  }
});
test("final framing cannot repair truncation, choose between candidates, or manufacture an object", () => {
  for (const raw of [
    '```json\n{"quote":"x"',
    '```json\n{"quote":\n```',
    '```json\n{"x":1}\n```\n```json\n{"x":2}\n```',
    '{"other":1}\n```json\n{"x":1}\n```',
    "```json\n[]\n```",
    "Verified without evidence.",
  ])
    assert.throws(() => parseModelFinalObject(raw));
});
test("valid JSON mathematical values are never rewritten", () => {
  const value = {
    leanTarget: "∀ x : ℝ, x = x",
    proof: 'by\n  exact { field := "}" }',
    data: { a: [1, 2] },
  };
  const r = parseModelJson(JSON.stringify(value));
  assert.deepEqual(r.parsed, value);
  assert.equal(r.normalization, null);
});
test("only redundant terminal object closers can be removed, with provenance", () => {
  const text = JSON.stringify({ proof: "by rfl", data: { a: 1 } });
  for (const count of [1, 2, 8]) {
    const r = parseModelJson(text + "}".repeat(count));
    assert.deepEqual(r.parsed, JSON.parse(text));
    assert.equal(r.normalization.count, count);
    assert.match(r.normalization.rawSha256, /^[a-f0-9]{64}$/);
    assert.match(r.normalization.normalizedSha256, /^[a-f0-9]{64}$/);
  }
});
test("missing data, extra documents and substantive damage remain errors", () => {
  for (const text of [
    '{"x":1',
    '{"x":1}{"y":2}',
    '{"x":1} trailing',
    '{"x":1}};',
    '{"x":1}' + "}".repeat(9),
    "[1,2]}",
    '{"x":"unterminated}}',
  ])
    assert.throws(() => parseModelJson(text));
  assert.deepEqual(
    parseModelJson("[]").parsed,
    [],
    "object-shape validation remains the caller responsibility",
  );
});

import { callModel } from "../server/model.mjs";
test("transport preserves raw output and refuses truncated answers or malformed tool arguments", async () => {
  const cfg = {
    endpoint: "https://example.test/v1/chat/completions",
    key: "fixture-only-key",
    model: "fixture",
    concurrency: 1,
    timeoutMs: 5000,
  };
  const object = {
    leanTarget: "∀ x : Nat, x = x",
    explanation: "fixture, not a mathematical benchmark",
  };
  const raw = JSON.stringify(object) + "}";
  const envelope =
    (content, finish = "stop", calls) =>
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: finish,
              message: {
                role: "assistant",
                content,
                ...(calls ? { tool_calls: calls } : {}),
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
  const r = await callModel(cfg, {
    role: "RDP",
    system: "fixture",
    input: { fixture: true },
    fetchImpl: envelope(raw),
  });
  assert.deepEqual(r.parsed, object);
  assert.equal(r.record.content, raw);
  assert.equal(r.record.contentNormalization.count, 1);
  const wrapped =
    "Diagnostic only.\n```json\n" + JSON.stringify(object) + "\n```";
  const framed = await callModel(cfg, {
    role: "RDP",
    system: "fixture",
    input: {},
    fetchImpl: envelope(wrapped),
  });
  assert.deepEqual(framed.parsed, object);
  assert.equal(framed.record.content, wrapped);
  assert.equal(
    framed.record.contentNormalization.kind,
    "single_fenced_json_object",
  );
  await assert.rejects(
    callModel(cfg, {
      role: "RDP",
      system: "fixture",
      input: {},
      fetchImpl: envelope(raw, "length"),
    }),
    /不完整/,
  );
  const tools = [
    {
      type: "function",
      function: {
        name: "probe",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
  await assert.rejects(
    callModel(cfg, {
      messages: [{ role: "user", content: "fixture" }],
      tools,
      fetchImpl: envelope(null, "tool_calls", [
        {
          id: "x",
          type: "function",
          function: { name: "probe", arguments: "{} }" },
        },
      ]),
    }),
    /工具参数/,
  );
});
