import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, cp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import {
  DeepProofHarness,
  harnessModelAdapter,
} from "../server/deep-harness.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import {
  translationSchema,
  validateTranslationWire,
  ALIGNMENT_CATEGORIES,
  ALIGNMENT_REPAIR_PROMPT,
} from "../server/translation-wire.mjs";

const proposal = () => ({
  label: "component",
  quote: "True.",
  statement: "True.",
  assumptions: [],
  leanTarget: "True",
  ambiguity: "",
  alignment: ALIGNMENT_CATEGORIES.map((category) => ({
    category,
    explanation: "Fixed source.",
    leanFragment: "True",
    anchors: [{ pageIndex: 0, quote: "True." }],
  })),
});
test("one translation schema rejects placeholder enums, missing fields and a changed repair target", () => {
  validateTranslationWire(proposal());
  assert(!ALIGNMENT_REPAIR_PROMPT.includes('category":"与原清单一致'));
  for (const change of [
    (p) => (p.alignment[0].category = "与原清单一致"),
    (p) => delete p.alignment[0].leanFragment,
    (p) => (p.alignment[0].category = "conclusion"),
  ]) {
    const p = proposal();
    change(p);
    assert.throws(() => validateTranslationWire(p));
  }
  assert.throws(() =>
    validateTranslationWire(
      { alignment: proposal().alignment, leanTarget: "False" },
      { repair: true },
    ),
  );
  const bad = proposal();
  bad.alignment[0].category = "与原清单一致";
  assert.throws(
    () => validateTranslationWire(bad),
    (error) =>
      error.auditValidation.issues.some(
        (issue) => issue.path === "alignment.0.category",
      ),
  );
});
for (const invalid of [false, true, "repair"])
  test(`actual HTTP and SDK structured final ${invalid === "repair" ? "one explicit alignment repair preserves fixed fields" : invalid ? "rejects without hidden retry" : "returns typed data"}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sixth-sdk-"));
    let calls = 0;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      calls++;
      if (!body.tools) {
        assert.equal(invalid, "repair");
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({ alignment: proposal().alignment }),
                },
              },
            ],
          }),
        );
        return;
      }
      if (body.tools.some((t) => t.function.name === "prepare_translation")) {
        const candidate = proposal();
        delete candidate.ambiguity;
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "prep",
                      type: "function",
                      function: {
                        name: "prepare_translation",
                        arguments: JSON.stringify({ candidate }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
        return;
      }
      const output = body.tools.find(
        (t) =>
          t.function.parameters.properties?.leanTarget &&
          !["inspect_modules", "plan_lemmas"].includes(t.function.name) &&
          JSON.stringify(t.function.parameters).includes("alignment"),
      );
      assert(output, JSON.stringify(body.tools.map((t) => t.function.name)));
      assert.equal(
        output.function.parameters.type,
        "object",
        "Provider requires a top-level object, not a root union",
      );
      const p = proposal();
      if (invalid) p.alignment[0].category = "与原清单一致";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "submit",
                    type: "function",
                    function: {
                      name: output.function.name,
                      arguments: JSON.stringify(p),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const store = new EvidenceStore(root),
      h = new DeepProofHarness({ store });
    try {
      const run = () =>
        h.run({
          config: {
            endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
            key: "local-fixture",
            model: "scripted",
            maxOutputTokens: 2000,
            timeoutMs: 5000,
          },
          goal: "Submit the fixed fixture",
          toolProfile: "review",
          outputSchema: translationSchema,
          maxCalls: 3,
        });
      if (invalid === "repair") {
        const adapter = harnessModelAdapter({ harness: h });
        const r = await adapter(
          {
            endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
            key: "local-fixture",
            model: "scripted",
            timeoutMs: 5000,
          },
          {
            role: "R03",
            system: "fixed source",
            input: {
              context: {
                paperSha256: sha256("True."),
                pages: [{ pageIndex: 0, text: "True." }],
                supplements: [],
              },
            },
            outputSchema: translationSchema,
          },
        );
        assert.deepEqual(r.parsed, proposal());
        assert.equal(r.record.structuredAttempts.length, 2);
        const b = await store.bundle(r.record.harnessRoot);
        assert(b.artifacts.some((a) => a.kind === "harness:interrupted"));
      } else if (invalid)
        await assert.rejects(run(), (e) => {
          assert(e.harnessRoot);
          return true;
        });
      else {
        const r = await run();
        assert.deepEqual(r.parsed, proposal());
        assert(r.record.structuredSchemaHash);
      }
      assert.equal(calls, invalid === "repair" ? 3 : 1);
    } finally {
      await h.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      if (process.env.LEMMA_TEST_EVIDENCE_DIR) {
        await mkdir(process.env.LEMMA_TEST_EVIDENCE_DIR, { recursive: true });
        await cp(
          root,
          path.join(process.env.LEMMA_TEST_EVIDENCE_DIR, path.basename(root)),
          { recursive: true },
        );
      }
      await rm(root, { recursive: true, force: true });
    }
  });

for (const unavailable of [false, true])
  test(`actual SDK final slot without preparation ${unavailable ? "can report unavailable" : "cannot admit a candidate"}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unprepared-final-"));
    let calls = 0;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      calls++;
      assert.equal(body.tools.length, 2);
      const output = body.tools.find((t) =>
        unavailable
          ? t.function.parameters.properties?.unavailable
          : t.function.parameters.properties?.leanTarget,
      );
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "final",
                    type: "function",
                    function: {
                      name: output.function.name,
                      arguments: JSON.stringify(
                        unavailable
                          ? { unavailable: "No preparation capacity remains." }
                          : proposal(),
                      ),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const store = new EvidenceStore(root),
      harness = new DeepProofHarness({ store });
    try {
      const run = () =>
        harness.run({
          config: {
            endpoint: `http://127.0.0.1:${server.address().port}`,
            key: "fixture",
            model: "scripted",
            timeoutMs: 5000,
          },
          goal: "Fixed fixture",
          toolProfile: "review",
          translationStage: true,
          // A translation request now needs the same immutable source identity
          // as the product path; the no-preparation acceptance assertion stays.
          taskContext: {
            input: {
              context: {
                paperSha256: sha256("True."),
                pages: [{ pageIndex: 0, text: "True." }],
                supplements: [],
              },
              selectedPage: 0,
              selectedQuote: "True.",
            },
          },
          outputSchema: translationSchema,
          maxCalls: 1,
        });
      if (unavailable) assert((await run()).parsed.unavailable);
      else await assert.rejects(run(), /lacks an executed preparation receipt/);
      assert.equal(calls, 1);
    } finally {
      await harness.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      if (process.env.LEMMA_TEST_EVIDENCE_DIR) {
        await mkdir(process.env.LEMMA_TEST_EVIDENCE_DIR, { recursive: true });
        await cp(
          root,
          path.join(process.env.LEMMA_TEST_EVIDENCE_DIR, path.basename(root)),
          { recursive: true },
        );
      }
      await rm(root, { recursive: true, force: true });
    }
  });
