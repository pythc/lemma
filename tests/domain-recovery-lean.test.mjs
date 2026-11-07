import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { EvidenceStore } from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";
import { validateDomainPlan } from "../server/domain-schema.mjs";
import {
  moduleManifest,
  ensureDomainModules,
  searchMathlib,
} from "../server/domain-library.mjs";
import { checkProof } from "../server/lean.mjs";
import { inspectTarget } from "../server/lean-query.mjs";
import { MATHLIB_COMMIT } from "../shared/library-profiles.mjs";
import {
  plan,
  input,
  settled,
  approval,
  quote,
  proposal,
  fixtureModel,
} from "./domain-recovery-helpers.mjs";
const dir = new URL("../evidence/domain-expansion-20261017/", import.meta.url);
await mkdir(dir, { recursive: true });
const record = async (name, data) =>
  writeFile(new URL(name + ".json", dir), JSON.stringify(data, null, 2) + "\n");
const fixed = {
  paperSha256: "a".repeat(64),
  artifact: "b".repeat(64),
  pageIndex: 0,
  text: quote,
};
const provenance = {
  contextArtifact: "c".repeat(64),
  translationArtifact: "d".repeat(64),
};
const ctx = () => {
  const p = validateDomainPlan(plan(), {
    pages: [{ pageIndex: 0, text: quote }],
    supplements: [],
  });
  return {
    schemaVersion: "lemma.domain.v1",
    revision: MATHLIB_COMMIT,
    modules: [],
    definitions: p.definitions,
    lemmas: p.lemmas,
  };
};
const contract = (context, target = proposal.leanTarget) =>
  createContract(
    fixed,
    { ...proposal, leanTarget: target },
    "std-v1",
    provenance,
    { context, artifact: "e".repeat(64) },
  );

test(
  "real Lean checks paper definitions, transitive lemmas, fresh confirmation and complete replay",
  { timeout: 240000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lemma-domain-real-"));
    const p = new ReviewPipeline({
      store: new EvidenceStore(root),
      getConfig: async () => null,
    });
    try {
      await p.init();
      const old = await settled(p, (await p.start(await input())).id, 60000);
      assert.equal(old.semanticReview.targetCheck.status, "not_well_typed");
      const run = await settled(
        p,
        (await p.recoverDomain(old.id, { mode: "manual", plan: plan() })).id,
        120000,
      );
      assert.equal(run.status, "awaiting_confirmation", run.error);
      assert.equal(run.semanticReview.targetCheck.status, "well_typed");
      await p.approve(run.id, approval(run));
      const done = await settled(p, run.id, 60000);
      assert.equal(done.check.status, "verified", JSON.stringify(done.check));
      const bundle = await p.store.bundle(done.root);
      const replay = await p.replay(bundle, bundle.root);
      assert.equal(replay.reproduced, true);
      assert.equal(replay.domainChecks.length, 3);
      await record("definition-lemma-replay", {
        origin: "constructed_fixture_with_real_lean_not_research_paper",
        run: done,
        replay,
        bundle,
      });
    } finally {
      for (const c of p.active.values()) c.abort();
      while (p.active.size) await new Promise((r) => setTimeout(r, 50));
      await rm(root, { recursive: true, force: true });
    }
  },
);
test(
  "real Lean rejects injected declarations, wrong definition types and false auxiliary lemmas",
  { timeout: 120000 },
  async () => {
    const cases = [];
    const wrongType = ctx();
    wrongType.definitions[0].value = "true";
    wrongType.lemmas = [];
    cases.push(await inspectTarget(contract(wrongType)));
    const injection = ctx();
    injection.definitions[0].value =
      "fun n => n)\ntheorem injected : True := by trivial\ndef injected2 := (0";
    injection.lemmas = [];
    cases.push(await inspectTarget(contract(injection)));
    const falseLemma = ctx();
    falseLemma.lemmas[0].target = "False";
    falseLemma.lemmas[0].proof = "by trivial";
    falseLemma.lemmas = falseLemma.lemmas.slice(0, 1);
    cases.push(
      await checkProof(contract(falseLemma), "by exact LemmaPaper.ShiftZero"),
    );
    for (const result of cases)
      assert.ok(
        !["well_typed", "verified"].includes(result.status),
        JSON.stringify(result),
      );
    await record("rejections", cases);
    const choice = ctx();
    choice.definitions[0].value =
      "fun n => Classical.choose (show ∃ m : Nat, m = n from ⟨n, rfl⟩)";
    choice.lemmas = [];
    const noncomputable = await checkProof(
      contract(choice),
      "by intro n; exact Classical.choose_spec (show ∃ m : Nat, m = n from ⟨n, rfl⟩)",
    );
    assert.equal(
      noncomputable.status,
      "verified",
      JSON.stringify(noncomputable),
    );
    assert.ok(
      noncomputable.axioms.every((a) =>
        ["propext", "Classical.choice", "Quot.sound"].includes(a),
      ),
    );
    await record("noncomputable-definition", noncomputable);
  },
);
test(
  "real full-library search and extra pinned module provide an actual theorem",
  { timeout: 120000 },
  async () => {
    const search = await searchMathlib(["exists_infinite_primes"]);
    assert.ok(
      search.matches.some(
        (m) => m.module === "Mathlib.Data.Nat.Prime.Infinite",
      ),
    );
    const context = {
      ...ctx(),
      definitions: [],
      lemmas: [],
      modules: await moduleManifest(["Mathlib.Data.Nat.Prime.Infinite"]),
    };
    const acquisition = await ensureDomainModules(context.modules, {
      acquire: false,
    });
    const c = contract(context, "∀ n : Nat, ∃ p, n ≤ p ∧ Nat.Prime p");
    const type = await inspectTarget(c, {
      names: ["Nat.exists_infinite_primes"],
    });
    assert.equal(type.status, "well_typed", JSON.stringify(type));
    const checked = await checkProof(c, "by exact Nat.exists_infinite_primes");
    assert.equal(checked.status, "verified", JSON.stringify(checked));
    await record("full-library-module", {
      search,
      acquisition,
      contract: c,
      type,
      checked,
    });
  },
);

test(
  "real Lean diagnostics drive controlled definition and helper repairs before fresh semantic review",
  { timeout: 180000 },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "lemma-domain-repair-real-"),
    );
    const calls = [];
    const p = new ReviewPipeline({
      store: new EvidenceStore(root),
      getConfig: async () => ({ model: "controlled-fixture" }),
      model: async (config, req) => {
        calls.push(req);
        return fixtureModel(config, req);
      },
    });
    try {
      await p.init();
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
        explanation: "Controlled fixture alignment only.",
        leanFragment: "n",
        anchors: [{ pageIndex: 0, quote }],
      }));
      const old = await settled(p, (await p.start(start)).id, 60000);
      const v = plan();
      v.definitions[0].value = "true";
      v.lemmas = v.lemmas.slice(0, 1);
      v.lemmas[0].proof = "by rfl";
      const r = await settled(
        p,
        (await p.recoverDomain(old.id, { mode: "model", plan: v })).id,
        120000,
      );
      assert.equal(r.status, "awaiting_confirmation", r.error);
      assert.deepEqual(
        r.domainRecovery.components.map((c) => c.attempts.length),
        [2, 2],
      );
      assert.match(
        calls.find((c) => c.role === "RDDF").input.previous.diagnostic.message,
        /Bool|type mismatch/,
      );
      assert.match(
        calls.find((c) => c.role === "RDLP").input.previous.diagnostic.message,
        /rfl|unsolved|tactic/,
      );
      assert.equal(r.approval, null);
      await record("controlled-repair-real-lean", {
        note: "Controlled model responses; actual Lean failures and repaired checks. Human semantic confirmation still required.",
        run: r,
        bundle: await p.store.bundle(r.root),
      });
    } finally {
      for (const c of p.active.values()) c.abort();
      while (p.active.size) await new Promise((r) => setTimeout(r, 50));
      await rm(root, { recursive: true, force: true });
    }
  },
);
