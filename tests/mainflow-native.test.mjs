import { STRICT_AUDIT_BINDING_PROTOCOL as AUDIT_BINDING_PROTOCOL } from "../server/strict-audit.mjs";
import {
  assertStrictRequest,
  strictBodyFixture,
  strictMessageFixture,
} from "./strict-audit-fixture.mjs";
import {
  sourceAuditFixture,
  auditBodyFixture,
} from "./source-audit-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createApp } from "../server/index.mjs";
import { sha256, inspectBundle } from "../server/evidence.mjs";
import { ALIGNMENT_CATEGORIES } from "../server/semantics.mjs";
import { inspectTarget } from "../server/lean-query.mjs";
import { createContract } from "../server/contracts.mjs";
import { selectedReviewModules } from "../server/translation-modules.mjs";
import { callModel } from "../server/model.mjs";

// Explicit scripted provider fixture. It tests production entry/wiring and
// native checking, not autonomous mathematical capability or a real paper.
const definition = "Let x be a real number.";
const statement = "Theorem Q. The logarithm of exp(x) equals x.";
const proofText = "Proof. Apply the logarithm-exponential inverse identity.";
const target = "∀ x : ℝ, Real.log (Real.exp x) = x";
const anchor = (quote) => ({ pageIndex: 0, quote });

test(
  "raw PDF HTTP entry uses the production transport and SDK, repairs scope, unwraps a final object and replays Lean",
  // The bounded review below is followed by fresh native replay and evidence
  // export. Leave separate time for those checks; this does not alter product
  // model budgets or the review's 550-second completion deadline.
  { timeout: 900000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-mainflow-"));
    let scopes = 0,
      verifiedImportedTarget = false;
    const model = async (_, req) => {
      let parsed;
      switch (req.role) {
        case "A_READ":
          parsed = {
            summary: "Explicit test fixture.",
            claims: [{ label: "Q", ...anchor("Theorem Q."), statement }],
          };
          break;
        case "A_ENV":
          parsed = {
            summary: "Search imports from declarations.",
            choices: req.input.paperMap.claims.map((c) => ({
              claimId: c.id,
              profile: "std-v1",
              reason: "Exercise extra pinned imports.",
              queries: ["Real.log_exp"],
              names: ["Real.log", "Real.log_exp", "Nat", "Int"],
            })),
          };
          break;
        case "A_SOURCE_SCOPE":
          scopes++;
          if (scopes > 1) {
            assert.match(req.input.feedback.error, /前提不在/);
            assert(req.input.feedback.failureArtifact);
            assert.deepEqual(req.input.rejectedProposal.spans, [
              anchor(statement),
            ]);
          }
          parsed = {
            spans:
              scopes === 1
                ? [anchor(statement)]
                : [anchor(definition), anchor(statement)],
            premises: [anchor(definition)],
            conclusion: [anchor(statement)],
            explanation:
              "Use the exact definition preceding the same statement.",
          };
          break;
        case "A_SCOPE_REVIEW":
          parsed = {
            scopeHash: req.input.scope.scopeHash,
            decision: "complete",
            explanation: "Both source segments selected.",
            anchors: [anchor(statement)],
          };
          break;
        case "A_COORDINATOR":
          parsed = req.input.tasks.some((t) => t.kind === "formalize")
            ? {
                mode: "finish",
                reason: "Controlled pipeline reached its result.",
                coverage: req.input.claims.map((c) => ({
                  claimId: c.id,
                  formalization: "attempted",
                  reason: "Native result remains distinct from model choice.",
                })),
              }
            : {
                mode: "act",
                reason: "Test formal pipeline.",
                actions: [
                  {
                    kind: "formalize",
                    claimId: req.input.claims[0].id,
                    title: "Check inverse identity",
                    question: "Check exact statement.",
                    reason: "Source selected.",
                    strategy: "First formal attempt.",
                    basedOn: [
                      req.input.tasks.filter((t) => t.hasEvidence).at(-1).id,
                    ],
                  },
                ],
              };
          break;
        case "R03":
          assert.equal(req.input.selectedQuote, "Theorem Q.");
          assert(
            req.input.preparedEnvironment.modules.some((m) =>
              m.name.includes("Log"),
            ),
          );
          parsed = {
            label: "Q",
            quote: req.input.selectedQuote,
            statement,
            assumptions: [],
            leanTarget: target,
            ambiguity: "",
            alignment: ALIGNMENT_CATEGORIES.map((category) => ({
              category,
              explanation: "Controlled source mapping.",
              leanFragment: "x",
              anchors: [anchor(statement)],
            })),
          };
          break;
        case "R04":
          assert.equal(req.input.contract.leanTarget, target);
          assert(
            req.input.contract.domainContext.modules.some((m) =>
              m.name.includes("Log"),
            ),
          );
          verifiedImportedTarget = true;
          parsed = {
            targetHash: req.input.contract.targetHash,
            findings: [],
            ...(req.input.stage
              ? {}
              : {
                  sourceAudit: {
                    ...sourceAuditFixture(
                      req.input.contract,
                      req.input.targetStructure,
                      req.input.context.semanticProtocol,
                    ),
                    probes: [
                      {
                        kind: "assumption_witness",
                        leanTarget: "∃ x : ℝ, x = 0",
                        proof: "by exact ⟨0, rfl⟩",
                        explanation:
                          "Explicit diagnostic fixture; does not prove the parent theorem.",
                        anchors: [anchor(definition)],
                      },
                    ],
                  },
                }),
            backTranslation: statement,
            checks: ALIGNMENT_CATEGORIES.map((category) => ({
              category,
              status: "aligned",
              explanation: "Controlled attestation.",
              anchors: [anchor(statement)],
            })),
          };
          break;
        case "A_SEMANTIC_DECISION":
          parsed = {
            targetHash: req.input.contract.targetHash,
            semanticArtifact: req.input.semanticArtifact,
            decision: "proof",
            summary: "Controlled fixture only.",
            resolutions: [],
          };
          break;
        case "R06":
          parsed = {
            status: "unchecked",
            quote: "",
            explanation: "Source route checked separately.",
          };
          break;
        case "R06_GRAPH":
          parsed = {
            steps: [
              {
                name: "Inverse",
                title: "Inverse identity",
                kind: "explicit",
                anchors: [anchor(proofText)],
                target,
                dependsOn: [],
                explanation: "Explicit fixture argument.",
                proof: "by intro x; exact Real.log_exp x",
              },
            ],
            assembly: "by intro h; exact h",
          };
          break;
        case "R06_INTERFACES":
        case "R06_INTERFACE_REPAIR":
        case "R06_BLUEPRINT_REPAIR":
          parsed = { graph: req.input.graph, changes: [], interfaces: [] };
          break;
        case "R06_ALIGN":
          parsed = {
            coverage: "complete",
            missingSteps: [],
            checks: req.input.graph.steps.map((s) => ({
              name: s.name,
              status: "faithful",
              anchors: s.anchors,
              explanation: "Controlled route mapping.",
            })),
            summary: "Controlled fixture.",
          };
          break;
        case "R06_ROUTE_AUDIT":
        case "R06_CONNECTION_AUDIT":
          parsed = {
            status: "faithful",
            explanation: "The fixture explicitly applies the inverse identity.",
          };
          break;
        case "R07":
        case "R08":
        case "R_PROVE":
          parsed = {
            proof: "by intro x; exact Real.log_exp x",
            mode: "proof",
            route: "independent",
            explanation: "Scripted test candidate.",
          };
          break;
        case "A_DIAGNOSE":
          parsed = {
            action: "stop",
            guidance: "Unexpected fixture failure: retain it.",
          };
          break;
        default:
          throw Error("Unexpected model role " + req.role);
      }
      return {
        parsed,
        record: { provider: "scripted-test-only", role: req.role },
      };
    };
    const wireCalls = [];
    const provider = createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        let system = body.messages.find((m) => m.role === "system").content;
        let input = JSON.parse(
          body.messages.find((m) => m.role === "user").content,
        );
        const viaSdk = typeof input.goal === "string";
        if (viaSdk) {
          const boundary = input.goal.lastIndexOf("\n{");
          assert(boundary >= 0, "SDK task must preserve its structured input");
          system = input.goal.slice(0, boundary);
          input = JSON.parse(input.goal.slice(boundary + 1));
        }
        const patterns = [
          ["A_READ", "你是数学论文原文理解 Agent"],
          ["A_ENV", "你是形式化环境选择 Agent"],
          ["A_COORDINATOR", "你是数学论文评审协调 Agent"],
          ["A_SOURCE_SCOPE", "定位片段不是完整命题"],
          ["R03", "你负责 R03 命题语义"],
          ["R04", "你负责 R04"],
          ["R04", "你负责原文与固定形式目标"],
          ["R06", "你负责 R06 原证明审计"],
          ["R07", "你负责 R09 证明构造"],
          ["R_PROVE", "For this immutable Lean 4.35.0 target"],
          ["A_SEMANTIC_DECISION", "独立复核论文原文、形式目标"],
          ["R06_GRAPH", "Extract the AUTHOR'S ACTUAL proof"],
          ["R06_INTERFACES", "Review the WHOLE source proof"],
          ["R06_ALIGN", "Copy each source anchor verbatim"],
          [
            "R06_ROUTE_AUDIT",
            "Independently assess whether this accepted Lean proof",
          ],
          [
            "R06_CONNECTION_AUDIT",
            "Independently compare this connection proof",
          ],
          ["A_DIAGNOSE", "你是执行诊断子 Agent"],
        ];
        const role =
          patterns.find(([, prefix]) => system.startsWith(prefix))?.[0] ||
          (input.scope ? "A_SCOPE_REVIEW" : null);
        assert(role, "Unexpected production prompt: " + system.slice(0, 100));
        wireCalls.push({ role, viaSdk });
        let message,
          finish = "stop";
        if (role === "R03" && !body.messages.some((m) => m.role === "tool")) {
          assert(viaSdk);
          message = {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "controlled-inspection",
                type: "function",
                function: {
                  name: "prepare_translation",
                  arguments: JSON.stringify({
                    profileId: "std-v1",
                    names: ["Real.log", "Real.log_exp"],
                    candidate: (await model(null, { role, input })).parsed,
                  }),
                },
              },
            ],
          };
          finish = "tool_calls";
        } else {
          if (role === "R03") {
            const native = JSON.parse(
              body.messages.filter((m) => m.role === "tool").at(-1).content,
            );
            assert.equal(native.status, "prepared", JSON.stringify(native));
          }
          const result = await model(null, { role, input });
          const payload = JSON.stringify(
            role === "R04"
              ? auditBodyFixture(result.parsed, input.context.semanticProtocol)
              : result.parsed,
          );
          if (role === "R03") {
            const submit = body.tools.find(
              (t) => t.function.parameters?.properties?.alignment,
            );
            assert(submit, "Typed R03 submission tool must be registered");
            message = {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "controlled-submit",
                  type: "function",
                  function: { name: submit.function.name, arguments: payload },
                },
              ],
            };
            finish = "tool_calls";
          } else if (role === "R04") {
            assertStrictRequest(body, input);
            message = strictMessageFixture(
              strictBodyFixture(result.parsed, !!input.stage),
            );
            finish = "tool_calls";
          } else message = { role: "assistant", content: payload };
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "controlled-provider",
            choices: [{ finish_reason: finish, message }],
          }),
        );
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
    await new Promise((r) => provider.listen(0, "127.0.0.1", r));
    const transportRequests = [];
    const app = await createApp({
      dataRoot: dir,
      transportModel: async (config, request) => {
        transportRequests.push({
          role: request.role,
          toolCount: request.tools?.length || 0,
        });
        return callModel(config, request);
      },
      configProvider: async () => ({
        auditBindingProtocol: AUDIT_BINDING_PROTOCOL,
        model: "controlled-http-sdk-fixture",
        key: "fixture-only-key",
        endpoint: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
        concurrency: 1,
        timeoutMs: 30000,
      }),
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    try {
      const pdf = await PDFDocument.create();
      pdf.addPage().drawText([definition, statement, proofText].join("\n"), {
        x: 30,
        y: 700,
        size: 10,
        font: await pdf.embedFont(StandardFonts.TimesRoman),
      });
      const bytes = Buffer.from(await pdf.save());
      const response = await fetch(
        `http://127.0.0.1:${app.server.address().port}/api/reviews`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "model",
            orchestration: "adaptive",
            paperSha256: sha256(bytes),
            pdfBase64: bytes.toString("base64"),
          }),
        },
      );
      assert.equal(response.status, 202);
      const { id } = await response.json();
      let run;
      const deadline = Date.now() + 550000;
      while (Date.now() < deadline) {
        run = await app.store.getRun(id);
        if (!app.adaptive.active.has(id) && !app.pipeline.active.size) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const tasks = run.tasks.map((t) => ({
        kind: t.kind,
        status: t.status,
        error: t.error,
        childRunId: t.childRunId,
      }));
      assert.equal(
        run.status,
        "completed",
        JSON.stringify({ error: run.error, tasks }),
      );
      assert.equal(scopes, 2);
      assert.equal(run.claims[0].anchor.quote, "Theorem Q.");
      assert(verifiedImportedTarget, JSON.stringify(tasks));
      const formal = run.tasks.find((t) => t.childRunId);
      assert(formal, JSON.stringify(tasks));
      const child = await app.store.getRun(formal.childRunId);
      assert.deepEqual(
        child.propositionScope.spans.map((s) => s.quote),
        [definition, statement],
      );
      assert.equal(
        child.check?.status,
        "verified",
        JSON.stringify({ error: child.error, tasks, check: child.check }),
      );
      assert.equal(
        child.originalProofRoute?.summary.status,
        "verified_route",
        JSON.stringify(child.originalProofRoute?.summary),
      );
      const probe = run.claims[0].environmentReport;
      for (const name of ["Real.log", "Real.log_exp", "Nat", "Int"])
        assert.equal(
          probe.declarations.find((d) => d.name === name)?.status,
          "available",
          name,
        );
      const bundle = await app.store.bundle(run.root);
      inspectBundle(bundle, run.root);
      assert(
        bundle.artifacts.some((a) => a.kind === "adaptive:resolve_scope:error"),
      );
      assert(
        bundle.artifacts.some(
          (a) => a.kind === "task:RDP" && a.payload.environmentSelection,
        ),
      );
      assert(wireCalls.some((c) => c.role === "R03" && c.viaSdk));
      assert(
        transportRequests.some(
          (c) => c.role === "HARNESS_TOOL_MODEL" && c.toolCount > 0,
        ),
      );
      assert(
        bundle.artifacts.some(
          (a) =>
            a.kind === "harness:tool" &&
            a.payload.name === "prepare_translation",
        ),
      );
      assert(
        bundle.artifacts.some(
          (a) => a.kind === "harness:report" && a.payload.structuredSchemaHash,
        ),
      );
      const selection = child.environmentSelection,
        artifacts = new Map(bundle.artifacts.map((a) => [a.id, a]));
      assert.throws(
        () =>
          selectedReviewModules(
            artifacts,
            { ...selection, claimId: "foreign" },
            child.contract,
          ),
        /foreign/,
      );
      assert.throws(
        () =>
          selectedReviewModules(artifacts, selection, {
            paperSha256: sha256("other"),
          }),
        /foreign/,
      );
      const replay = await app.pipeline.replay(
        await app.store.bundle(child.root),
        child.root,
      );
      assert.equal(replay.reproduced, true, JSON.stringify(replay));
      assert.equal(child.semanticReview.semanticProbes.length, 1);
      assert.equal(
        child.semanticReview.semanticProbes[0].check.status,
        "verified",
      );
      assert.equal(
        child.semanticReview.semanticProbes[0].parentAcceptance,
        "unchanged",
      );
      assert.equal(replay.semanticProbeReplays.length, 1);
      assert.equal(replay.semanticProbeReplays[0].revalidated, true);
      const proofModule = child.contract.domainContext.modules;
      const out =
        process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/mainflow-controlled";
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, "bundle.json"), JSON.stringify(bundle), {
        flag: "wx",
      });
      await writeFile(
        path.join(out, "child-bundle.json"),
        JSON.stringify(await app.store.bundle(child.root)),
        { flag: "wx" },
      );
      await writeFile(
        path.join(out, "native-mainflow.json"),
        JSON.stringify(
          {
            classification:
              "scripted_http_provider_production_transport_sdk_langgraph_lean_and_replay_not_autonomous_paper_proof",
            wireCalls,
            id,
            root: run.root,
            scopeAttempts: scopes,
            modules: proofModule,
            check: child.check,
            replay,
            bundleFile: "bundle.json",
          },
          null,
          2,
        ),
      );
    } finally {
      // Stop owned work before closing HTTP connections; open event streams
      // otherwise keep server.close waiting even after all assertions passed.
      await app.adaptive.close();
      await app.harness.close();
      provider.closeAllConnections();
      app.server.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await new Promise((resolve) => app.server.close(resolve));
      if (process.env.LEMMA_TEST_EVIDENCE_DIR) {
        await mkdir(process.env.LEMMA_TEST_EVIDENCE_DIR, { recursive: true });
        await cp(
          dir,
          path.join(process.env.LEMMA_TEST_EVIDENCE_DIR, path.basename(dir)),
          { recursive: true, errorOnExist: true, force: false },
        );
        await writeFile(
          path.join(process.env.LEMMA_TEST_EVIDENCE_DIR, "wire-calls.json"),
          JSON.stringify(wireCalls, null, 2),
          { flag: "wx" },
        );
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "native declaration query accepts pretty-printed names and rejects an unknown sibling independently",
  { timeout: 120000 },
  async () => {
    const text = "Explicit native declaration diagnostic fixture.";
    const contract = createContract(
      {
        paperSha256: sha256(text),
        pageIndex: 0,
        text,
        artifact: sha256("source"),
      },
      {
        label: "fixture",
        quote: text,
        statement: text,
        assumptions: [],
        leanTarget: "True",
      },
      "std-v1",
    );
    const result = await inspectTarget(contract, {
      names: ["Nat", "Int", "NoSuchFixture.constant"],
    });
    assert.equal(result.status, "query_incomplete");
    assert.equal(result.targetTypeStatus, "well_typed");
    assert.equal(result.declarationQueryStatus, "incomplete");
    assert.deepEqual(
      result.declarations.map((d) => d.status),
      ["available", "available", "query_failed"],
    );
  },
);
