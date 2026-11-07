import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createDeepAgent } from "deepagents";
import { toolStrategy } from "langchain";
import { HarnessChatModel } from "../server/harness-model.mjs";
import { translationPhaseMiddleware } from "../server/translation-phase.mjs";
import { reviewModelTransport } from "../server/review-transport.mjs";
import { callModel } from "../server/model.mjs";
import { EvidenceStore, digest } from "../server/evidence.mjs";
import { executionContext } from "../server/execution-context.mjs";
import { createContract } from "../server/contracts.mjs";
import { inspectTarget } from "../server/lean-query.mjs";

test(
  "time-limited full-paper translation sends a real SDK submission before the unchanged reserve",
  { timeout: 180000 },
  async () => {
    const base = path.resolve(
      process.env.LEMMA_TEST_EVIDENCE_DIR ||
        "evidence/seventh-continuation-20261022",
    );
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(path.join(base, "controlled-phase-"));
    const store = new EvidenceStore(path.join(dir, "store"));
    await store.init();
    const parent = {
      id: randomUUID(),
      orchestrationVersion: 2,
      status: "running",
      tasks: [],
      createdAt: new Date(Date.now() - 50000).toISOString(),
      modelCalls: 6,
      limits: { maxModelCalls: 12, maxRunMs: 240000 },
    };
    await store.saveRun(parent);
    const owner = {
      run: { id: randomUUID(), parentReviewId: parent.id },
      task: { id: randomUUID(), role: "R03" },
    };
    const wire = [];
    const server = createServer(async (req, res) => {
      try {
        let bytes = "";
        for await (const chunk of req) bytes += chunk;
        const body = JSON.parse(bytes);
        wire.push(body);
        assert.equal(body.tool_choice, "required");
        assert.equal(body.thinking.type, "disabled");
        assert.equal(body.tools.length, 2);
        const submit = body.tools.find(
          (t) => t.function.parameters.properties?.target,
        );
        assert(submit);
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
                      id: "controlled_submission",
                      type: "function",
                      function: {
                        name: submit.function.name,
                        arguments: JSON.stringify({
                          target: "∀ x : Nat, x = x",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.stack }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const model = new HarnessChatModel({
      config: {
        endpoint: `http://127.0.0.1:${server.address().port}`,
        model: "controlled-fixture-not-external-model",
        key: "fixture-only",
        timeoutMs: 10000,
      },
      invoke: reviewModelTransport({
        model: callModel,
        store,
        getReview: (id) => store.getRun(id),
        saveReview: (r) => store.saveRun(r),
      }),
    });
    try {
      const responseFormat = toolStrategy(
        [
          z.strictObject({ target: z.string() }),
          z.strictObject({ unable: z.string() }),
        ],
        { handleError: false },
      );
      const agent = createDeepAgent({
        model,
        tools: [],
        responseFormat,
        middleware: [
          translationPhaseMiddleware({
            owner,
            store,
            run: { modelCalls: 0 },
            maxCalls: 20,
            submissionNames: responseFormat.map((s) => s.tool.function.name),
          }),
        ],
      });
      const result = await executionContext.run(owner, () =>
        agent.invoke({
          messages: [
            {
              role: "user",
              content: "Controlled SDK submission fixture only.",
            },
          ],
        }),
      );
      assert.equal(wire.length, 1);
      assert.equal(result.structuredResponse.target, "∀ x : Nat, x = x");
      const saved = await store.getRun(parent.id),
        entry = saved.modelBudget.entries[0];
      assert.equal(saved.modelCalls, 7);
      assert.equal(entry.protectedCalls, 4);
      assert.equal(entry.protectedMs, 170000);
      assert.equal(
        entry.phaseDecision.reason,
        "exploration_would_spend_submission_time",
      );
      assert.equal(entry.phaseDecision.remaining.remainingCalls, 6);
      const text = "Every natural number equals itself.";
      const contract = createContract(
        {
          text,
          pageIndex: 0,
          paperSha256: digest(text),
          artifact: digest("controlled-source"),
        },
        {
          label: "controlled",
          quote: text,
          statement: text,
          assumptions: [],
          leanTarget: result.structuredResponse.target,
        },
        "std-v1",
      );
      const native = await inspectTarget(contract);
      assert.equal(native.status, "well_typed");
      await writeFile(
        path.join(dir, "result.json"),
        JSON.stringify(
          {
            scope:
              "controlled HTTP/SDK/native plumbing only; no model accuracy or complete review acceptance",
            wire,
            budget: saved,
            contract,
            native,
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
    } catch (error) {
      await writeFile(
        path.join(dir, "failure.json"),
        JSON.stringify(
          { error: error.stack, wire, budget: await store.getRun(parent.id) },
          null,
          2,
        ),
        { flag: "wx" },
      );
      throw error;
    } finally {
      await model.closeAndDrain();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
