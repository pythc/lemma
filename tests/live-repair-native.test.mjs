import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DeepProofHarness } from "../server/deep-harness.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import {
  translationSchema,
  ALIGNMENT_CATEGORIES,
} from "../server/translation-wire.mjs";

for (const invalid of [false, true])
  test(
    `HTTP SDK preparation to submission has consistent instructions and fixed locator: invalid=${invalid}`,
    { timeout: 180000 },
    async () => {
      const evidence = path.resolve(
        "evidence/live-repair-20261026/http-attempts",
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
          const first = requests.length === 1;
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
            const prep = JSON.parse(
              body.messages.find((m) => m.role === "tool").content,
            );
            assert.equal(prep.status, "prepared", JSON.stringify(prep));
            assert.equal(prep.sourcePage, 1);
          }
          const args = first
            ? { candidate }
            : {
                ...candidate,
                ...(invalid ? { quote: "A different proposition." } : {}),
              };
          res.setHeader("Content-Type", "application/json");
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
                        id: `call${requests.length}`,
                        type: "function",
                        function: { name, arguments: JSON.stringify(args) },
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
      const harness = new DeepProofHarness({ store });
      try {
        const work = harness.run({
          config: {
            endpoint: `http://127.0.0.1:${server.address().port}`,
            model: "controlled-http",
            key: "local-fixture",
            timeoutMs: 30000,
            maxOutputTokens: 8000,
          },
          goal: "Use read_source to obtain complete source, then prepare_translation. This is an intentionally stale historical instruction.",
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
            },
          },
        });
        if (invalid) await assert.rejects(work);
        else {
          const out = await work;
          assert.equal(out.parsed.quote, quote);
          const run = await store.getRun(out.record.harnessRunId);
          const bundle = await store.bundle(run.root);
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
        assert.equal(
          requests.length,
          2,
          "never retry a rejected final response",
        );
      } finally {
        await harness.close();
        await new Promise((r) => server.close(r));
        console.log("Evidence:", root);
      }
    },
  );

test(
  "interleaved source reads do not erase unchanged native experiment failures",
  { timeout: 180000 },
  async () => {
    const evidence = path.resolve(
      "evidence/live-repair-20261026/repetition-attempts",
    );
    await mkdir(evidence, { recursive: true });
    const dir = await mkdtemp(path.join(evidence, "case-"));
    const store = new EvidenceStore(dir);
    await store.init();
    const source = "An immutable source for a controlled tool experiment.";
    const paperSha256 = sha256(source);
    const sourceArtifact = await store.put("controlled_source", {
      paperSha256,
      pages: [{ index: 0, text: source }],
    });
    let calls = 0;
    const harness = new DeepProofHarness({
      store,
      model: async (_config, req) => {
        calls++;
        assert(
          calls <= 7,
          "a repeated deterministic failure must stop before an eighth request",
        );
        const name = calls % 2 ? "run_python" : "read_source";
        const args =
          calls % 2
            ? { code: 'raise ValueError("controlled unchanged failure")' }
            : { pageIndex: 0 };
        return {
          message: {
            content: null,
            tool_calls: [
              {
                id: `call-${calls}`,
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          record: { role: req.role, scripted: true },
        };
      },
    });
    try {
      let failure;
      try {
        await harness.run({
          config: { model: "local-fixture" },
          goal: "Controlled repetition fixture",
          toolProfile: "review",
          maxCalls: 20,
          inputs: [sourceArtifact],
          taskContext: {
            sourceIdentity: { sourceArtifact, paperSha256 },
            input: {
              context: {
                paperSha256,
                pages: [{ pageIndex: 0, text: source }],
                supplements: [],
              },
            },
          },
        });
      } catch (e) {
        failure = e;
      }
      assert(failure);
      assert.match(failure.message, /No progress/);
      assert.equal(calls, 7);
      const bundle = await store.bundle(failure.harnessRoot);
      assert.equal(
        bundle.artifacts.filter(
          (a) => a.kind === "harness:tool" && a.payload.name === "run_python",
        ).length,
        1,
      );
      assert.equal(
        bundle.artifacts.filter((a) => a.kind === "harness:tool_cache_hit")
          .length,
        3,
      );
      await writeFile(
        path.join(dir, "result.json"),
        JSON.stringify(
          {
            calls,
            root: failure.harnessRoot,
            actualExperimentExecutions: 1,
            cachedFailures: 3,
          },
          null,
          2,
        ),
      );
    } finally {
      await harness.close();
      console.log("Evidence:", dir);
    }
  },
);
