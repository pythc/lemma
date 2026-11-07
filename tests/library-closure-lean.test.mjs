import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { ProvingEngine } from "../server/proving-engine.mjs";
import { EvidenceStore } from "../server/evidence.mjs";
import { searchPremises } from "../server/premise-index.mjs";
import {
  plan,
  input,
  settled,
  approval,
  quote,
  fixtureModel,
} from "./domain-recovery-helpers.mjs";

test(
  "pinned declaration index retrieves the real compact subsequence module",
  { timeout: 60000 },
  async () => {
    const result = await searchPremises(
      ["Function.isSeqCompact", "isSeqCompact"],
      {
        target:
          "IsCompact (Set.Icc (-M) M) ∧ StrictMono φ ∧ Filter.Tendsto (x ∘ φ) Filter.atTop (nhds a)",
        limit: 8,
      },
    );
    assert.ok(
      result.matches.some(
        (match) =>
          match.name === "IsCompact.isSeqCompact" &&
          match.module === "Mathlib.Topology.Sequences",
      ),
    );
    assert.ok(
      result.matches.every(
        (match) =>
          match.sourceSha256 &&
          match.availableInCurrentEnvironment === "not_established",
      ),
    );
  },
);
test(
  "real shared Lean service proves helper DAG then the main goal and replays the complete evidence",
  { timeout: 360000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "lemma-library-closure-"),
    );
    const store = new EvidenceStore(directory);
    const model = async (config, request) => {
      if (request.role === "R06")
        return {
          parsed: {
            status: "unchecked",
            quote: "",
            explanation: "Authored fixture, no original-paper audit claimed.",
          },
          record: { provider: "controlled_fixture", role: "R06" },
        };
      if (
        request.role === "RDLP" ||
        request.role === "R09" ||
        request.role === "R09_TACTIC"
      )
        throw Error(
          "The controlled target must be solved by actual local Lean search",
        );
      return fixtureModel(config, request);
    };
    const pipeline = new ReviewPipeline({
      store,
      getConfig: async () => ({ model: "controlled_fixture" }),
      model,
      prover: new ProvingEngine({ model }),
      provingBudget: { maxModelCalls: 0 },
    });
    try {
      await pipeline.init();
      const start = await input();
      start.proposal.alignment = [
        "variables",
        "quantifiers",
        "domain",
        "assumptions",
        "conclusion",
        "definitions",
      ].map((category) => ({
        category,
        explanation: "Authored fixture",
        leanFragment: "n",
        anchors: [{ pageIndex: 0, quote }],
      }));
      const previous = await settled(
        pipeline,
        (await pipeline.start(start)).id,
        60000,
      );
      const supplement = plan();
      for (const lemma of supplement.lemmas) delete lemma.proof;
      const prepared = await settled(
        pipeline,
        (
          await pipeline.recoverDomain(previous.id, {
            mode: "model",
            plan: supplement,
          })
        ).id,
        240000,
      );
      assert.equal(prepared.status, "awaiting_confirmation", prepared.error);
      assert.equal(prepared.approval, null);
      assert.ok(
        prepared.domainRecovery.components
          .filter((c) => c.kind === "lemma")
          .every((c) => c.provingSearch.stopReason === "verified"),
      );
      await pipeline.approve(prepared.id, approval(prepared));
      const completed = await settled(pipeline, prepared.id, 240000);
      assert.equal(completed.check?.status, "verified", completed.error);
      const bundle = await store.bundle(completed.root),
        replay = await pipeline.replay(bundle, completed.root);
      assert.equal(replay.revalidated, true);
      const output = path.join(
        process.cwd(),
        "evidence/library-closure-20261019",
      );
      await mkdir(output, { recursive: true });
      await writeFile(
        path.join(output, "shared-helper-dag-real-lean.json"),
        JSON.stringify(
          {
            classification: "authored_execution_fixture_not_paper_accuracy",
            run: completed,
            bundle,
            replay,
          },
          null,
          2,
        ),
      );
    } finally {
      for (const controller of pipeline.active.values()) controller.abort();
      while (pipeline.active.size)
        await new Promise((resolve) => setTimeout(resolve, 20));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
