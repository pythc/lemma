import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ReviewPipeline } from "../server/pipeline.mjs";
import {
  EvidenceStore,
  digest,
  inspectBundle,
  sha256,
} from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";
import {
  ANCHORED_AUDIT_PROTOCOL as protocol,
  INDEXED_ANCHOR_V2,
} from "../server/audit-wire.mjs";
import {
  STRICT_AUDIT_BINDING_PROTOCOL as bindingProtocol,
  rawStrictAudit,
} from "../server/strict-audit.mjs";
import { verifyAuditEnvelope } from "../server/audit-envelope.mjs";
import { validateStructuredAttempts } from "../server/structured-review.mjs";
import { ALIGNMENT_CATEGORIES } from "../server/semantics.mjs";
import { sourceAuditFixture } from "./source-audit-fixture.mjs";
import {
  strictBodyFixture,
  strictMessageFixture,
  assertStrictRequest,
} from "./strict-audit-fixture.mjs";

const cases = [
  ["provider_index", "blind", "allowed"],
  ["provider_index", "comparison", "allowed"],
  ["provider_index_warning", "blind", "blocked"],
  ["provider_index_warning", "comparison", "blocked"],
  ["provider_index_wrong", "blind", "rejected"],
  ["private_metadata", "blind", "allowed"],
  ["credential_metadata", "blind", "allowed"],
  ["private_details", "blind", "allowed"],
  ["valid", "blind", "allowed"],
  ["empty_string", "blind", "allowed"],
  ["private_reasoning", "blind", "allowed"],
  ["warning", "blind", "blocked"],
  ["warning", "comparison", "blocked"],
];
for (const name of [
  "duplicate_root",
  "duplicate_nested",
  "escaped_root",
  "escaped_nested",
  "text_array",
  "content_object",
  "content_number",
  "missing_content",
  "missing_role",
  "two_choices",
  "duplicate_envelope",
  "duplicate_message",
  "private_channel",
  "invalid_sensitive_top",
  "invalid_unknown_top",
  "wide_usage",
  "typed_private_content",
])
  cases.push([name, "blind", "rejected"]);
for (const name of [
  "duplicate_root",
  "duplicate_nested",
  "escaped_root",
  "text_array",
  "two_choices",
])
  cases.push([name, "comparison", "rejected"]);
for (const [name, badStage, expectation] of cases)
  test(
    `strict receiving actual HTTP/Lean product admission ${name}/${badStage}`,
    { timeout: 120000 },
    async () => {
      const base = path.resolve(
        process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/receiving-native",
      );
      await mkdir(base, { recursive: true });
      const dir = await mkdtemp(path.join(base, "receive-"));
      const store = new EvidenceStore(path.join(dir, "store"));
      await store.init();
      const quote = "Every natural number equals itself.",
        anchor = { pageIndex: 0, quote };
      const contract = createContract(
        {
          text: quote,
          pageIndex: 0,
          paperSha256: digest(quote),
          artifact: digest("generic-receiving-fixture"),
        },
        {
          label: "controlled transport boundary",
          quote,
          statement: quote,
          assumptions: [],
          leanTarget: "∀ n : Nat, n = n",
        },
        "std-v1",
      );
      const context = {
        paperSha256: contract.paperSha256,
        selectedPage: 0,
        pages: [{ pageIndex: 0, text: quote }],
        supplements: [],
        omittedPages: [],
        semanticProtocol: protocol,
        anchorProtocol: INDEXED_ANCHOR_V2,
        auditBindingProtocol: bindingProtocol,
      };
      const outgoing = [],
        responseHashes = [];
      const privateText = "controlled-private-response-must-not-be-archived";
      const server = createServer(async (req, res) => {
        try {
          let text = "";
          for await (const c of req) text += c;
          const wire = JSON.parse(text);
          outgoing.push(wire);
          const input = JSON.parse(wire.messages[1].content);
          assertStrictRequest(wire, input);
          const stage = input.stage ? "comparison" : "blind",
            mutate = stage === badStage;
          const warning = {
            kind: "structural_correspondence_unresolved",
            category: "quantifiers",
            anchors: [anchor],
            targetFragment: contract.leanTarget,
            missingSymbols: [],
            independentOfMissing: false,
            basis: "Controlled source correspondence doubt must survive",
            changeWitness: null,
          };
          const canonical = {
            backTranslation: quote,
            findings:
              mutate && ["warning", "provider_index_warning"].includes(name)
                ? [warning]
                : [],
            checks: ALIGNMENT_CATEGORIES.map((category) => ({
              category,
              status: "aligned",
              explanation: "Controlled wire boundary, not model accuracy",
              anchors: [anchor],
            })),
            ...(!input.stage
              ? {
                  sourceAudit: sourceAuditFixture(
                    input.contract,
                    input.targetStructure,
                    protocol,
                  ),
                }
              : {}),
          };
          const message = strictMessageFixture(
            strictBodyFixture(canonical, !!input.stage),
          );
          let response = {
            choices: [{ index: 0, finish_reason: "tool_calls", message }],
          };
          if (mutate) {
            if (name.startsWith("provider_index"))
              message.tool_calls[0].index =
                name === "provider_index_wrong" ? 1 : 0;
            if (name === "duplicate_root" || name === "escaped_root")
              message.tool_calls[0].function.arguments =
                '{"' +
                (name === "escaped_root" ? "find\\u0069ngs" : "findings") +
                '":' +
                JSON.stringify([{ ...warning, changeWitness: [] }]) +
                "," +
                message.tool_calls[0].function.arguments.slice(1);
            if (name === "duplicate_nested" || name === "escaped_nested")
              message.tool_calls[0].function.arguments =
                message.tool_calls[0].function.arguments.replace(
                  '"status":"aligned"',
                  '"' +
                    (name === "escaped_nested" ? "sta\\u0074us" : "status") +
                    '":"concern","status":"aligned"',
                );
            if (name === "text_array")
              message.content = [
                {
                  type: "text",
                  text: "Conflicting public doubt; green tool is unsupported.",
                },
              ];
            if (name === "content_object")
              message.content = { text: "Conflicting public doubt" };
            if (name === "content_number") message.content = 1;
            if (name === "missing_content") delete message.content;
            if (name === "missing_role") delete message.role;
            if (name === "two_choices")
              response.choices.push({
                index: 1,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "Conflicting second public answer",
                  reasoning_content: privateText,
                },
              });
            if (name === "private_metadata") {
              response.recovery = {
                thinking: privateText,
                nested: { analysis: privateText },
              };
              response.lifecycle = { chain_of_thought: privateText };
            }
            if (name === "credential_metadata")
              response.recovery = {
                access_token: privateText,
                api_key: privateText,
                nested: { Authorization: privateText },
                unknown: privateText,
              };
            if (name === "private_details")
              Object.assign(message, {
                reasoning_details: privateText,
                analysis: privateText,
                thinking: privateText,
              });
            if (name === "invalid_sensitive_top")
              response.access_token = privateText;
            if (name === "invalid_unknown_top")
              response.unknown_metadata = { secret: privateText };
            if (name === "wide_usage") response.usage = Array(200000).fill(0);
            if (name === "typed_private_content")
              message.content = [{ type: "reasoning", text: privateText }];
            if (name === "empty_string") message.content = "";
            if (name === "private_reasoning")
              message.reasoning_content = privateText;
            if (name === "private_channel") {
              message.channel = "analysis";
              message.content = privateText;
            }
          }
          let raw = JSON.stringify(response);
          if (mutate && name === "duplicate_envelope")
            raw =
              '{"choices":[{"message":{"content":"Conflicting public answer"}}],' +
              raw.slice(1);
          if (mutate && name === "duplicate_message")
            raw = raw.replace(
              '"message":',
              '"message":{"role":"assistant","content":"Conflicting earlier public answer"},"message":',
            );
          responseHashes.push(sha256(raw));
          res.setHeader("Content-Type", "application/json");
          res.end(raw);
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error.stack }));
        }
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const config = {
        endpoint: `http://127.0.0.1:${server.address().port}`,
        model: "controlled-local-receiving",
        key: "local-receive-key-no-vendor",
        timeoutMs: 10000,
        auditBindingProtocol: bindingProtocol,
      };
      const pipeline = new ReviewPipeline({
        store,
        getConfig: async () => config,
        getSemanticConfig: async () => config,
      });
      const run = {
        id: randomUUID(),
        mode: "model",
        status: "preparing",
        paperSha256: contract.paperSha256,
        contract,
        context,
        tasks: [],
      };
      run.contractArtifact = await store.put("task:R05", contract);
      run.contextArtifact = await store.put("task:R02C", context);
      const proposal = {
        proposal: {
          alignment: ALIGNMENT_CATEGORIES.map((category) => ({
            category,
            explanation: "Controlled translation",
            leanFragment: contract.leanTarget,
            anchors: [anchor],
          })),
        },
      };
      run.translationArtifact = await store.put("task:R03", proposal, [
        run.contractArtifact,
      ]);
      let failure = null,
        passed = false;
      try {
        if (expectation === "rejected") {
          await assert.rejects(
            pipeline.reviewTranslation(
              run,
              proposal,
              config,
              new AbortController(),
            ),
            (error) => {
              failure = error;
              assert.equal(error.structuredAttempts.length, 1);
              assert(error.modelRecord.strictResponse);
              return true;
            },
          );
          assert.equal(outgoing.length, badStage === "blind" ? 1 : 2);
          assert.equal(run.semanticReview, undefined);
          const task = run.tasks.find(
            (t) => t.role === (badStage === "blind" ? "R04B" : "R04"),
          );
          assert.equal(task.status, "blocked");
          if (badStage === "blind")
            assert.equal(
              run.tasks.some((t) => t.role === "R04"),
              false,
            );
          const receipt = failure.modelRecord.strictResponse;
          if (name === "wide_usage") {
            assert.equal(
              receipt.retentionScope,
              "digest_only_processing_failure",
            );
            assert.equal(
              failure.modelRecord.error.code,
              "model_response_structure_limit",
            );
            assert.equal(
              failure.modelRecord.error.delivery.outcome,
              "received",
            );
            assert.equal(
              failure.modelRecord.http.bodySha256,
              responseHashes.at(-1),
            );
            assert(failure.modelRecord.requestId);
          } else assert(receipt.publicJson);
          if (
            [
              "duplicate_root",
              "escaped_root",
              "duplicate_nested",
              "escaped_nested",
            ].includes(name)
          )
            assert(
              receipt.publicJson.includes("concern") ||
                receipt.publicJson.includes("correspondence doubt"),
            );
          if (name === "text_array" || name === "two_choices")
            assert(receipt.publicJson.includes("Conflicting"));
          assert(!JSON.stringify(failure.modelRecord).includes(privateText));
        } else {
          await pipeline.reviewTranslation(
            run,
            proposal,
            config,
            new AbortController(),
          );
          assert.equal(outgoing.length, 2);
          assert.equal(run.semanticReview.adjudication.admission, expectation);
          const blind = (
            await store.get(run.tasks.find((t) => t.role === "R04B").output)
          ).payload;
          validateStructuredAttempts(
            blind.structuredAttempts,
            blind.input,
            blind.response,
            blind.model,
          );
          rawStrictAudit(blind.model);
          for (const mutate of [
            (r) => (r.strictResponse.publicJson += " "),
            (r) => (r.strictResponse.originalBodySha256 = "a".repeat(64)),
            (r) =>
              r.strictResponse.privateFields.push({ sha256: "b".repeat(64) }),
          ]) {
            const record = structuredClone(blind.model);
            mutate(record);
            assert.throws(() =>
              verifyAuditEnvelope(blind.response, record, blind.input),
            );
          }
          const erased = structuredClone(blind.model);
          delete erased.strictResponse;
          assert.throws(() => rawStrictAudit(erased), /receipt/);
        }
        assert.equal(run.nativeTargetCheck.status, "well_typed");
        const root = await store.put(
          "controlled:strict-receiving",
          {
            classification:
              "actual_HTTP_native_target_semantic_admission_not_theorem_proof",
            name,
            badStage,
            expectation,
            run,
          },
          run.tasks.map((t) => t.output).filter(Boolean),
        );
        const bundle = await store.bundle(root);
        inspectBundle(bundle, root);
        assert(!JSON.stringify(bundle).includes(privateText));
        await writeFile(path.join(dir, "bundle.json"), JSON.stringify(bundle), {
          flag: "wx",
        });
        passed = true;
      } finally {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
        await writeFile(
          path.join(dir, "result.json"),
          JSON.stringify(
            {
              name,
              badStage,
              expectation,
              passed,
              calls: outgoing.length,
              native: run.nativeTargetCheck?.status,
              admission:
                run.semanticReview?.adjudication?.admission || "not_granted",
              error: failure?.message || null,
              outgoing,
              responseHashes,
              run,
            },
            null,
            2,
          ),
          { flag: "wx" },
        );
      }
    },
  );
