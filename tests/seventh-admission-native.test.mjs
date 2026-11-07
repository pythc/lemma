import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createAdmissionRuntime } from "../server/admission-runtime.mjs";
import {
  EvidenceStore,
  sha256,
  digest,
  inspectBundle,
} from "../server/evidence.mjs";
import { AUDIT_BINDING_PROTOCOL } from "../server/audit-envelope.mjs";
import { ALIGNMENT_CATEGORIES } from "../server/semantics.mjs";
import {
  sourceAuditFixture,
  auditBodyFixture,
} from "./source-audit-fixture.mjs";

for (const repair of [false, true])
  test(
    `HTTP+SDK+native admission ${repair ? "repairs a native-rejected draft before creating the contract" : "reserves submission and both audits"}`,
    { timeout: 240000 },
    async () => {
      const evidence = path.resolve(
        process.env.LEMMA_TEST_EVIDENCE_DIR ||
          "evidence/math-preparation-native",
      );
      await mkdir(evidence, { recursive: true });
      const root = await mkdtemp(path.join(evidence, "controlled-admission-"));
      const store = new EvidenceStore(path.join(root, "store"));
      const source = "Every integer x equals itself.";
      const target = "∀ x : Int, x = x";
      const outgoing = [];
      const submit = (body, bad = false) => {
        const output = body.tools.find(
          (t) => t.function.parameters.properties?.alignment,
        );
        assert(output || outgoing.length === 1);
        return {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `submit-${outgoing.length}`,
              type: "function",
              function: {
                name: output?.function.name || "unused_final",
                arguments: JSON.stringify({
                  label: "explicit controlled fixture",
                  quote: source,
                  statement: source,
                  assumptions: [],
                  leanTarget: bad ? "∀ x : ℤ, x = x" : target,
                  ambiguity: "",
                  alignment: ALIGNMENT_CATEGORIES.map((category) => ({
                    category,
                    explanation: "Controlled mapping.",
                    leanFragment: "x",
                    anchors: [{ pageIndex: 0, quote: source }],
                  })),
                }),
              },
            },
          ],
        };
      };
      const server = createServer(async (req, res) => {
        try {
          let raw = "";
          for await (const c of req) raw += c;
          const body = JSON.parse(raw);
          outgoing.push(body);
          await writeFile(
            path.join(root, `wire-${outgoing.length}.json`),
            JSON.stringify(body, null, 2),
            { flag: "wx" },
          );
          let message;
          if (outgoing.length === 1) {
            assert.equal(body.tool_choice, "required");
            assert.deepEqual(
              body.tools.map((t) => t.function.name),
              ["prepare_translation"],
            );
            const candidate = JSON.parse(
              submit(body, repair).tool_calls[0].function.arguments,
            );
            message = {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "prepare",
                  type: "function",
                  function: {
                    name: "prepare_translation",
                    arguments: JSON.stringify({ candidate }),
                  },
                },
              ],
            };
          } else if (outgoing.length === 2) {
            assert.equal(body.tool_choice, "required");
            assert.equal(body.thinking.type, "disabled");
            assert.equal(
              body.tools.length,
              2,
              "Only the two submission tools remain",
            );
            if (!repair) {
              const check = JSON.parse(
                body.messages.find((m) => m.role === "tool").content,
              );
              assert.equal(check.status, "prepared", JSON.stringify(check));
              assert(check.diagnostic.imports.includes("Std"));
            }
            message = submit(body);
          } else {
            assert(!body.tools);
            const input = JSON.parse(
              body.messages.find((m) => m.role === "user").content,
            );
            const schema = JSON.parse(
              body.messages[0].content
                .split("\nJSON Schema: ")[1]
                .split("\n论文是")[0],
            );
            assert(!schema.properties.targetHash);
            message = {
              role: "assistant",
              content: JSON.stringify(
                auditBodyFixture(
                  {
                    backTranslation: source,
                    findings: [],
                    checks: ALIGNMENT_CATEGORIES.map((category) => ({
                      category,
                      status: "aligned",
                      explanation:
                        "Controlled native plumbing fixture, not model accuracy.",
                      anchors: [{ pageIndex: 0, quote: source }],
                    })),
                    ...(!input.stage
                      ? {
                          sourceAudit: sourceAuditFixture(
                            input.contract,
                            input.targetStructure,
                            input.context.semanticProtocol,
                          ),
                        }
                      : {}),
                  },
                  input.context.semanticProtocol,
                ),
              ),
            };
          }
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              choices: [
                {
                  finish_reason: message.tool_calls ? "tool_calls" : "stop",
                  message,
                },
              ],
            }),
          );
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error.stack }));
        }
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const config = {
        endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        key: "local-fixture",
        model: "explicit-scripted-provider",
        timeoutMs: 30000,
        maxOutputTokens: 12000,
        auditBindingProtocol: AUDIT_BINDING_PROTOCOL,
      };
      let runtime;
      const wait = async (id) => {
        while (runtime.pipeline.active.has(id))
          await new Promise((r) => setTimeout(r, 30));
        return store.getRun(id);
      };
      try {
        runtime = await createAdmissionRuntime({ store, config });
        const pdf = await PDFDocument.create(),
          font = await pdf.embedFont(StandardFonts.TimesRoman);
        pdf.addPage().drawText(source, { font, x: 30, y: 700 });
        const bytes = Buffer.from(await pdf.save());
        let run = await wait(
          (
            await runtime.start({
              mode: "model",
              libraryProfile: "std-v1",
              focusQuote: source,
              pageIndex: 0,
              paperSha256: sha256(bytes),
              pdfBase64: bytes.toString("base64"),
            })
          ).id,
        );
        assert.equal(run.nativeTargetCheck.status, "well_typed");
        assert.equal(
          run.semanticReview?.adjudication?.admission,
          "allowed",
          JSON.stringify({ error: run.error, review: run.semanticReview }),
        );
        assert.equal(outgoing.length, 4);
        assert.equal((await runtime.snapshot()).used, 4);
        const report = await store.put(
          "seventh:controlled_admission",
          { run, budget: await store.getRun(runtime.budgetId), scripted: true },
          [
            ...run.tasks.map((t) => t.output),
            ...(await store.getRun(runtime.budgetId)).modelBudget.entries.map(
              (e) => e.receipt,
            ),
          ].filter(Boolean),
        );
        const bundle = await store.bundle(report);
        inspectBundle(bundle, report);
        if (repair) {
          const prep = bundle.artifacts.find(
            (a) =>
              a.kind === "harness:tool" &&
              a.payload.name === "prepare_translation",
          );
          assert.equal(prep.payload.value.status, "rejected");
          assert.equal(prep.payload.value.diagnostic.status, "not_well_typed");
          assert.equal(
            prep.payload.args.candidate.leanTarget,
            "∀ x : ℤ, x = x",
          );
          assert.equal(run.contract.leanTarget, target);
        }
        await writeFile(path.join(root, "bundle.json"), JSON.stringify(bundle));
        await writeFile(
          path.join(root, "result.json"),
          JSON.stringify({ passed: true, calls: outgoing.length, report }),
        );
      } catch (error) {
        await writeFile(
          path.join(root, "failure.json"),
          JSON.stringify({ error: error.stack, calls: outgoing.length }),
        );
        throw error;
      } finally {
        await runtime?.close();
        await new Promise((r) => server.close(r));
      }
    },
  );

test(
  "actual fixed Std compiler and module validation retain distinct diagnostic failures",
  { timeout: 240000 },
  async () => {
    const { createContract } = await import("../server/contracts.mjs");
    const { inspectTarget } = await import("../server/lean-query.mjs");
    const { inspectionErrorKind } =
      await import("../server/inspection-diagnostic.mjs");
    const { moduleName } = await import("../server/domain-schema.mjs");
    const { moduleManifest } = await import("../server/domain-library.mjs");
    const source =
      "Diagnostic compiler fixtures, not supplied model solutions.";
    const rows = [];
    const dir = await mkdtemp(
      path.resolve("evidence/seventh-batch-20261022/controlled-diagnostics-"),
    );
    const saveRows = () =>
      writeFile(path.join(dir, "result.json"), JSON.stringify(rows, null, 2));
    for (const [target, expected] of [
      ["∀ n : Nat, n = n", null],
      ["∀ n : Int, n = n", null],
      ["∀ n : ℕ, n = n", "unknown_symbol"],
      ["∀ n : MissingDefinition, n = n", "unknown_symbol"],
      ["(1 : Nat) + True = 1", "type_mismatch"],
    ]) {
      const contract = createContract(
        {
          paperSha256: sha256(source),
          pageIndex: 0,
          text: source,
          artifact: sha256(source),
        },
        {
          label: "compiler diagnostic",
          quote: source,
          statement: source,
          assumptions: [],
          leanTarget: target,
        },
        "std-v1",
      );
      const check = await inspectTarget(contract);
      const kind = inspectionErrorKind(check);
      rows.push({ target, check, kind });
      await saveRows();
      assert.equal(kind, expected, JSON.stringify(check));
    }
    for (const [action, expected] of [
      [() => moduleName("Std"), "invalid_tool_argument"],
      [
        () => moduleManifest(["Mathlib.SeventhDiagnosticModuleDoesNotExist"]),
        "module_unavailable",
      ],
    ]) {
      let failure;
      try {
        await action();
      } catch (e) {
        failure = e;
      }
      assert(failure);
      rows.push({
        error: failure.message,
        code: failure.code,
        kind: inspectionErrorKind(failure),
      });
      await saveRows();
      assert.equal(inspectionErrorKind(failure), expected);
    }
    await saveRows();
  },
);
