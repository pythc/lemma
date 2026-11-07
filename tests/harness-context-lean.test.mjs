import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DeepProofHarness } from "../server/deep-harness.mjs";
import { HARNESS_CONTEXT_POLICY } from "../server/harness-context.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";

test(
  "SDK compaction bounds actual wire history, accounts summaries and preserves native goals without exporting private reasoning",
  { timeout: 180000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-context-native-"));
    const store = new EvidenceStore(dir);
    await store.init();
    const source = await store.put("explicit_scripted_compaction_fixture", {
      text: "fixture",
    });
    const contract = createContract(
      {
        text: "fixture",
        artifact: source,
        paperSha256: sha256("fixture"),
        pageIndex: 0,
      },
      {
        label: "fixture",
        quote: "fixture",
        statement: "fixture",
        assumptions: [],
        leanTarget: "∀ n : Nat, n = n",
      },
    );
    const privateMarker = "PRIVATE_REASONING_MUST_NOT_BE_ARCHIVED";
    const privateText = privateMarker + "x".repeat(100000);
    let mainCalls = 0,
      summaries = 0;
    const harness = new DeepProofHarness({
      store,
      contextPolicy: { ...HARNESS_CONTEXT_POLICY, wireCharacters: 60000 },
      model: async (_config, request) => {
        assert(
          !JSON.stringify(request.messages).includes(privateMarker),
          "the private retained tail must be compacted locally before transport",
        );
        let message;
        if (request.role === "HARNESS_CONTEXT_SUMMARY") {
          summaries++;
          assert.deepEqual(request.thinking, { type: "disabled" });
          assert.equal(request.maxTokens, 4096);
          assert(!request.tools?.length);
          message = {
            content:
              "Controlled fixture: the pwd tool returned the workspace. No proof has been checked. Goal.lean and Task.json retain the exact goal. Next, supply the fixture proof and let Lean check it.",
          };
        } else if (++mainCalls === 1) {
          message = {
            content: "",
            reasoning_content: privateText,
            tool_calls: [
              {
                id: "pwd",
                function: {
                  name: "run_command",
                  arguments: JSON.stringify({ command: "pwd" }),
                },
              },
            ],
          };
        } else {
          assert(
            request.messages.some((m) =>
              /condensed summary|summary of the conversation/i.test(
                m.content || "",
              ),
            ),
          );
          message = {
            content: JSON.stringify({
              mode: "proof",
              route: "original",
              proof: "by intro n; rfl",
              explanation:
                "Explicit scripted execution fixture, not a paper benchmark",
            }),
          };
        }
        return {
          message,
          record: {
            scripted: true,
            role: request.role,
            request: { messages: request.messages },
            toolCalls: message.tool_calls || [],
            privateContextSha256: message.reasoning_content
              ? sha256(message.reasoning_content)
              : null,
          },
        };
      },
    });
    try {
      const result = await harness.run({
        config: { model: "scripted-compaction-only" },
        contract,
        inputs: [source],
        goal: "Explicit SDK compaction fixture",
        maxCalls: 6,
      });
      assert.equal(result.check.status, "verified");
      assert.equal(result.contract.targetHash, contract.targetHash);
      assert.equal(summaries, 1);
      const run = await store.getRun(result.record.harnessRunId);
      assert.equal(
        run.modelCalls,
        mainCalls + summaries,
        "local guards are not phantom external requests",
      );
      const report = await store.get(run.root);
      assert.equal(report.payload.contextManagement.summaries, 1);
      assert(report.payload.contextManagement.localGuards >= 1);
      const workspace = path.join(dir, "harness-workspaces", run.id);
      assert(
        (await readFile(path.join(workspace, "Goal.lean"), "utf8")).includes(
          contract.leanTarget,
        ),
      );
      assert.equal(
        JSON.parse(await readFile(path.join(workspace, "Task.json"), "utf8"))
          .contract.targetHash,
        contract.targetHash,
      );
      const historyDir = path.join(workspace, "conversation_history");
      const files = await readdir(historyDir);
      assert(files.length > 0);
      for (const file of files)
        assert(
          !(await readFile(path.join(historyDir, file), "utf8")).includes(
            privateMarker,
          ),
        );
      const bundle = await store.bundle(run.root);
      assert(!JSON.stringify(bundle).includes(privateMarker));
      assert(
        bundle.artifacts.some((a) => a.kind === "harness:context_summary"),
      );
    } finally {
      await harness.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
