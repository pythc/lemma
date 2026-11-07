import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeepProofHarness } from "../server/deep-harness.mjs";
import { HARNESS_CONTEXT_POLICY } from "../server/harness-context.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";

test(
  "actual SDK and HTTP summary cap overrides large global output config without changing main calls",
  { timeout: 180000 },
  async () => {
    const evidence = path.resolve("evidence/live-repair-20261026/summary-http");
    await mkdir(evidence, { recursive: true });
    const dir = await mkdtemp(path.join(evidence, "case-"));
    const store = new EvidenceStore(dir);
    await store.init();
    const source = await store.put("controlled_source", {
      text: "Controlled fixture",
    });
    const contract = createContract(
      {
        text: "Controlled fixture",
        artifact: source,
        paperSha256: sha256("fixture"),
        pageIndex: 0,
      },
      {
        label: "Fixture",
        quote: "Controlled fixture",
        statement: "Every natural number equals itself",
        assumptions: [],
        leanTarget: "∀ n : Nat, n = n",
      },
    );
    let main = 0,
      summaries = 0;
    const bodies = [];
    const fixtureErrors = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      bodies.push(body);
      try {
        let message,
          finish = "stop";
        if (!body.tools?.length) {
          summaries++;
          assert.equal(body.max_tokens, 4096);
          assert.deepEqual(body.thinking, { type: "disabled" });
          message = {
            role: "assistant",
            content:
              "Controlled navigation summary: pwd returned the workspace. Exact target is in Task.json and Goal.lean. No proof has passed. Submit the fixture proof for a fresh native check.",
          };
        } else {
          main++;
          assert.equal(body.max_tokens, 393216);
          if (main === 1) {
            finish = "tool_calls";
            message = {
              role: "assistant",
              content: null,
              reasoning_content:
                "SYNTHETIC_PRIVATE_CONTEXT_" + "x".repeat(100000),
              tool_calls: [
                {
                  id: "pwd",
                  type: "function",
                  function: {
                    name: "run_command",
                    arguments: JSON.stringify({ command: "pwd" }),
                  },
                },
              ],
            };
          } else
            message = {
              role: "assistant",
              content: JSON.stringify({
                mode: "proof",
                route: "original",
                proof: "by intro n; rfl",
                explanation: "Controlled native fixture, not a paper proof",
              }),
            };
        }
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ choices: [{ finish_reason: finish, message }] }),
        );
      } catch (error) {
        fixtureErrors.push(error.message);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const config = {
      endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
      key: "controlled-local-only",
      model: "summary-http-fixture",
      maxOutputTokens: 393216,
      timeoutMs: 30000,
    };
    const harness = new DeepProofHarness({
      store,
      contextPolicy: { ...HARNESS_CONTEXT_POLICY, wireCharacters: 60000 },
    });
    try {
      const result = await harness.run({
        config,
        contract,
        inputs: [source],
        goal: "Controlled HTTP compaction fixture",
        maxCalls: 6,
      });
      assert.deepEqual(fixtureErrors, []);
      assert.equal(result.check.status, "verified");
      assert.equal(summaries, 1);
      assert.equal(main, 2);
      assert.equal(config.maxOutputTokens, 393216);
      const run = await store.getRun(result.record.harnessRunId);
      assert.equal(run.modelCalls, 3);
      const bundle = await store.bundle(run.root);
      assert(!JSON.stringify(bundle).includes("SYNTHETIC_PRIVATE_CONTEXT_"));
      await writeFile(
        path.join(dir, "result.json"),
        JSON.stringify(
          {
            root: run.root,
            main,
            summaries,
            verified: result.check.status,
            globalOutputBudget: config.maxOutputTokens,
          },
          null,
          2,
        ),
      );
    } finally {
      await writeFile(
        path.join(dir, "public-wire-bodies.json"),
        JSON.stringify(
          bodies.map((b) => ({
            ...b,
            messages: b.messages.map((m) => ({
              role: m.role,
              characters: JSON.stringify(m.content || "").length,
            })),
          })),
          null,
          2,
        ),
      );
      await writeFile(
        path.join(dir, "fixture-errors.json"),
        JSON.stringify(fixtureErrors),
      );
      await harness.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      console.log("Evidence:", dir);
    }
  },
);
