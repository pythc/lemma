import { STRICT_AUDIT_BINDING_PROTOCOL } from "../server/strict-audit.mjs";
import {
  assertStrictRequest,
  strictBodyFixture,
} from "./strict-audit-fixture.mjs";
import { sourceAuditFixture } from "./source-audit-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm, mkdir, cp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createApp } from "../server/index.mjs";
import { sha256 } from "../server/evidence.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { ALIGNMENT_CATEGORIES } from "../server/semantics.mjs";

const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/verification-cases.json", import.meta.url),
    "utf8",
  ),
).cases[0];
const bytes = await readFile(
  new URL("../public/verification-fixtures.pdf", import.meta.url),
);
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

test(
  "archived v1 evidence remains recheckable without calling it the same runner environment",
  { timeout: 40000 },
  async () => {
    const bundle = JSON.parse(
      await readFile(
        new URL("../fixtures/legacy-v1-evidence.json", import.meta.url),
        "utf8",
      ),
    );
    const replay = await new ReviewPipeline({}).replay(
      bundle,
      "93728072be7bc6bef0b8ec61a739458d923ce5fecb8bfd45bae7a23d283b5994",
    );
    assert.equal(replay.revalidated, true);
    assert.equal(replay.conclusion.theorem, "formalized_proved");
    assert.equal(replay.sameEnvironment, false);
    assert.equal(replay.reproduced, false);
  },
);

for (const [semanticProtocol, auditBindingProtocol] of [
  ["lemma.source-audit.v4", undefined],
  ["lemma.source-audit.v4", "lemma.audit-envelope.v1"],
  ["lemma.source-audit.v5", "lemma.audit-envelope.v1"],
  ["lemma.source-audit.v8", STRICT_AUDIT_BINDING_PROTOCOL],
])
  test(
    `HTTP model fixture -> frozen approval -> real Lean -> export -> independent replay (${semanticProtocol}, ${auditBindingProtocol || "legacy"})`,
    { timeout: 180000 },
    async () => {
      const requests = [];
      const fakeModel = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const request = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(request);
        assert.equal(req.headers.authorization, "Bearer TEST_ONLY_SECRET");
        assert.equal(request.reasoning_effort, "high");
        // R03 is dispatched through DeepAgents; its instruction is in the
        // harness user task, while direct review stages use the system message.
        const system = request.messages
          .map((m) =>
            typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content),
          )
          .join("\n");
        const content = system.includes("R03")
          ? {
              label: fixture.label,
              quote: fixture.quote,
              statement: fixture.statement,
              assumptions: fixture.assumptions,
              leanTarget: fixture.leanTarget,
              ambiguity: "",
              alignment: ALIGNMENT_CATEGORIES.map((category) => ({
                category,
                explanation: "HTTP fixture only",
                leanFragment: fixture.leanTarget,
                anchors: [{ pageIndex: 0, quote: fixture.quote }],
              })),
            }
          : system.includes("R04") || system.includes("原文与固定形式目标")
            ? {
                ...([
                  "lemma.source-audit.v4",
                  "lemma.source-audit.v5",
                  "lemma.source-audit.v8",
                ].includes(
                  JSON.parse(request.messages[1].content).context
                    .semanticProtocol,
                )
                  ? { findings: [] }
                  : {}),
                ...(!auditBindingProtocol
                  ? {
                      targetHash: JSON.parse(request.messages[1].content)
                        .contract.targetHash,
                    }
                  : {}),
                ...(JSON.parse(request.messages[1].content).stage
                  ? {}
                  : {
                      sourceAudit: sourceAuditFixture(
                        JSON.parse(request.messages[1].content).contract,
                        JSON.parse(request.messages[1].content).targetStructure,
                        JSON.parse(request.messages[1].content).context
                          .semanticProtocol,
                      ),
                    }),
                backTranslation:
                  "Synthetic review of the authored arithmetic fixture.",
                checks: ALIGNMENT_CATEGORIES.map((category) => ({
                  category,
                  status: "aligned",
                  explanation: "Synthetic source alignment",
                  anchors: [{ pageIndex: 0, quote: fixture.quote }],
                })),
              }
            : system.includes("R06")
              ? {
                  status: "gap_candidate",
                  quote: fixture.quote,
                  explanation:
                    "HTTP fixture: this is only a candidate opinion, not a mathematical verdict.",
                }
              : {
                  mode: "proof",
                  proof: fixture.proof,
                  route: "independent",
                  explanation: "HTTP fixture proof proposal.",
                };
        res.writeHead(200, { "Content-Type": "application/json" });
        const preparation = request.tools?.find(
          (t) => t.function.name === "prepare_translation",
        );
        const strictSubmission = request.tools?.find(
          (t) => t.function.name === "submit_semantic_audit",
        );
        if (strictSubmission)
          assertStrictRequest(request, JSON.parse(request.messages[1].content));
        const submission =
          preparation ||
          strictSubmission ||
          request.tools?.find(
            (t) =>
              t.function.parameters?.properties?.alignment &&
              t.function.parameters?.properties?.leanTarget,
          );
        res.end(
          JSON.stringify({
            model: "fixture-http-not-a-real-model",
            thinking_effort: "extended",
            choices: [
              {
                finish_reason: submission ? "tool_calls" : "stop",
                message: submission
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: preparation
                            ? "prepare_replay_fixture"
                            : "submit_replay_fixture",
                          type: "function",
                          function: {
                            name: submission.function.name,
                            arguments: JSON.stringify(
                              preparation
                                ? { candidate: content }
                                : strictSubmission
                                  ? strictBodyFixture(
                                      content,
                                      !!JSON.parse(request.messages[1].content)
                                        .stage,
                                    )
                                  : content,
                            ),
                          },
                        },
                      ],
                    }
                  : { content: JSON.stringify(content) },
              },
            ],
            usage: { total_tokens: 1 },
          }),
        );
      });
      const folder = await mkdtemp(
        path.join(os.tmpdir(), "lemma-replay-test-"),
      );
      await listen(fakeModel);
      const { server, pipeline } = await createApp({
        // This control measures independent-proof transport only. Source-route
        // extraction/HTTP/replay has its own real Lean acceptance suite.
        originalProofOptions: { enabled: false },
        dataRoot: folder,
        provingOptions: { budget: { maxModelCalls: 0 } },
        configProvider: async () => ({
          endpoint: `http://127.0.0.1:${fakeModel.address().port}/v1/chat/completions`,
          model: "fixture-http-not-a-real-model",
          key: "TEST_ONLY_SECRET",
          reasoningEffort: "high",
          auditBindingProtocol,
          semanticProtocol,
        }),
      });
      await listen(server);
      const base = `http://127.0.0.1:${server.address().port}`;
      const call = async (endpoint, body) => {
        const response = await fetch(
          base + endpoint,
          body
            ? {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              }
            : {},
        );
        const result = await response.json();
        assert.ok(response.ok, JSON.stringify(result));
        return result;
      };
      const waitFor = async (id, stage) => {
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          const run = await call(`/api/reviews/${id}`);
          if (run.status === stage && !pipeline.active.has(id)) return run;
          if (run.status === "blocked" && stage !== "blocked")
            assert.fail(run.error);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("HTTP review did not reach its target stage");
      };
      try {
        const first = await call("/api/reviews", {
          mode: "model",
          pdfBase64: bytes.toString("base64"),
          paperSha256: sha256(bytes),
          pageIndex: 0,
        });
        const draft = await waitFor(first.id, "awaiting_confirmation");
        assert.equal(
          requests.length,
          4,
          "No proof model may run before semantic approval",
        );
        await call(`/api/reviews/${first.id}/approve`, {
          confirmed: true,
          targetHash: draft.contract.targetHash,
          semanticArtifact: draft.semanticArtifact,
          resolutions: draft.semanticReview.issues.map((i) => ({
            issueId: i.id,
            decision: "confirmed_with_reason",
            reason:
              "HTTP fixture attestation of the explicit arithmetic source and target.",
          })),
        });
        // A proof-only fixture must not claim the omitted author-route is closed.
        const final = await waitFor(first.id, "blocked");
        assert.equal(final.conclusion.reviewComplete, false);
        assert(
          final.conclusion.unresolved.some((o) => o.kind === "author_route"),
        );
        assert.equal(
          final.conclusion.theorem,
          "formalized_proved",
          JSON.stringify({
            check: final.check,
            search: final.provingSearch,
            tasks: final.tasks.map((t) => ({
              title: t.title,
              status: t.status,
              error: t.error,
            })),
          }),
        );
        assert.equal(final.conclusion.originalProof, "gap_candidate");
        assert.equal(
          requests.length,
          5,
          "Lean search can solve this fixture without proof generation",
        );
        assert.equal(final.provingSearch.stopReason, "verified");
        assert.ok(final.tasks.some((t) => t.type === "proof_search"));
        for (const request of requests.slice(2))
          assert.equal(
            JSON.parse(request.messages[1].content).contract.targetHash,
            draft.contract.targetHash,
          );
        const bundle = await call(`/api/reviews/${first.id}/bundle`);
        assert.ok(!JSON.stringify(bundle).includes("TEST_ONLY_SECRET"));
        assert.deepEqual(
          requests[0].tools.map((t) => t.function.name),
          ["prepare_translation"],
        );
        assert.equal(requests[0].tool_choice, "required");
        assert.equal(requests[1].tools.length, 2);
        assert(
          bundle.artifacts.some(
            (a) => a.kind === "harness:translation_submission",
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
        const modelRecords = bundle.artifacts
          .map((a) =>
            a.kind === "harness:model" ? a.payload : a.payload.model,
          )
          .filter(Boolean);
        const transportRecords = modelRecords.filter(
          (m) => m.request?.messages,
        );
        assert.equal(transportRecords.length, 5);
        assert.equal(
          modelRecords.filter((m) => m.source === "deepagents-js").length,
          1,
        );
        assert.ok(
          transportRecords.every(
            (m) =>
              m.request.reasoning_effort === "high" &&
              m.responseThinkingEffort === "extended",
          ),
        );
        const sourceSummary = await call(
          `/api/artifacts/${final.sourceArtifact}?view=summary`,
        );
        assert.ok(!sourceSummary.preview.pdfBase64.startsWith("JVBER"));
        const replay = await pipeline.replay(bundle, final.root);
        assert.equal(replay.reproduced, true, JSON.stringify(replay));
        assert.equal(replay.conclusion.theorem, "formalized_proved");
        assert.equal(
          requests.length,
          5,
          "Replay must not re-request the model",
        );
        const tampered = structuredClone(bundle);
        tampered.artifacts[0].payload.text += "alteration";
        await assert.rejects(pipeline.replay(tampered, final.root), /修改/);
        const history = await call(`/api/reviews?paper=${sha256(bytes)}`);
        assert.equal(history.total, 1);
      } finally {
        await close(server);
        await close(fakeModel);
        if (process.env.LEMMA_TEST_EVIDENCE_DIR) {
          const out = path.join(
            process.env.LEMMA_TEST_EVIDENCE_DIR,
            path.basename(folder),
          );
          await mkdir(process.env.LEMMA_TEST_EVIDENCE_DIR, { recursive: true });
          await cp(folder, out, {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
          await writeFile(
            path.join(out, "wire-requests.json"),
            JSON.stringify(requests, null, 2),
            { flag: "wx" },
          );
        }
        await rm(folder, { recursive: true, force: true });
      }
    },
  );
