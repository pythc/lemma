import test from "node:test";
import { sourceAuditFixture } from "./source-audit-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createApp } from "../server/index.mjs";
import { sha256 } from "../server/evidence.mjs";
const quote =
  "Theorem: adding zero once or twice leaves every natural number unchanged.";
const target = "(∀ n : Nat, n + 0 = n) ∧ (∀ n : Nat, (n + 0) + 0 = n)";
const categories = [
  "variables",
  "quantifiers",
  "domain",
  "assumptions",
  "conclusion",
  "definitions",
];
test(
  "HTTP review exposes helper evidence, accepts only the original root and replays the complete composed proof",
  { timeout: 180000 },
  async () => {
    const folder = await mkdtemp(
      path.join(os.tmpdir(), "lemma-decomposition-http-"),
    );
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman);
    pdf.addPage().drawText(quote, { x: 20, y: 700, font, size: 10 });
    const bytes = Buffer.from(await pdf.save());
    const model = async (_c, r) => {
      let parsed;
      if (r.role === "R03")
        parsed = {
          label: "Authored fixture",
          quote,
          statement: "Two elementary identities",
          assumptions: [],
          leanTarget: target,
          ambiguity: "",
          alignment: categories.map((category) => ({
            category,
            explanation: "authored execution fixture",
            leanFragment: target,
            anchors: [{ pageIndex: 0, quote }],
          })),
        };
      else if (r.role === "R04")
        parsed = {
          targetHash: r.input.contract.targetHash,
          ...(["lemma.source-audit.v4", "lemma.source-audit.v5"].includes(
            r.input.context?.semanticProtocol,
          )
            ? { findings: [] }
            : {}),
          ...(r.input.stage
            ? {}
            : {
                sourceAudit: sourceAuditFixture(
                  r.input.contract,
                  r.input.targetStructure,
                  r.input.context.semanticProtocol,
                ),
              }),
          backTranslation: "Authored identities, not a paper",
          checks: categories.map((category) => ({
            category,
            status: "aligned",
            explanation: "controlled fixture",
            anchors: [{ pageIndex: 0, quote }],
          })),
        };
      else if (r.role === "R06")
        parsed = {
          status: "unchecked",
          quote: "",
          explanation: "No original-paper certification",
        };
      else if (r.role === "R09_DECOMPOSE")
        parsed = {
          parts: [
            {
              name: "Zero",
              target: "∀ n : Nat, n + 0 = n",
              purpose: "first identity",
              dependsOn: [],
              proof: "by intro n; rfl",
            },
            {
              name: "Twice",
              target: "∀ n : Nat, (n + 0) + 0 = n",
              purpose: "use first identity",
              dependsOn: ["Zero"],
              proof:
                "by intro ProofPart_Zero n; exact (ProofPart_Zero (n + 0)).trans (ProofPart_Zero n)",
            },
          ],
          assembly:
            "by intro ProofPart_Zero ProofPart_Twice; exact ⟨ProofPart_Zero, ProofPart_Twice⟩",
        };
      else if (r.role === "R09")
        parsed = { unavailable: "controlled decomposition route" };
      else throw Error(`Unexpected fixture request ${r.role}`);
      return {
        parsed,
        record: {
          provider: "controlled_http_fixture_no_external_model",
          role: r.role,
        },
      };
    };
    const app = await createApp({
      dataRoot: folder,
      model,
      configProvider: async () => ({ model: "controlled_fixture" }),
      provingOptions: {
        capabilities: async () => ({ ready: false }),
        specialistAvailable: async () => ({ ready: false }),
        budget: {
          maxModelCalls: 6,
          maxTacticSteps: 0,
          maxDecompositionPlans: 1,
        },
      },
    });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (url, body) => {
      const r = await fetch(
        base + url,
        body
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }
          : {},
      );
      const value = await r.json();
      assert.ok(r.ok, JSON.stringify(value));
      return value;
    };
    const settled = async (id, status) => {
      const end = Date.now() + 150000;
      while (Date.now() < end) {
        const r = await call(`/api/reviews/${id}`);
        if (r.status === status && !app.pipeline.active.has(id)) return r;
        if (r.status === "blocked") assert.fail(r.error);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw Error("HTTP fixture timed out");
    };
    try {
      const first = await call("/api/reviews", {
        mode: "model",
        pdfBase64: bytes.toString("base64"),
        paperSha256: sha256(bytes),
        pageIndex: 0,
        libraryProfile: "std-v1",
      });
      const draft = await settled(first.id, "awaiting_confirmation");
      await call(`/api/reviews/${draft.id}/approve`, {
        confirmed: true,
        targetHash: draft.contract.targetHash,
        semanticArtifact: draft.semanticArtifact,
        proofMode: "proof",
        resolutions: draft.semanticReview.issues.map((i) => ({
          issueId: i.id,
          decision: "confirmed_with_reason",
          reason:
            "Controlled fixture attestation of exact authored identities; no real paper.",
        })),
      });
      const final = await settled(first.id, "completed");
      assert.equal(final.check.status, "verified");
      assert.equal(final.check.targetHash, draft.contract.targetHash);
      assert.equal(final.conclusion.theorem, "formalized_proved");
      const connection = final.tasks.find((t) => t.role === "R09DC"),
        helpers = final.tasks.filter((t) => t.role === "R09HC");
      assert.ok(connection);
      assert.equal(helpers.length, 2);
      assert.match(connection.reason, /不代表/);
      assert.ok(connection.summary.includes("仍须"));
      for (const t of [connection, ...helpers]) {
        const a = await call(`/api/artifacts/${t.output}`);
        assert.notEqual(a.payload.targetHash, final.check.targetHash);
      }
      const bundle = await call(`/api/reviews/${final.id}/bundle`),
        replay = await app.pipeline.replay(bundle, bundle.root);
      assert.equal(replay.revalidated, true);
      assert.equal(replay.conclusion.theorem, "formalized_proved");
      await mkdir("evidence", { recursive: true });
      const evidenceDir =
        process.env.LEMMA_TEST_EVIDENCE_DIR ||
        (await mkdtemp("evidence/decomposition-http-"));
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(
        path.join(evidenceDir, "http-review-replay.json"),
        JSON.stringify(
          {
            classification:
              "authored_http_execution_fixture_not_paper_accuracy",
            run: final,
            bundle,
            replay,
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
    } finally {
      for (const controller of app.pipeline.active.values()) controller.abort();
      while (app.pipeline.active.size)
        await new Promise((r) => setTimeout(r, 50));
      await app.adaptive.close();
      await new Promise((r) => app.server.close(r));
      await rm(folder, { recursive: true, force: true });
    }
  },
);
