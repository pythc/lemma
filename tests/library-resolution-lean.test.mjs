import test from "node:test";
import { sourceAuditFixture } from "./source-audit-fixture.mjs";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { EvidenceStore, sha256, inspectBundle } from "../server/evidence.mjs";
import { searchPremises } from "../server/premise-index.mjs";
import {
  DeepProofHarness,
  harnessModelAdapter,
} from "../server/deep-harness.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { settled } from "./domain-recovery-helpers.mjs";
import { createContract } from "../server/contracts.mjs";
import { retrieveKnowledge } from "../server/knowledge.mjs";
const testEvidence = path.resolve(
  process.env.LEMMA_TEST_EVIDENCE_DIR ||
    "evidence/library-resolution-controlled",
);
await mkdir(testEvidence, { recursive: true });
const cfg = {
  model: "explicit-controlled-library-fixture",
  maxOutputTokens: 4000,
};
const tool = (name, args, id = "fixture-call") => ({
  message: {
    content: null,
    tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
  },
  record: { scripted: true },
});
const final = (req, parsed) => {
  const submit = req.tools?.find(
    (t) => t.function?.parameters?.properties?.leanTarget,
  );
  return submit
    ? tool(submit.function.name, parsed, "fixture-submit")
    : {
        message: { content: JSON.stringify(parsed) },
        record: { scripted: true, finishReason: "stop" },
      };
};

test(
  "pinned qualified index separates real/complex log and retrieves namespace-aware constants",
  { timeout: 30000 },
  async () => {
    for (const [name, module] of [
      ["Real.log", "Mathlib.Analysis.SpecialFunctions.Log.Basic"],
      ["Complex.log", "Mathlib.Analysis.SpecialFunctions.Complex.Log"],
      ["Nat.Prime", "Mathlib.Data.Nat.Prime.Defs"],
      ["Finset.range", "Mathlib.Data.Finset.Range"],
      ["Continuous", "Mathlib.Topology.Defs.Basic"],
    ]) {
      const r = await searchPremises([name], { limit: 2 });
      assert.equal(r.matches[0].name, name);
      assert.equal(r.matches[0].module, module);
      assert.equal(r.matches[0].matchKind, "exact_full_name");
      assert.equal(
        r.matches[0].availableInCurrentEnvironment,
        "not_established",
      );
    }
  },
);

test(
  "actual SDK module lookup imports declarations, preserves syntax errors and accepts known legacy profile IDs",
  { timeout: 180000 },
  async () => {
    const dir = await mkdtemp(path.join(testEvidence, "library-stage-")),
      store = new EvidenceStore(dir);
    await store.init();
    const text = "Controlled declaration inspection fixture only.",
      paperSha256 = sha256(text),
      sourceArtifact = await store.put("fixture_source", {
        paperSha256,
        pages: [{ index: 0, text }],
      });
    let step = 0;
    const results = [];
    const h = new DeepProofHarness({
      store,
      model: async (_config, req) => {
        step++;
        const last = req.messages.filter((m) => m.role === "tool").at(-1);
        if (last) {
          results.push(JSON.parse(last.content));
          await writeFile(
            path.join(testEvidence, "native-inspection-attempt.json"),
            JSON.stringify(
              { classification: "controlled_fixture_tool_replies", results },
              null,
              2,
            ),
          );
        }
        if (step === 1)
          return tool("inspect_modules", {
            profileId: "std-v1",
            names: ["Real.log", "Real.log_exp"],
            target: "∀ x : ℝ, Real.log (Real.exp x) = x",
          });
        if (step === 2) {
          assert.equal(
            results.at(-1).status,
            "well_typed",
            JSON.stringify(results.at(-1)),
          );
          assert(
            results
              .at(-1)
              .modules.some(
                (m) => m.name === "Mathlib.Analysis.SpecialFunctions.Log.Basic",
              ),
          );
          assert(
            results.at(-1).declarations.every((d) => d.verifiedInEnvironment),
            JSON.stringify(results.at(-1)),
          );
          return tool("inspect_modules", {
            names: ["Nat.add_comm"],
            target: "∀ n : Nat,",
          });
        }
        if (step === 3) {
          assert.equal(results.at(-1).status, "not_well_typed");
          assert.equal(results.at(-1).stage, "syntax");
          assert.equal(results.at(-1).parser.exitCode, 1);
          assert.equal(results.at(-1).exitCode, null);
          return tool("inspect_modules", {
            libraryIds: ["number-combinatorics-v1"],
            names: ["Nat.Prime", "Continuous"],
            target: "True",
          });
        }
        if (step === 4) {
          assert.equal(results.at(-1).status, "well_typed");
          assert.equal(results.at(-1).profileId, "number-combinatorics-v1");
          assert(
            results.at(-1).declarations.every((d) => d.verifiedInEnvironment),
          );
          assert.equal(
            results.at(-1).notices[0].code,
            "legacy_profile_parameter_normalized",
          );
          return final(req, { completed: true });
        }
        throw Error("Unexpected extra model call");
      },
    });
    try {
      const r = await h.run({
        config: cfg,
        goal: "Exercise native library and syntax result variants; no paper verification claimed.",
        toolProfile: "review",
        inputs: [sourceArtifact],
        taskContext: {
          sourceIdentity: { paperSha256, sourceArtifact },
          input: {
            context: {
              paperSha256,
              pages: [{ pageIndex: 0, text }],
              supplements: [],
            },
          },
        },
      });
      const bundle = await store.bundle(r.record.harnessRoot);
      inspectBundle(bundle, r.record.harnessRoot);
      assert.equal(
        bundle.artifacts.filter((a) => a.kind === "harness:tool").length,
        3,
      );
      assert.equal(
        bundle.artifacts.filter((a) => a.kind === "harness:tool_failure")
          .length,
        0,
      );
      const out = testEvidence;
      await mkdir(out, { recursive: true });
      await writeFile(
        path.join(out, "native-inspection.json"),
        JSON.stringify(
          {
            classification:
              "controlled_sdk_native_plumbing_not_autonomous_paper_proof",
            results,
            root: r.record.harnessRoot,
            bundle,
          },
          null,
          2,
        ),
      );
    } finally {
      await h.close();
      // Keep both successful and failed native stores for reproducibility.
    }
  },
);

test(
  "prepared translation imports reach the fixed contract, real Lean proof and independent replay",
  { timeout: 480000 },
  async () => {
    const dir = await mkdtemp(path.join(testEvidence, "library-translation-")),
      store = new EvidenceStore(dir);
    await store.init();
    const quote = "Theorem: for every real x, log(exp(x)) equals x.",
      target = "∀ x : ℝ, Real.log (Real.exp x) = x";
    const categories = [
      "variables",
      "quantifiers",
      "domain",
      "assumptions",
      "conclusion",
      "definitions",
    ];
    let stage = 0,
      selected;
    const invoke = async (_config, req) => {
      if (req.role === "HARNESS_TOOL_MODEL") {
        stage++;
        if (stage % 2 === 1)
          return tool("inspect_modules", {
            profileId: "std-v1",
            names: ["Real.log", "Real.log_exp"],
            target,
          });
        const result = JSON.parse(
          req.messages.filter((m) => m.role === "tool").at(-1).content,
        );
        assert.equal(result.status, "well_typed");
        selected = result.preparationArtifact;
        return final(req, {
          label: "controlled identity fixture",
          quote,
          statement: "The real logarithm of exp(x) is x.",
          assumptions: [],
          leanTarget: target,
          ambiguity: "",
          moduleReceiptIds: [selected],
          alignment: categories.map((category) => ({
            category,
            explanation: "Controlled semantic fixture only.",
            leanFragment: "Real.log",
            anchors: [{ pageIndex: 0, quote }],
          })),
        });
      }
      if (req.role === "R04") {
        assert(
          req.input.libraryDefinitions.some(
            (d) =>
              d.name === "Real.log" &&
              typeof d.signature === "string" &&
              d.signature.includes("Real.log"),
          ),
          JSON.stringify(req.input.libraryDefinitions),
        );
        return {
          parsed: {
            targetHash: req.input.contract.targetHash,
            ...(["lemma.source-audit.v4", "lemma.source-audit.v5"].includes(
              req.input.context?.semanticProtocol,
            )
              ? { findings: [] }
              : {}),
            ...(req.input.stage
              ? {}
              : {
                  sourceAudit: sourceAuditFixture(
                    req.input.contract,
                    req.input.targetStructure,
                    req.input.context.semanticProtocol,
                  ),
                }),
            backTranslation: "For each real x, log(exp x)=x.",
            checks: categories.map((category) => ({
              category,
              status: "aligned",
              explanation:
                "Controlled source attestation, not an autonomous review.",
              anchors: [{ pageIndex: 0, quote }],
            })),
          },
          record: { scripted: true },
        };
      }
      if (req.role === "R06")
        return {
          parsed: {
            status: "unchecked",
            quote: "",
            explanation: "This is an independent proof plumbing fixture.",
          },
          record: { scripted: true },
        };
      if (req.role === "R09")
        return {
          parsed: {
            mode: "proof",
            proof: "by intro x; exact Real.log_exp x",
            route: "independent",
            explanation: "Explicit controlled proof fixture.",
          },
          record: { scripted: true },
        };
      throw Error("Unexpected role " + req.role);
    };
    const h = new DeepProofHarness({ store, model: invoke });
    const p = new ReviewPipeline({
      store,
      model: harnessModelAdapter({ store, harness: h, model: invoke }),
      getConfig: async () => cfg,
    });
    try {
      await p.init();
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.TimesRoman);
      pdf.addPage().drawText(quote, { font, size: 10, x: 20, y: 700 });
      const bytes = Buffer.from(await pdf.save());
      let r = await settled(
        p,
        (
          await p.start({
            pdfBase64: bytes.toString("base64"),
            paperSha256: sha256(bytes),
            pageIndex: 0,
            mode: "model",
            libraryProfile: "std-v1",
          })
        ).id,
        180000,
      );
      assert.equal(r.status, "awaiting_confirmation", r.error);
      assert.equal(r.semanticReview.targetCheck.status, "well_typed");
      const nativeKnowledge = (
        await store.get(r.tasks.find((t) => t.role === "R04K").output)
      ).payload;
      assert(
        nativeKnowledge.entries.some(
          (d) => d.name === "Real.log" && d.verifiedInEnvironment,
        ),
      );
      assert(
        r.contract.imports.includes(
          "Mathlib.Analysis.SpecialFunctions.Log.Basic",
        ),
      );
      assert.equal(r.contract.leanTarget, target);
      assert.equal(r.contract.domainContext.definitions.length, 0);
      assert.equal(r.contract.domainContext.lemmas.length, 0);
      const initial = r;
      r = await settled(
        p,
        (await p.retryTranslation(r.id, { reviseTarget: true })).id,
        180000,
      );
      assert.equal(r.status, "awaiting_confirmation", r.error);
      assert.equal(r.contract.leanTarget, target);
      assert.notEqual(
        r.contract.domainArtifact,
        initial.contract.domainArtifact,
      );
      assert(
        r.contract.imports.includes(
          "Mathlib.Analysis.SpecialFunctions.Log.Basic",
        ),
      );
      await p.approve(r.id, {
        confirmed: true,
        targetHash: r.contract.targetHash,
        semanticArtifact: r.semanticArtifact,
        resolutions: r.semanticReview.issues.map((i) => ({
          issueId: i.id,
          decision: "confirmed_with_reason",
          reason: "Controlled fixture only; not paper acceptance.",
        })),
        proofMode: "proof",
      });
      r = await settled(p, r.id, 120000);
      assert.equal(r.check?.status, "verified", r.error);
      const bundle = await store.bundle(r.root);
      inspectBundle(bundle, r.root);
      assert(bundle.artifacts.some((a) => a.id === selected));
      const preflightOut = testEvidence;
      await writeFile(
        path.join(preflightOut, "native-translation-before-replay.json"),
        JSON.stringify(
          { contract: r.contract, check: r.check, root: r.root, bundle },
          null,
          2,
        ),
      );
      const replay = await p.replay(bundle, r.root);
      assert.equal(replay.reproduced, true, JSON.stringify(replay));
      const out = testEvidence;
      await writeFile(
        path.join(out, "native-translation-import-closure.json"),
        JSON.stringify(
          {
            classification:
              "controlled_sdk_native_proof_and_replay_not_autonomous_paper_success",
            contract: r.contract,
            check: r.check,
            replay,
            root: r.root,
            bundle,
          },
          null,
          2,
        ),
      );
    } finally {
      await h.close();
      // Keep both successful and failed native stores for reproducibility.
    }
  },
);

test(
  "global definitions are read from the actual imported environment, not limited to an authored profile catalog",
  { timeout: 120000 },
  async () => {
    const quote = "For real functions, continuity implies continuity.";
    const c = createContract(
      {
        paperSha256: sha256(quote),
        artifact: sha256("controlled global source"),
        pageIndex: 0,
        text: quote,
      },
      {
        label: "global definition fixture",
        quote,
        statement: quote,
        assumptions: [],
        leanTarget: "∀ f : ℝ → ℝ, Continuous f → Continuous f",
      },
      "analysis-continuity-v1",
    );
    const result = await retrieveKnowledge(c);
    await writeFile(
      path.join(testEvidence, "global-definition-raw.json"),
      JSON.stringify({ contract: c, result }, null, 2),
    );
    const continuous = result.entries.find((e) => e.name === "Continuous");
    assert(continuous, JSON.stringify(result));
    assert.equal(continuous.verifiedInEnvironment, true);
    assert.equal(
      continuous.guidanceAuthority,
      "pinned_source_and_native_signature_only",
    );
    assert.match(continuous.signature, /Continuous/);
    await writeFile(
      path.join(testEvidence, "global-definition-inspection.json"),
      JSON.stringify(
        {
          classification:
            "controlled_native_definition_lookup_not_theorem_proof",
          contract: c,
          result,
        },
        null,
        2,
      ),
    );
  },
);
