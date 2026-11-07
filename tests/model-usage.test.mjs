import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { callModel } from "../server/model.mjs";
import { modelUsage } from "../server/model-usage.mjs";
test("numeric allowlist rejects poisoned metrics without retaining secrets or thoughts", () => {
  const r = modelUsage({
    prompt_tokens: -1,
    completion_tokens: 1.5,
    total_tokens: "123",
    secret: "secret",
    completion_tokens_details: {
      reasoning_tokens: 123,
      reasoning_content: "private",
    },
    prompt_tokens_details: { cached_tokens: NaN, api_key: "secret" },
  });
  assert.equal(r.prompt_tokens, null);
  assert.equal(r.completion_tokens, null);
  assert.equal(r.total_tokens, null);
  assert.equal(r.completion_tokens_details.reasoning_tokens, 123);
  assert.equal(r.prompt_tokens_details.cached_tokens, null);
  assert.ok(!JSON.stringify(r).includes("secret"));
  assert.ok(!JSON.stringify(r).includes("private"));
});
test("real HTTP length receipt retains usage, digest and timing, without private text", async () => {
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        model: "fixture",
        system_fingerprint: "fp-test",
        choices: [
          {
            finish_reason: "length",
            message: {
              role: "assistant",
              content: "",
              reasoning_content: "private text",
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 100,
          total_tokens: 112,
          completion_tokens_details: { reasoning_tokens: 100 },
        },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(
      callModel(
        {
          endpoint: `http://127.0.0.1:${server.address().port}`,
          key: "fixture-key",
          model: "fixture",
          maxOutputTokens: 100,
          timeoutMs: 5000,
        },
        { role: "R04", system: "JSON", input: {} },
      ),
      (e) => {
        const r = e.modelRecord;
        assert.equal(r.usage.completion_tokens_details.reasoning_tokens, 100);
        assert.equal(r.finishCategory, "generation_limit");
        assert.match(r.privateContextSha256, /^[a-f0-9]{64}$/);
        assert.equal(r.publicContentCharacters, 0);
        assert.equal(r.systemFingerprint, "fp-test");
        assert.equal(r.resource.executionStarted, true);
        assert.ok(r.resource.queueMs >= 0);
        assert.ok(!JSON.stringify(r).includes("private text"));
        return true;
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
