import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HARNESS_CONTEXT_POLICY } from "../server/harness-context.mjs";
import { DeepProofHarness } from "../server/deep-harness.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import {
  translationSchema,
  ALIGNMENT_CATEGORIES,
} from "../server/translation-wire.mjs";

for (const invalid of ["paper", "span", "missing", "capacity"])
  test(`invalid mandatory source ${invalid} is archived before any local HTTP request`, async () => {
    const base = path.resolve(
      process.env.LEMMA_TEST_EVIDENCE_DIR ||
        "evidence/live-repair4/source-http",
    );
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(path.join(base, "invalid-source-"));
    const store = new EvidenceStore(dir);
    await store.init();
    const quote = "Proposition. " + "Exact source. ".repeat(100);
    const context = {
      paperSha256: sha256(quote),
      pages: [{ pageIndex: 0, text: quote }],
      supplements: [],
    };
    const sourceArtifact = await store.put("controlled_source", context);
    const input = {
      context: structuredClone(context),
      selectedPage: 0,
      selectedQuote: "Proposition.",
      propositionScope: {
        locator: { pageIndex: 0, quote: "Proposition." },
        spans: [{ pageIndex: 0, quote }],
      },
    };
    if (invalid === "paper") input.context.paperSha256 = sha256("foreign");
    if (invalid === "span")
      input.propositionScope.spans[0].quote = "Invented source.";
    if (invalid === "missing") input.propositionScope.spans = [];
    let calls = 0;
    const server = createServer((req, res) => {
      calls++;
      res.writeHead(503);
      res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const harness = new DeepProofHarness({
      store,
      contextPolicy: {
        ...HARNESS_CONTEXT_POLICY,
        ...(invalid === "capacity" ? { wireCharacters: 1001 } : {}),
      },
    });
    try {
      await assert.rejects(
        harness.run({
          config: {
            endpoint: `http://127.0.0.1:${server.address().port}`,
            key: "local-fixture",
            model: "local-source-guard",
          },
          goal: "Translate fixed source",
          translationStage: true,
          toolProfile: "review",
          outputSchema: translationSchema,
          maxCalls: 4,
          inputs: [sourceArtifact],
          taskContext: {
            input,
            sourceIdentity: {
              paperSha256: context.paperSha256,
              sourceArtifact,
            },
          },
        }),
        (asyncError) => {
          assert(
            asyncError.harnessRoot,
            "Rejected source still has an evidence root",
          );
          return true;
        },
      );
      assert.equal(
        calls,
        0,
        "No summary or translation may dispatch with invalid mandatory source",
      );
      await writeFile(
        path.join(dir, "result.json"),
        JSON.stringify({
          invalid,
          localHTTPRequests: calls,
          externalModelCalls: 0,
        }),
      );
    } finally {
      await harness.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

for (const regime of [
  "short",
  "summary",
  "offload",
  "repeat_summary",
  "wrong_tool",
])
  test(
    `HTTP SDK full source and preparation survive ${regime}`,
    { timeout: 180000 },
    async () => {
      const evidence = path.resolve(
        process.env.LEMMA_TEST_EVIDENCE_DIR ||
          "evidence/live-repair4/source-http",
      );
      await mkdir(evidence, { recursive: true });
      const root = await mkdtemp(path.join(evidence, "case-"));
      const store = new EvidenceStore(root);
      await store.init();
      const quote = "Every natural number equals itself.";
      const context = {
        paperSha256: sha256("fixture"),
        pages: [
          { pageIndex: 0, text: "Earlier definition." },
          { pageIndex: 1, text: quote },
        ],
        supplements: [],
      };
      const sourceArtifact = await store.put("controlled_source", {
        paperSha256: context.paperSha256,
        pages: context.pages,
      });
      const candidate = {
        label: "fixture",
        quote,
        statement: quote,
        assumptions: [],
        leanTarget: "∀ n : Nat, n = n",
        ambiguity: "",
        alignment: ALIGNMENT_CATEGORIES.map((category) => ({
          category,
          leanFragment: "n = n",
          explanation: "Controlled fixture.",
          anchors: [{ pageIndex: 1, quote }],
        })),
      };
      const fixtureErrors = [];
      const requests = [];
      let mainCalls = 0,
        summaries = 0;
      const server = createServer(async (req, res) => {
        let raw = "";
        for await (const c of req) raw += c;
        const body = JSON.parse(raw);
        requests.push(body);
        await writeFile(
          path.join(root, `wire-${requests.length}.json`),
          JSON.stringify(body, null, 2),
        );
        try {
          if (!body.tools?.length) {
            summaries++;
            assert.equal(body.max_tokens, 4096);
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: "stop",
                    message: {
                      role: "assistant",
                      content:
                        "Navigation summary only. No full source or preparation copied here; reread the immutable packet.",
                    },
                  },
                ],
              }),
            );
            return;
          }
          mainCalls++;
          const first = mainCalls === 1;
          const sourceMessage = body.messages.find((m) =>
            m.content?.startsWith(
              "Immutable translation source for this request.",
            ),
          );
          assert(
            sourceMessage,
            "Source is present in the actual HTTP request after SDK transformations",
          );
          const packet = JSON.parse(
            sourceMessage.content.slice(
              sourceMessage.content.indexOf("\n") + 1,
            ),
          );
          assert.deepEqual(
            packet.spans.map((s) => s.quote),
            context.pages.map((p) => p.text),
          );
          assert.equal(packet.selectedPage, 1);
          assert.equal(packet.selectedQuote, quote);
          assert.equal(packet.paperSha256, context.paperSha256);
          assert.equal(packet.sourceArtifact, sourceArtifact);
          assert(
            body.messages
              .at(-1)
              .content.includes(
                first ? "Immutable translation source" : "Recorded preparation",
              ),
          );
          assert.equal(body.thinking.type, "disabled");
          assert.deepEqual(
            body.tool_choice,
            first
              ? { type: "function", function: { name: "prepare_translation" } }
              : "required",
          );
          const system = body.messages.find((m) => m.role === "system").content;
          assert(
            system.includes(
              first
                ? "Current phase: PREPARATION"
                : "Current phase: FINAL SUBMISSION",
            ),
          );
          assert(!system.includes("Use read_source to obtain complete"));
          let name;
          if (first) {
            assert.deepEqual(
              body.tools.map((t) => t.function.name),
              ["prepare_translation"],
            );
            name = "prepare_translation";
          } else {
            assert.equal(body.tools.length, 2);
            name = body.tools.find(
              (t) => t.function.parameters.properties?.quote,
            ).function.name;
            assert.deepEqual(
              body.tools.map((t) => t.function.name),
              ["submit_translation", "translation_unavailable"],
            );
            const preparedMessage = body.messages.find((m) =>
              m.content?.startsWith(
                "Recorded preparation for this exact translation",
              ),
            );
            assert(
              preparedMessage,
              "Exact preparation survives forced compaction",
            );
            const prep = JSON.parse(
              preparedMessage.content.slice(
                preparedMessage.content.indexOf("\n") + 1,
              ),
            ).payload.value;
            assert.equal(prep.status, "prepared", JSON.stringify(prep));
            assert.equal(prep.sourcePage, 1);
          }
          const args = first
            ? { candidate }
            : {
                ...candidate,
              };
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    ...(first && regime === "repeat_summary"
                      ? {
                          reasoning_content:
                            "SYNTHETIC_PRIVATE_" + "x".repeat(100000),
                        }
                      : {}),
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: `call${requests.length}`,
                        type: "function",
                        function: {
                          name:
                            !first && regime === "wrong_tool"
                              ? "prepare_translation"
                              : name,
                          arguments: JSON.stringify(args),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          );
        } catch (e) {
          fixtureErrors.push(e);
          await writeFile(path.join(root, "fixture-error.txt"), e.stack);
          console.error("CONTROLLED SERVER", e.message);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const harness = new DeepProofHarness({
        store,
        contextPolicy: {
          ...HARNESS_CONTEXT_POLICY,
          ...(regime === "repeat_summary" ? { wireCharacters: 60000 } : {}),
        },
      });
      try {
        const work = harness.run({
          config: {
            endpoint: `http://127.0.0.1:${server.address().port}`,
            model: "controlled-http",
            key: "local-fixture",
            timeoutMs: 30000,
            maxOutputTokens: 8000,
          },
          goal:
            "Use read_source. This deliberately stale instruction must not override the current phase.\n" +
            "controlled bulky diagnostic ".repeat(
              regime === "offload"
                ? 24000
                : ["summary", "repeat_summary"].includes(regime)
                  ? 6500
                  : 0,
            ),
          translationStage: true,
          toolProfile: "review",
          outputSchema: translationSchema,
          maxCalls: 4,
          inputs: [sourceArtifact],
          taskContext: {
            sourceIdentity: {
              paperSha256: context.paperSha256,
              sourceArtifact,
            },
            input: {
              context,
              selectedPage: 1,
              selectedQuote: quote,
              libraryProfile: { id: "std-v1" },
              propositionScope: {
                locator: { pageIndex: 1, quote },
                spans: context.pages.map((p) => ({
                  pageIndex: p.pageIndex,
                  quote: p.text,
                })),
              },
            },
          },
        });
        if (regime === "wrong_tool") await assert.rejects(work);
        else {
          const out = await work;
          assert.equal(out.parsed.quote, quote);
          const run = await store.getRun(out.record.harnessRunId);
          const bundle = await store.bundle(run.root);
          assert(
            !JSON.stringify(bundle).includes("SYNTHETIC_PRIVATE_"),
            "Private continuation content stays out of exported evidence",
          );
          assert(
            bundle.artifacts.some(
              (a) => a.kind === "translation_source_packet",
            ),
          );
          assert(
            bundle.artifacts.some(
              (a) =>
                a.kind === "harness:tool" &&
                a.payload.name === "prepare_translation" &&
                a.payload.value.status === "prepared",
            ),
          );
        }
        assert.deepEqual(fixtureErrors, []);
        if (regime === "summary") assert(summaries >= 1);
        if (regime === "repeat_summary")
          assert(summaries >= 2, "Exercise compaction again after preparation");
        assert(
          requests.length <= 4,
          "Every controlled development case stays within four local calls",
        );
        await writeFile(
          path.join(root, "case-result.json"),
          JSON.stringify({
            regime,
            mainCalls,
            summaries,
            requests: requests.length,
            externalModelCalls: 0,
          }),
        );
        assert.equal(mainCalls, 2, "never retry a rejected final response");
      } finally {
        await harness.close();
        await new Promise((r) => server.close(r));
        console.log("Evidence:", root);
      }
    },
  );
