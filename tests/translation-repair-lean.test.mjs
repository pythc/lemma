import test from "node:test";
import { sourceAuditFixture } from "./source-audit-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { EvidenceStore, sha256, digest } from "../server/evidence.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { ALIGNMENT_CATEGORIES } from "../server/semantics.mjs";

test(
  "native syntax rejection drives a new source-preserving translation, not endless reinspection",
  { timeout: 180000 },
  async () => {
    const dir = await mkdtemp(
        path.join(os.tmpdir(), "lemma-target-repair-native-"),
      ),
      store = new EvidenceStore(dir);
    const quote = "Every natural number plus zero equals itself.";
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman);
    pdf.addPage().drawText(quote, { x: 30, y: 700, font, size: 11 });
    const bytes = Buffer.from(await pdf.save());
    const proposal = {
      label: "controlled fixture",
      quote,
      statement: quote,
      assumptions: [],
      leanTarget: "∀ n : Nat, n + 0 = n",
      ambiguity: "",
      alignment: ALIGNMENT_CATEGORIES.map((category) => ({
        category,
        leanFragment: "n",
        explanation: "Explicit scripted semantic fixture",
        anchors: [{ pageIndex: 0, quote }],
      })),
    };
    let repairs = 0;
    const p = new ReviewPipeline({
      store,
      getConfig: async () => ({ model: "scripted-native-only" }),
      knowledge: async () => ({ entries: [] }),
      model: async (_cfg, r) => {
        let parsed;
        if (r.role === "R03")
          parsed = { ...proposal, leanTarget: "∀ n : Nat, (n + 0 = n" };
        else if (r.role === "R03_TARGET_REPAIR") {
          repairs++;
          assert.equal(
            r.input.previousNativeTargetCheck.status,
            "not_well_typed",
          );
          assert.match(
            r.input.previousNativeTargetCheck.parser.stderr,
            /Target\.txt.*expected/s,
          );
          assert.equal(r.input.selectedQuote, quote);
          parsed = proposal;
        } else if (r.role === "R04")
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
            backTranslation: quote,
            checks: ALIGNMENT_CATEGORIES.map((category) => ({
              category,
              status: "aligned",
              explanation:
                "Explicit independent scripted mapping, not model accuracy",
              anchors: [{ pageIndex: 0, quote }],
            })),
          };
        else throw Error("Unexpected fixture role " + r.role);
        return {
          parsed,
          record: { provider: "scripted-test-only", role: r.role },
        };
      },
    });
    const settle = async (id) => {
      const until = Date.now() + 150000;
      while (p.active.has(id) && Date.now() < until)
        await new Promise((r) => setTimeout(r, 20));
      assert(!p.active.has(id));
      return store.getRun(id);
    };
    try {
      await p.init();
      const first = await settle(
          (
            await p.start({
              pdfBase64: bytes.toString("base64"),
              paperSha256: sha256(bytes),
              pageIndex: 0,
              mode: "model",
              libraryProfile: "std-v1",
            })
          ).id,
        ),
        before = digest(first);
      assert.equal(first.nativeTargetCheck.status, "not_well_typed");
      const next = await settle(
        (
          await p.retryTranslation(first.id, {
            reviseTarget: true,
            repairAlignment: true,
            repairFeedback: "Repair the received native syntax diagnostic",
          })
        ).id,
      );
      assert.equal(next.status, "awaiting_confirmation", next.error);
      assert.equal(next.semanticReview.targetCheck.status, "well_typed");
      assert.equal(next.contract.leanTarget, proposal.leanTarget);
      assert.equal(next.contract.sourceArtifact, first.contract.sourceArtifact);
      assert.deepEqual(next.autonomy, first.autonomy);
      assert.equal(next.approval, null);
      assert.equal(
        next.check,
        undefined,
        "type acceptance is not a theorem proof",
      );
      assert.equal(repairs, 1);
      assert.equal(digest(await store.getRun(first.id)), before);
    } finally {
      for (const c of p.active.values()) c.abort();
      while (p.active.size) await new Promise((r) => setTimeout(r, 20));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
