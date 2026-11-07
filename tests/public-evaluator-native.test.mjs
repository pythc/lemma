import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  writeFile,
  readdir,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { STRICT_AUDIT_BINDING_PROTOCOL } from "../server/strict-audit.mjs";
import { ANCHORED_AUDIT_PROTOCOL } from "../server/audit-wire.mjs";
import { ALIGNMENT_CATEGORIES } from "../server/semantics.mjs";
import { sourceAuditFixture } from "./source-audit-fixture.mjs";
import {
  strictBodyFixture,
  strictMessageFixture,
} from "./strict-audit-fixture.mjs";

async function filesBelow(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}
async function cli(args, env, log) {
  const fd = await open(log, "wx");
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        env: { ...process.env, ...env },
        stdio: ["ignore", fd.fd, fd.fd],
      });
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, `CLI failed; preserved log: ${log}`);
  } finally {
    await fd.close();
  }
}
for (const kind of ["semantic", "translation"])
  test(
    `actual ${kind} evaluator CLI keeps success/failure/SQLite archives public`,
    { timeout: 240000 },
    async () => {
      const root = path.resolve(
        process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/public-evaluator",
      );
      await mkdir(root, { recursive: true });
      const dir = await mkdtemp(path.join(root, `public-${kind}-`));
      const marker = "synthetic_actual_cli_private_marker_never_a_real_secret";
      const ledger = path.join(dir, "ledger");
      await mkdir(ledger);
      await writeFile(
        path.join(ledger, "ledger.json"),
        JSON.stringify({
          maxCalls: 8,
          caps: { semanticDev: 8, translationDev: 8 },
          entries: [],
        }),
      );
      let calls = 0,
        secondUsedPrivateContext = false,
        handlerFailure = null;
      const server = createServer(async (req, res) => {
        try {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const request = JSON.parse(raw);
          calls++;
          if (kind === "translation" && calls === 2)
            secondUsedPrivateContext = request.messages.some(
              (m) => m.reasoning_content === marker,
            );
          if (calls >= (kind === "semantic" ? 3 : 2)) {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: { code: "controlled_unavailable", thinking: marker },
                recovery: { access_token: marker },
              }),
            );
            return;
          }
          let message;
          if (kind === "semantic") {
            const input = JSON.parse(request.messages[1].content);
            const quote = input.contract.quote;
            const comparison = !!input.stage;
            message = strictMessageFixture(
              strictBodyFixture(
                {
                  backTranslation: quote,
                  findings: [],
                  checks: ALIGNMENT_CATEGORIES.map((category) => ({
                    category,
                    status: "aligned",
                    explanation: "Scripted privacy plumbing only",
                    anchors: [{ pageIndex: input.contract.pageIndex, quote }],
                  })),
                  ...(!comparison
                    ? {
                        sourceAudit: sourceAuditFixture(
                          input.contract,
                          input.targetStructure,
                          ANCHORED_AUDIT_PROTOCOL,
                        ),
                      }
                    : {}),
                },
                comparison,
              ),
            );
          } else {
            assert(
              request.tools.some(
                (t) => t.function.name === "prepare_translation",
              ),
            );
            const quote = "For all natural numbers a and b, a * b = b * a.";
            const candidate = {
              label: "controlled",
              quote,
              statement: quote,
              assumptions: [],
              leanTarget: "∀ a b : Nat, a * b = b * a",
              ambiguity: "",
              alignment: ALIGNMENT_CATEGORIES.map((category) => ({
                category,
                explanation: "Scripted privacy plumbing only",
                leanFragment: "a * b = b * a",
                anchors: [{ pageIndex: 0, quote }],
              })),
            };
            message = {
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
            };
          }
          Object.assign(message, {
            reasoning_content: marker,
            reasoning_details: { trace: marker },
            analysis: marker,
            thinking: marker,
            chain_of_thought: marker,
          });
          const response = {
            choices: [{ index: 0, finish_reason: "tool_calls", message }],
            recovery: { thinking: marker, access_token: marker },
            lifecycle: { chain_of_thought: marker },
            gateway_budget: { opaque: { secret: marker }, generation_posts: 1 },
          };
          if (kind === "semantic" && calls === 2)
            response.access_token = marker;
          res.end(JSON.stringify(response));
        } catch (error) {
          handlerFailure = error;
          res.writeHead(500);
          res.end('{"error":"controlled_handler_failure"}');
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const endpoint = `http://127.0.0.1:${server.address().port}`;
      const env = {
        LEMMA_MODEL_LOCAL_ONLY: "1",
        LEMMA_MODEL_BASE_URL: endpoint + "/v1",
        LEMMA_MODEL: "controlled-public-archive",
        LEMMA_MODEL_API_KEY: "local-fixture-key",
        LEMMA_SEMANTIC_MODEL_BASE_URL: endpoint + "/v1",
        LEMMA_SEMANTIC_MODEL: "controlled-public-archive",
        LEMMA_SEMANTIC_MODEL_API_KEY: "local-fixture-key",
        LEMMA_AUDIT_BINDING_PROTOCOL: STRICT_AUDIT_BINDING_PROTOCOL,
        LEMMA_STRICT_AUDIT_ENDPOINT: endpoint + "/beta/chat/completions",
        LEMMA_EXPERIMENT_LEDGER: ledger,
        LEMMA_EXPERIMENT_COHORT:
          kind === "semantic" ? "semanticDev" : "translationDev",
      };
      const out = path.join(dir, "evaluation");
      try {
        if (kind === "semantic") {
          const dataset = "evaluation/sets/eighth-semantic-development";
          const prepared = path.join(dir, "prepared");
          await cli(
            [
              "scripts/evaluate-product-semantics.mjs",
              dir,
              prepared,
              dataset,
              "prepare-development",
            ],
            env,
            path.join(dir, "prepare.log"),
          );
          await cli(
            [
              "scripts/evaluate-product-semantics.mjs",
              dir,
              out,
              dataset,
              "development",
              path.join(prepared, "registration.json"),
            ],
            env,
            path.join(dir, "run.log"),
          );
          assert.equal(calls, 3);
          const valid = JSON.parse(
            await readFile(path.join(out, "call-1.json"), "utf8"),
          );
          assert(valid.record.strictResponse);
          const invalid = JSON.parse(
            await readFile(path.join(out, "call-2-failed.json"), "utf8"),
          );
          assert.equal(
            invalid.record.error.code,
            "model_invalid_strict_response",
          );
        } else {
          await cli(
            [
              "scripts/evaluate-translation-development.mjs",
              dir,
              out,
              "evaluation/sets/seventh-translation-development/inputs.json",
            ],
            env,
            path.join(dir, "run.log"),
          );
          assert.equal(calls, 2);
          assert(secondUsedPrivateContext);
          assert(
            JSON.parse(await readFile(path.join(out, "D1/call-1.json"), "utf8"))
              .record.toolCalls.length,
          );
          assert(
            JSON.parse(
              await readFile(path.join(out, "D1/call-2-failure.json"), "utf8"),
            ).record.error,
          );
        }
        assert.equal(handlerFailure, null);
        const files = await filesBelow(dir);
        for (const file of files)
          assert(
            !(await readFile(file)).includes(Buffer.from(marker)),
            `Private synthetic marker archived: ${file}`,
          );
        assert.equal(
          JSON.parse(await readFile(path.join(ledger, "ledger.json"), "utf8"))
            .entries.length,
          calls,
        );
        await writeFile(
          path.join(dir, "privacy-result.json"),
          JSON.stringify(
            {
              classification:
                "actual_evaluator_CLI_public_archives_not_model_quality",
              kind,
              passed: true,
              localHTTPRequests: calls,
              externalModelCalls: 0,
              scannedFiles: files.length,
              successAndFailureCallsChecked: true,
              secondUsedPrivateContext:
                kind === "translation" ? secondUsedPrivateContext : null,
              privateMarkerArchived: false,
              stop: "deliberate_local_503",
            },
            null,
            2,
          ),
          { flag: "wx" },
        );
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );
