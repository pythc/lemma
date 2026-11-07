import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callModel } from "../server/model.mjs";
import { digest } from "../server/evidence.mjs";
import { ALIGNMENT_CATEGORIES } from "../server/semantics.mjs";
import { blindSemanticInput, mergeSemanticReviews, BLIND_PROMPT, COMPARISON_PROMPT } from "../server/semantic-blind.mjs";
const source = "For every real x, x squared is nonnegative.";
const contract = { targetHash: digest("fixture"), paperSha256: digest(source),
  leanTarget: "∀ x : ℝ, 0 ≤ x ^ 2", quote: source, pageIndex: 0,
  statement: "TRANSLATOR_BIAS_TOKEN", assumptions: ["TRANSLATOR_BIAS_TOKEN"], ambiguity: "" };
const context = { pages: [{ pageIndex: 0, text: source }], omittedPages: [], supplements: [] };
const response = (status) => ({ targetHash: contract.targetHash, backTranslation: source,
  checks: ALIGNMENT_CATEGORIES.map((category) => ({ category, status: category === "domain" ? status : "aligned",
    explanation: "Explicit HTTP fixture source comparison.", anchors: [{ pageIndex: 0, quote: source }] })) });
test("real HTTP first request excludes translator explanation; later agreement cannot erase a blind concern", async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    requests.push(JSON.parse(body));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify(response(requests.length === 1 ? "concern" : "aligned")),
    } }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const config = { endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: "HTTP-fixture",
    key: "HTTP_ONLY_SECRET_DO_NOT_ECHO_7826", timeoutMs: 3000, concurrency: 1 };
  const input = blindSemanticInput(contract, context);
  const first = await callModel(config, { role: "R04", input, system: BLIND_PROMPT });
  const alignment = ALIGNMENT_CATEGORIES.map((category) => ({ category, explanation: "TRANSLATOR_BIAS_TOKEN",
    leanFragment: contract.leanTarget, anchors: [{ pageIndex: 0, quote: source }] }));
  const second = await callModel(config, { role: "R04",
    input: { ...input, alignment, blindResponse: first.parsed }, system: COMPARISON_PROMPT });
  assert.equal(JSON.stringify(requests[0]).includes("TRANSLATOR_BIAS_TOKEN"), false);
  assert.equal(JSON.stringify(requests[1]).includes("TRANSLATOR_BIAS_TOKEN"), true);
  const merged = mergeSemanticReviews(contract, context, alignment, first.parsed, second.parsed, null);
  assert.equal(merged.checks.find((c) => c.category === "domain").status, "concern");
  assert.ok(merged.issues.some((i) => i.code === "review_domain"));
  assert.ok(merged.issues.some((i) => i.code === "blind_comparison_disagreement"));
  assert.equal(merged.disagreements.length, 1);
});
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { semanticModelConfig } from "../server/model.mjs";

test("independent semantic configuration cannot silently fall back when partial", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-semantic-config-"));
  const primary = { LEMMA_MODEL_BASE_URL: "https://primary.example/v1",
    LEMMA_MODEL: "primary", LEMMA_MODEL_API_KEY: "local-fixture-credential" };
  try {
    assert.equal((await semanticModelConfig(root, primary)).model, "primary");
    await assert.rejects(semanticModelConfig(root, { ...primary, LEMMA_SEMANTIC_MODEL: "other" }), /不完整/);
    const config = await semanticModelConfig(root, { ...primary, LEMMA_SEMANTIC_MODEL: "reviewer",
      LEMMA_SEMANTIC_MODEL_BASE_URL: "https://reviewer.example/v1",
      LEMMA_SEMANTIC_MODEL_API_KEY: "independent-fixture-credential", LEMMA_SEMANTIC_MODEL_FAMILY: "declared-family" });
    assert.equal(config.model, "reviewer");
    assert.equal(config.familyEvidence, "operator_declared");
  } finally { await rm(root, { recursive: true }); }
});
