import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  StateGraph,
  MessagesAnnotation,
  START,
  END,
} from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { HarnessChatModel } from "../server/harness-model.mjs";
import { EvidenceStore, inspectBundle } from "../server/evidence.mjs";

for (const mode of ["field", "typed", "invalid-id"])
  test(`actual HTTP/SDK ${mode} continuation stays out of SQLite and bundle`, async () => {
    const marker = "synthetic_sdk_private_context_not_real_reasoning";
    const base = path.resolve(
      process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/public-sdk",
    );
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(path.join(base, "sdk-privacy-"));
    const store = new EvidenceStore(path.join(dir, "store"));
    await store.init();
    const records = [];
    let calls = 0,
      secondUsedPrivateContext = false;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const request = JSON.parse(raw);
      calls++;
      if (calls === 2)
        secondUsedPrivateContext = request.messages.some((m) =>
          mode === "field"
            ? m.reasoning_content === marker
            : Array.isArray(m.content) &&
              m.content.some(
                (b) => b.type === "reasoning" && b.text === marker,
              ),
        );
      const message = {
        role: "assistant",
        content:
          calls === 1
            ? mode === "typed"
              ? [
                  { type: "reasoning", text: marker },
                  { type: "text", text: "Public preface" },
                ]
              : null
            : "Public final response",
        ...(mode === "field" ? { reasoning_content: marker } : {}),
        reasoning_details: { trace: marker },
        analysis: marker,
      };
      if (calls === 1)
        message.tool_calls = [
          {
            id: mode === "invalid-id" ? { access_token: marker } : "probe-1",
            type: "function",
            function: {
              name: "probe",
              arguments: "{}",
              [marker]: "opaque metadata",
            },
          },
        ];
      res.end(
        JSON.stringify({
          choices: [
            { finish_reason: calls === 1 ? "tool_calls" : "stop", message },
          ],
          recovery: { thinking: marker, access_token: marker },
        }),
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const config = {
      endpoint: `http://127.0.0.1:${server.address().port}`,
      model: "local-sdk-privacy",
      key: "dummy-sdk-key",
      timeoutMs: 5000,
    };
    const bot = new HarnessChatModel({
      config,
      onRecord: async (r) => {
        records.push(await store.put("harness:model", r));
      },
    });
    const tool = {
      type: "function",
      function: {
        name: "probe",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    };
    const model = bot.bindTools([tool]);
    const saver = SqliteSaver.fromConnString(
      path.join(dir, "checkpoints.sqlite"),
    );
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("ask", async (state) => ({
        messages: [await model.invoke(state.messages)],
      }))
      .addEdge(START, "ask")
      .addEdge("ask", END)
      .compile({ checkpointer: saver });
    const options = {
      configurable: { thread_id: "controlled-memory-context" },
    };
    let passed = false;
    try {
      if (mode === "invalid-id") {
        await assert.rejects(
          graph.invoke(
            { messages: [new HumanMessage("Use the public probe tool")] },
            options,
          ),
          (error) => {
            assert.equal(error.modelRecord.error.code, "model_invalid_tools");
            assert(!JSON.stringify(error.modelRecord).includes(marker));
            return true;
          },
        );
        assert.equal(calls, 1);
        const failedState = await graph.getState(options);
        assert(!JSON.stringify(failedState).includes(marker));
      } else {
        await graph.invoke(
          { messages: [new HumanMessage("Use the public probe tool")] },
          options,
        );
        await graph.invoke(
          {
            messages: [
              new ToolMessage({
                content: "Public tool receipt",
                tool_call_id: "probe-1",
              }),
            ],
          },
          options,
        );
        assert.equal(calls, 2);
        assert(secondUsedPrivateContext);
        const state = await graph.getState(options);
        assert(!JSON.stringify(state.values).includes(marker));
        const restarted = new HarnessChatModel({ config });
        await assert.rejects(
          restarted.invoke(state.values.messages),
          /Private provider context is unavailable/,
        );
        await restarted.closeAndDrain();
        assert.equal(calls, 2);
      }
      const root = await store.put(
        "controlled:public-sdk",
        {
          calls,
          secondUsedPrivateContext,
          scope: "SDK_public_checkpoint_not_math_quality",
        },
        records,
      );
      const bundle = await store.bundle(root);
      inspectBundle(bundle, root);
      assert(!JSON.stringify(bundle).includes(marker));
      await writeFile(path.join(dir, "bundle.json"), JSON.stringify(bundle), {
        flag: "wx",
      });
      passed = true;
    } finally {
      await bot.closeAndDrain();
      saver.db.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    for (const name of await readdir(dir))
      if (name.startsWith("checkpoints.sqlite"))
        assert(
          !(await readFile(path.join(dir, name))).includes(Buffer.from(marker)),
          "SQLite checkpoint contains private context",
        );
    await writeFile(
      path.join(dir, "result.json"),
      JSON.stringify(
        {
          classification: "actual_HTTP_SDK_SQLite_public_archive_check",
          passed,
          calls,
          secondUsedPrivateContext,
          restartStoppedBeforeDispatch: mode === "invalid-id" ? null : true,
          malformedToolIdRejected: mode === "invalid-id",
          privateMarkerArchived: false,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
  });
