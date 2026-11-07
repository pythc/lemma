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

for (const variant of [
  "indexed",
  "duplicate",
  "foreign",
  "prepared",
  "draft-rejected",
  "polluted-final",
  "bypass",
  "direct-final",
  "duplicate-preparation",
])
  test(
    `HTTP+SDK+native indexed translation ${variant}`,
    { timeout: 240000 },
    async () => {
      const evidence = path.resolve(
        process.env.LEMMA_TEST_EVIDENCE_DIR ||
          "evidence/math-preparation-native",
      );
      await mkdir(evidence, { recursive: true });
      const root = await mkdtemp(path.join(evidence, "controlled-admission-"));
      const store = new EvidenceStore(path.join(root, "store"));
      const source =
        "For any integers p and q, if p is at most q and q is at most p, then p equals q.";
      const target = "∀ (p q : Int), p ≤ q → q ≤ p → p = q";
      const outgoing = [];
      const submit = (body) => {
        const task = JSON.parse(
          body.messages.find((m) => m.role === "user").content,
        );
        const input = JSON.parse(
          task.goal.slice(task.goal.lastIndexOf("\n{") + 1),
        );
        const catalog = input.context.anchorIndex;
        assert.equal(
          input.context.translationProtocol,
          "lemma.translation-wire.v2",
        );
        assert(catalog.length);
        const chosen = catalog.find((a) => a.quote === source);
        assert(chosen);
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
                name: output?.function.name || "forbidden_final",
                arguments: JSON.stringify({
                  label: "explicit controlled fixture",
                  quote: source,
                  statement: source,
                  assumptions: [],
                  leanTarget: target,
                  ambiguity: "",
                  alignment: ALIGNMENT_CATEGORIES.map((category) => ({
                    category,
                    explanation: "Controlled mapping.",
                    leanFragment: target,
                    anchors: [
                      [
                        "indexed",
                        "prepared",
                        "draft-rejected",
                        "polluted-final",
                      ].includes(variant)
                        ? { anchorId: chosen.anchorId }
                        : variant === "duplicate"
                          ? { pageIndex: 0, quote: "at most" }
                          : { anchorId: "a".repeat(20) },
                    ],
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
            const full = JSON.parse(
              submit(body).tool_calls[0].function.arguments,
            );
            if (variant === "draft-rejected") delete full.ambiguity;
            message = {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "prepare",
                  type: "function",
                  function: {
                    name:
                      variant === "bypass"
                        ? "inspect_current_environment"
                        : variant === "direct-final"
                          ? "forbidden_final"
                          : "prepare_translation",
                    arguments: JSON.stringify(
                      variant === "bypass"
                        ? { target, names: [] }
                        : variant === "direct-final"
                          ? full
                          : { candidate: full },
                    ),
                  },
                },
              ],
            };
            if (variant === "duplicate-preparation")
              message.tool_calls.push({
                ...message.tool_calls[0],
                id: "prepare-again",
              });
          } else if (outgoing.length === 2) {
            assert.equal(body.tool_choice, "required");
            assert.equal(body.thinking.type, "disabled");
            assert.equal(
              body.tools.length,
              2,
              "Only the two submission tools remain",
            );
            const check = JSON.parse(
              body.messages.find((m) => m.role === "tool").content,
            );
            assert.equal(
              check.status,
              ["draft-rejected", "duplicate", "foreign"].includes(variant)
                ? "rejected"
                : "prepared",
              JSON.stringify(check),
            );
            assert.equal(check.verified, false);
            if (variant === "draft-rejected")
              assert.equal(check.validation.code, "translation_wire_invalid");
            message = submit(body);
            if (variant === "polluted-final") {
              const final = JSON.parse(
                message.tool_calls[0].function.arguments,
              );
              final.leanTarget +=
                '</leanTarget><｜｜DSML｜｜ parameter name="ambiguity" string="true">';
              // All required keys remain: the product must reject contamination
              // even when the SDK JSON schema alone would accept the object.
              message.tool_calls[0].function.arguments = JSON.stringify(final);
            }
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
        assert.equal((await store.getRun(runtime.budgetId)).status, "running");
        assert.equal((await store.getRun(runtime.budgetId)).error, undefined);
        const pdf = await PDFDocument.create(),
          font = await pdf.embedFont(StandardFonts.TimesRoman);
        pdf
          .addPage()
          .drawText(source, { font, x: 30, y: 700, size: 10, maxWidth: 530 });
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
        if (["indexed", "prepared", "draft-rejected"].includes(variant)) {
          assert.equal(run.nativeTargetCheck.status, "well_typed");
          assert.equal(
            run.semanticReview?.adjudication?.admission,
            "allowed",
            JSON.stringify({ error: run.error, review: run.semanticReview }),
          );
          assert.equal(outgoing.length, 4);
        } else {
          assert.equal(run.status, "blocked");
          assert(!run.nativeTargetCheck);
          assert(!run.semanticReview);
          assert.equal(
            outgoing.length,
            ["bypass", "direct-final", "duplicate-preparation"].includes(
              variant,
            )
              ? 1
              : 2,
          );
        }
        assert.equal((await runtime.snapshot()).used, outgoing.length);
        if (
          ["bypass", "direct-final", "duplicate-preparation"].includes(variant)
        )
          assert.match(
            run.error,
            variant === "duplicate-preparation"
              ? /preparation requires/
              : /未注册工具/,
          );
        const report = await store.put(
          "preparation:controlled_indexed_admission",
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
        if (
          ["bypass", "direct-final", "duplicate-preparation"].includes(variant)
        )
          assert(!bundle.artifacts.some((a) => a.kind === "harness:tool"));
        if (
          ["prepared", "draft-rejected", "polluted-final"].includes(variant)
        ) {
          const prep = bundle.artifacts.find(
            (a) =>
              a.kind === "harness:tool" &&
              a.payload.name === "prepare_translation",
          );
          assert(
            prep,
            "Full draft and diagnostic must remain in the evidence graph",
          );
          assert.equal(prep.payload.value.verified, false);
          if (variant === "draft-rejected") {
            assert(!Object.hasOwn(prep.payload.args.candidate, "ambiguity"));
            assert.equal(prep.payload.value.status, "rejected");
          }
          if (variant === "polluted-final") {
            assert.match(run.error, /序列化标记/);
            assert(
              JSON.stringify(bundle).includes("DSML"),
              "Rejected raw final remains archived",
            );
          }
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
    const base = path.resolve(
      process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/math-preparation-native",
    );
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(path.join(base, "controlled-diagnostics-"));
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
