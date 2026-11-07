import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { PaperLedger } from "../server/paper-ledger.mjs";
import { analysisLibraryStatus } from "../server/libraries.mjs";

const exec = promisify(execFile);
test(
  "real analysis ledger: proof, negation, unknown, unresolved dependency, restart and independent CLI replay",
  { timeout: 240000 },
  async () => {
    assert.equal(
      (await analysisLibraryStatus()).ready,
      true,
      "Install the pinned library; this gate must not silently skip.",
    );
    const folder = await mkdtemp(path.join(os.tmpdir(), "lemma-ledger-real-"));
    try {
      const store = new EvidenceStore(folder),
        pipeline = new ReviewPipeline({ store, getConfig: async () => null });
      await pipeline.init();
      const ledger = new PaperLedger({ store, pipeline });
      await ledger.init();
      const cases = JSON.parse(
        await readFile(
          new URL("../fixtures/analysis-cases.json", import.meta.url),
          "utf8",
        ),
      );
      const pdf = await readFile(
          new URL("../public/analysis-fixtures.pdf", import.meta.url),
        ),
        paper = sha256(pdf);
      let view = await ledger.create(paper, {
        pdfBase64: pdf.toString("base64"),
        title: "原创实分析义务账本",
        description:
          "三类领域样本及未完成条件的机制验收，不是研究论文或原证明评审。",
      });
      const mutate = async (operation, payload) =>
        (view = await ledger.mutate(paper, {
          expectedRevision: view.revision,
          operation,
          payload,
        }));
      const settle = async (id, status) => {
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
          const run = await store.getRun(id);
          if (run.status === "blocked") assert.fail(run.error);
          if (run.status === status && !pipeline.active.has(id)) return run;
          await new Promise((r) => setTimeout(r, 40));
        }
        assert.fail("Real ledger run exceeded the expected budget");
      };
      const runs = [];
      for (const [pageIndex, item] of cases.cases.entries()) {
        const first = await pipeline.start({
          mode: "manual",
          libraryProfile: cases.libraryProfile,
          paperSha256: paper,
          pdfBase64: pdf.toString("base64"),
          pageIndex,
          proposal: item,
        });
        const pending = await settle(first.id, "awaiting_confirmation");
        await pipeline.approve(first.id, {
          targetHash: pending.contract.targetHash,
          semanticArtifact: pending.semanticArtifact,
          resolutions: pending.semanticReview.issues.map((i) => ({
            issueId: i.id,
            decision: "confirmed_with_reason",
            reason:
              "Test-only review of the explicitly authored reference statement and source.",
          })),
          confirmed: true,
          proof: item.proof,
          proofMode: item.proofMode,
        });
        const final = await settle(first.id, "completed");
        assert.equal(final.conclusion.theorem, item.expected);
        runs.push(final);
        await mutate("adopt_run", {
          runId: final.id,
          type: "claim",
          asMain: pageIndex === 0,
        });
      }
      const main = view.snapshot.entries[0].id;
      await mutate("add_entry", {
        type: "condition",
        label: "C-Icc",
        pageIndex: 0,
        quote: cases.cases[0].quote,
        statement: "原文区间与 Set.Icc 的对应尚需独立核对。",
      });
      const condition = view.snapshot.entries.at(-1).id;
      await mutate("set_dependencies", {
        entryId: main,
        dependsOn: [condition],
        reason: "登记尚未完成的语义条件，不以独立重证代替该义务",
      });
      assert.equal(view.report.items[0].state, "stale");
      await mutate("link_run", { entryId: main, runId: runs[0].id });
      assert.equal(view.report.counts.proved, 1);
      assert.equal(view.report.counts.refuted, 1);
      assert.equal(view.report.counts.unknown, 1);
      assert.equal(view.report.counts.pending, 1);
      assert.equal(view.report.mains[0].closed, false);
      assert.ok(view.report.mains[0].blockedIds.includes(condition));
      assert.equal(view.report.wholePaperVerified, false);
      const restarted = new PaperLedger({ store, pipeline });
      await restarted.init();
      assert.equal((await restarted.get(paper)).revision, view.revision);
      const bundle = await ledger.bundle(paper);
      assert.equal(bundle.pdfs.length, 1);
      assert.ok(bundle.artifacts.filter((a) => a.pdfRef).length >= 4);
      const output = new URL(
        "../evidence/capability-ledger-bundle.json",
        import.meta.url,
      );
      await writeFile(output, JSON.stringify(bundle, null, 2) + "\n");
      const { stdout } = await exec(
        process.execPath,
        [
          "scripts/replay.mjs",
          fileURLToPath(output),
          `--expected-root=${view.root}`,
        ],
        {
          cwd: new URL("../", import.meta.url),
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      const replay = JSON.parse(stdout);
      assert.equal(replay.reproduced, true);
      assert.equal(replay.reportMatched, true);
      assert.equal(replay.sourceReextracted, true);
      assert.equal(replay.results.length, 3);
      assert.equal(replay.report.counts.unknown, 1);
      assert.equal(replay.report.counts.pending, 1);
      assert.equal(replay.report.mains[0].closed, false);
      assert.equal(replay.wholePaperVerified, false);
      await writeFile(
        new URL("../evidence/capability-ledger-replay.json", import.meta.url),
        JSON.stringify(replay, null, 2) + "\n",
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
);
