import { STRICT_AUDIT_BINDING_PROTOCOL } from "../server/strict-audit.mjs";
import {
  assertStrictRequest,
  strictBodyFixture,
  strictMessageFixture,
} from "./strict-audit-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { EvidenceStore, digest, inspectBundle } from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";
import {
  WITNESSED_AUDIT_PROTOCOL,
  NATIVE_BOUND_AUDIT_PROTOCOL,
  WITNESS_AUDIT_PROTOCOL,
  ANCHORED_AUDIT_PROTOCOL,
  INDEXED_ANCHOR_V2,
} from "../server/audit-wire.mjs";
import { AUDIT_BINDING_PROTOCOL } from "../server/audit-envelope.mjs";
import { validateStructuredAttempts } from "../server/structured-review.mjs";
import { ALIGNMENT_CATEGORIES } from "../server/semantics.mjs";
import {
  sourceAuditFixture,
  auditBodyFixture,
} from "./source-audit-fixture.mjs";

for (const [protocol, bindingProtocol] of [
  ...[
    WITNESSED_AUDIT_PROTOCOL,
    NATIVE_BOUND_AUDIT_PROTOCOL,
    WITNESS_AUDIT_PROTOCOL,
    ANCHORED_AUDIT_PROTOCOL,
  ].map((p) => [p, AUDIT_BINDING_PROTOCOL]),
  [ANCHORED_AUDIT_PROTOCOL, STRICT_AUDIT_BINDING_PROTOCOL],
])
  for (const [independentChange, formatFailure] of bindingProtocol ===
  STRICT_AUDIT_BINDING_PROTOCOL
    ? [
        [false, false],
        [true, false],
        [false, true],
      ]
    : [
        [false, false],
        [true, false],
      ])
    test(
      `${protocol}/${bindingProtocol}/${formatFailure ? "invalid-blind" : "valid"} real HTTP/native review preserves missing source and ${independentChange ? "separate known change" : "rejects substitution certainty"}`,
      { timeout: 180000 },
      async () => {
        const base = path.resolve(
          process.env.LEMMA_TEST_EVIDENCE_DIR ||
            "evidence/math-preparation-native",
        );
        await mkdir(base, { recursive: true });
        const dir = await mkdtemp(path.join(base, "controlled-semantic-"));
        const store = new EvidenceStore(path.join(dir, "store"));
        await store.init();
        const quote = "For every integer x, T(x) is positive.";
        const anchor = { pageIndex: 0, quote };
        const contract = createContract(
          {
            text: quote,
            pageIndex: 0,
            paperSha256: digest(quote),
            artifact: digest("controlled-source"),
          },
          {
            label: "controlled epistemic fixture",
            quote,
            statement: quote,
            assumptions: [],
            leanTarget: `${independentChange ? "∃" : "∀"} x : Int, -x > 0`,
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
        const outgoing = [];
        const server = createServer(async (req, res) => {
          let bytes = "";
          for await (const chunk of req) bytes += chunk;
          try {
            const wire = JSON.parse(bytes);
            outgoing.push(wire);
            const input = JSON.parse(
              wire.messages.find((m) => m.role === "user").content,
            );
            assert.equal(input.context.semanticProtocol, protocol);
            const missing = {
              kind: "source_missing",
              category: "definitions",
              anchors: [anchor],
              targetFragment: "-x",
              missingSymbols: ["T"],
              independentOfMissing: false,
              basis: "No definition of T in this fixed source.",
              changeWitness: null,
            };
            const change = {
              kind: "established_change",
              category: independentChange ? "quantifiers" : "definitions",
              anchors: [anchor],
              targetFragment: independentChange ? "∃ x : Int" : "-x",
              missingSymbols: [],
              independentOfMissing: true,
              basis:
                "Controlled challenge to the certainty guard, not model accuracy.",
              changeWitness: {
                ...([WITNESS_AUDIT_PROTOCOL, ANCHORED_AUDIT_PROTOCOL].includes(
                  protocol,
                )
                  ? { effect: "mathematical_difference" }
                  : {}),
                kind: independentChange ? "quantifiers" : "definitions",
                ...(protocol === ANCHORED_AUDIT_PROTOCOL
                  ? { sourceAnchor: anchor }
                  : { sourceAnchorIndex: 0 }),
                sourceFragment: independentChange
                  ? "For every integer x"
                  : "T(x)",
              },
            };
            const sourceAudit = sourceAuditFixture(
              input.contract,
              input.targetStructure,
              input.context.semanticProtocol,
            );
            sourceAudit.coverage.status = "incomplete";
            sourceAudit.fidelity.status = "unknown";
            sourceAudit.missing = [
              { symbol: "T", reason: "Absent definition", anchors: [anchor] },
            ];
            const body = {
              backTranslation: "Controlled missing-definition source.",
              findings: input.stage ? [change] : [missing],
              checks: ALIGNMENT_CATEGORIES.map((category) => ({
                category,
                status: category === "definitions" ? "unresolved" : "aligned",
                explanation: "Controlled plumbing fixture",
                anchors: [anchor],
              })),
              ...(!input.stage ? { sourceAudit } : {}),
            };
            if (bindingProtocol === STRICT_AUDIT_BINDING_PROTOCOL)
              assertStrictRequest(outgoing.at(-1), input);
            const strictBody =
              bindingProtocol === STRICT_AUDIT_BINDING_PROTOCOL
                ? strictBodyFixture(body, !!input.stage)
                : null;
            if (formatFailure && !input.stage)
              strictBody.coverage.explanation =
                "Controlled reproduction of old failure";
            res.end(
              JSON.stringify({
                choices: [
                  {
                    finish_reason:
                      bindingProtocol === STRICT_AUDIT_BINDING_PROTOCOL
                        ? "tool_calls"
                        : "stop",
                    message:
                      bindingProtocol === STRICT_AUDIT_BINDING_PROTOCOL
                        ? strictMessageFixture(strictBody)
                        : {
                            content: JSON.stringify(
                              auditBodyFixture(body, protocol),
                            ),
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
        const config = {
          endpoint: `http://127.0.0.1:${server.address().port}`,
          key: "fixture-only",
          model: "scripted-local-provider",
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
        try {
          if (formatFailure) {
            await assert.rejects(
              pipeline.reviewTranslation(
                run,
                proposal,
                config,
                new AbortController(),
              ),
              /full client schema/,
            );
            assert.equal(outgoing.length, 1);
            assert.equal(run.nativeTargetCheck.status, "well_typed");
            assert.equal(run.semanticReview, undefined);
            assert.equal(
              run.tasks.some((t) => t.role === "R04"),
              false,
            );
            assert.equal(
              run.tasks.find((t) => t.role === "R04B").status,
              "blocked",
            );
            await writeFile(
              path.join(dir, "expected-failure.json"),
              JSON.stringify(
                {
                  run,
                  outgoing,
                  comparisonSlot: "unused",
                  reviewComplete: false,
                },
                null,
                2,
              ),
              { flag: "wx" },
            );
            return;
          }
          await pipeline.reviewTranslation(
            run,
            proposal,
            config,
            new AbortController(),
          );
          assert.equal(outgoing.length, 2);
          assert.equal(run.nativeTargetCheck.status, "well_typed");
          assert.equal(
            run.semanticReview.adjudication.fidelity,
            independentChange ? "changed" : "unknown",
          );
          assert.equal(run.semanticReview.adjudication.admission, "blocked");
          const blind = (
            await store.get(run.tasks.find((t) => t.role === "R04B").output)
          ).payload;
          validateStructuredAttempts(
            blind.structuredAttempts,
            blind.input,
            blind.response,
            blind.model,
          );
          const root = await store.put(
            "controlled:" + protocol,
            {
              run,
              scope:
                "real HTTP/native execution with scripted provider; not external model accuracy",
            },
            run.tasks.map((t) => t.output).filter(Boolean),
          );
          const bundle = await store.bundle(root);
          inspectBundle(bundle, root); // Throws on a modified or disconnected graph.
          await writeFile(
            path.join(dir, "bundle.json"),
            JSON.stringify(bundle),
            {
              flag: "wx",
            },
          );
          await writeFile(
            path.join(dir, "result.json"),
            JSON.stringify({ root, calls: outgoing.length, run }, null, 2),
            { flag: "wx" },
          );
        } catch (error) {
          await writeFile(
            path.join(dir, "failure.json"),
            JSON.stringify({ error: error.stack, run, outgoing }, null, 2),
            { flag: "wx" },
          );
          throw error;
        } finally {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      },
    );
