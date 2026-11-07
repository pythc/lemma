import test from "node:test";
import assert from "node:assert/strict";
import {
  ProvingEngine,
  validateProvingBudget,
} from "../server/proving-engine.mjs";
import { createContract } from "../server/contracts.mjs";
import { sha256, digest, inspectBundle } from "../server/evidence.mjs";
import { callModel } from "../server/model.mjs";
import {
  PROOF_RUNTIME,
  PROOF_CEILINGS,
  MODEL_RUNTIME,
  DOMAIN_RUNTIME,
  REVIEW_RUNTIME,
  LEAN_RUNTIME,
  domainProvingBudget,
} from "../server/runtime-limits.mjs";

test("large proof requests reach the model with enlarged input, output and time budgets", async () => {
  const contract = createContract(
    {
      paperSha256: sha256("runtime-fixture"),
      artifact: sha256("source"),
      pageIndex: 0,
      text: "one equals one",
    },
    {
      label: "fixture",
      quote: "one equals one",
      statement: "execution fixture",
      assumptions: [],
      leanTarget: "1 = (1 : Nat)",
    },
  );
  let dispatched = 0;
  const result = await new ProvingEngine({
    knowledge: async () => ({ entries: [] }),
    capabilities: async () => ({ ready: false }),
    specialistAvailable: async () => ({ ready: false }),
    model: async (config, request) => {
      dispatched++;
      assert.equal(config.timeoutMs, 7200000);
      assert.equal(config.maxOutputTokens, 393216);
      assert.ok(JSON.stringify(request.input).length > 300000);
      return { parsed: { mode: "proof", proof: "by rfl" }, record: {} };
    },
    checker: async (c) => ({
      status: "verified",
      mode: "proof",
      targetHash: c.targetHash,
      exitCode: 0,
      axioms: [],
    }),
  }).prove(contract, {
    config: { model: "fixture", timeoutMs: 7200000, maxOutputTokens: 393216 },
    context: { source: "x".repeat(350000) },
    budget: { maxModelCalls: 1, maxTacticSteps: 0 },
  });
  assert.equal(result.report.stopReason, "verified");
  assert.equal(dispatched, 1);
  assert.ok(result.report.inputCharacters > 300000);
});

test("adapter sends the provider's enlarged output limit without changing redaction or finality", async () => {
  let sent;
  const result = await callModel(
    {
      endpoint: "https://example.test/v1/chat/completions",
      model: "fixture",
      key: "fixture-secret",
      timeoutMs: 7200000,
      maxOutputTokens: 393216,
      maxResponseBytes: 33554432,
    },
    {
      role: "R09",
      system: "fixture",
      input: {},
      maxTokens: 393216,
      fetchImpl: async (_url, options) => {
        sent = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            model: "fixture",
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: '{"ok":true}' },
              },
            ],
          }),
        );
      },
    },
  );
  assert.equal(sent.max_tokens, 393216);
  assert.equal(result.parsed.ok, true);
  assert.ok(!JSON.stringify(result.record).includes("fixture-secret"));
});

test("domain helpers inherit large budgets and still honor explicit smaller and parent limits", () => {
  const limits = { ...DOMAIN_RUNTIME, perCallCompletionTokens: 393216 };
  const full = domainProvingBudget({}, limits, 12 * 3600000, 0);
  assert.equal(full.maxModelCalls, 256);
  assert.equal(full.maxCandidates, 128);
  assert.equal(full.maxCompletionTokens, 256 * 393216);
  const limited = domainProvingBudget(
    { maxModelCalls: 40, perCallCompletionTokens: 1000 },
    limits,
    10000,
    510,
  );
  assert.equal(limited.maxModelCalls, 2);
  assert.equal(limited.maxCompletionTokens, 2000);
  assert.equal(limited.maxElapsedMs, 10000);
});

test("outer review limits cover individual proof runs while finite ceilings remain enforced", () => {
  assert.ok(REVIEW_RUNTIME.maxRunMs > PROOF_RUNTIME.maxElapsedMs);
  assert.ok(REVIEW_RUNTIME.maxModelCalls > PROOF_RUNTIME.maxModelCalls);
  assert.equal(LEAN_RUNTIME.specialistOutputTokens, 40000);
  assert.deepEqual(validateProvingBudget(PROOF_RUNTIME), PROOF_RUNTIME);
  for (const [key, max] of Object.entries(PROOF_CEILINGS)) {
    assert.throws(() => validateProvingBudget({ [key]: max + 1 }));
  }
  assert.throws(() =>
    validateProvingBudget({ maxCompletionTokens: Number.MAX_SAFE_INTEGER + 1 }),
  );
});

test("large evidence paths validate without overflowing the JavaScript call stack", () => {
  const artifacts = [];
  let previous = null;
  for (let i = 0; i < 10000; i++) {
    const body = {
      kind: "runtime-limit-fixture",
      payload: { i },
      inputs: previous ? [previous] : [],
    };
    previous = digest(body);
    artifacts.push({ id: previous, ...body });
  }
  const bundle = {
    schemaVersion: "lemma.evidence.v1",
    root: previous,
    artifacts,
  };
  assert.equal(inspectBundle(bundle, previous).artifacts.size, 10000);
  assert.throws(() => inspectBundle(bundle, previous, 9999));
  assert.throws(
    () => inspectBundle({ ...bundle, artifacts: artifacts.slice(1) }, previous),
    /缺少依赖/,
  );
});
