import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EvidenceStore, sha256, digest } from "../server/evidence.mjs";
import {
  mergeRoutePolicies,
  ambiguousPolicyFamilies,
  validatePolicyDecision,
  resolveSourcePolicy,
  policyAwareSummary,
  validateReportPolicy,
  policyScopeHash,
} from "../server/source-policy.mjs";
const raw = () => ({
  forbiddenDeclarations: ["Existing.mustRemain"],
  forbiddenFamilies: ["axiom", "Source.method"],
  forbiddenAxioms: ["Existing.axiom"],
});
const context = {
  pages: [
    { pageIndex: 0, text: "The proof does not use the axiom of choice." },
  ],
  supplements: [],
};
const repaired = () => ({
  status: "resolved",
  policy: { ...raw(), forbiddenFamilies: ["Source.method"] },
  resolutions: [
    {
      family: "axiom",
      interpretation: "kernel_rule",
      explanation:
        "No newly introduced axioms is already enforced by the fixed kernel audit.",
    },
  ],
  addedRestrictions: [],
  explanation: "Correct only an ambiguous reviewer syntax rule, not the paper.",
});
test("kernel-rule clarification removes no explicit declaration, axiom or genuine method family", () => {
  const next = validatePolicyDecision(repaired(), raw(), context);
  assert.deepEqual(next.policy.forbiddenAxioms, raw().forbiddenAxioms);
  assert.deepEqual(
    next.policy.forbiddenDeclarations,
    raw().forbiddenDeclarations,
  );
  assert.deepEqual(next.policy.forbiddenFamilies, ["Source.method"]);
  for (const key of [
    "forbiddenDeclarations",
    "forbiddenAxioms",
    "forbiddenFamilies",
  ]) {
    const bad = repaired();
    bad.policy[key] = [];
    assert.throws(
      () => validatePolicyDecision(bad, raw(), context),
      /explicit existing restriction/,
    );
  }
});
test("an actual source-method restriction is retained with a precise name and immutable source anchor", () => {
  const v = repaired();
  v.resolutions[0].interpretation = "source_method";
  v.policy.forbiddenAxioms.push("Classical.choice");
  v.addedRestrictions = [
    {
      family: "axiom",
      field: "forbiddenAxioms",
      name: "Classical.choice",
      anchors: [{ pageIndex: 0, quote: context.pages[0].text }],
      explanation: "Explicit source avoids choice.",
    },
  ];
  const parsed = validatePolicyDecision(v, raw(), context);
  assert(parsed.policy.forbiddenAxioms.includes("Classical.choice"));
  assert.match(
    parsed.addedRestrictions[0].anchors[0].sourceTextHash,
    /^[a-f0-9]{64}$/,
  );
  v.addedRestrictions[0].anchors[0].quote = "not in the paper";
  assert.throws(() => validatePolicyDecision(v, raw(), context));
});
test("unanchored restrictions, unresolved meta families and unrepresented method claims cannot become policy", () => {
  const a = repaired();
  a.policy.forbiddenAxioms.push("Classical.choice");
  assert.throws(
    () => validatePolicyDecision(a, raw(), context),
    /source evidence/,
  );
  const b = repaired();
  b.policy.forbiddenFamilies.push("axiom");
  assert.throws(() => validatePolicyDecision(b, raw(), context), /commands/);
  const c = repaired();
  c.resolutions[0].interpretation = "source_method";
  assert.throws(
    () => validatePolicyDecision(c, raw(), context),
    /precise names/,
  );
  assert.deepEqual(
    ambiguousPolicyFamilies({
      forbiddenFamilies: ["Classical.axiomOfChoice", "axiom"],
    }),
    ["axiom"],
  );
});
test("an unresolved policy remains conservative and cannot turn a finished kernel check into full route verification", () => {
  const p = validatePolicyDecision(
    { status: "unresolved", explanation: "Source meaning uncertain." },
    raw(),
    context,
  );
  assert.deepEqual(p.policy, raw());
  assert.equal(
    policyAwareSummary(
      { status: "verified_original", wholePaperVerified: true },
      p,
    ).status,
    "partial",
  );
  assert.equal(
    policyAwareSummary(
      { status: "verified_original", wholePaperVerified: true },
      p,
    ).wholePaperVerified,
    false,
  );
});
async function fixture(action) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-policy-unit-"));
  const store = new EvidenceStore(dir);
  await store.init();
  const source = await store.put("explicit_policy_fixture_source", {
    text: context.pages[0].text,
  });
  const contextArtifact = await store.put(
    "explicit_policy_fixture_context",
    context,
    [source],
  );
  const graph = { policy: raw(), methodClaims: [] },
    review = { policyAdditions: mergeRoutePolicies() };
  const graphArtifact = await store.put("explicit_policy_graph", { graph }, [
    source,
  ]);
  const reviewArtifact = await store.put("explicit_policy_review", { review }, [
    graphArtifact,
  ]);
  const contract = {
    sourceArtifact: source,
    targetHash: sha256("explicit-policy-fixture"),
    leanTarget: "True",
    allowedAxioms: ["propext", "Classical.choice", "Quot.sound"],
  };
  let calls = 0;
  const stage = async (role, _title, inputs, execute) => {
    const value = await execute();
    return {
      value,
      artifact: await store.put("original:" + role, value, inputs),
    };
  };
  const options = {
    store,
    contract,
    context,
    contextArtifact,
    graph,
    graphArtifact,
    review,
    reviewArtifact,
    stage,
    inputs: [source],
  };
  try {
    await action(
      options,
      () => calls,
      async () => {
        calls++;
        return { parsed: repaired(), record: { scripted: true } };
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("policy Agent decision is scoped, persisted, reused without requests and checked on replay", async () =>
  fixture(async (o, count, model) => {
    const r = await resolveSourcePolicy({ ...o, model });
    assert.equal(count(), 1);
    const cached = await resolveSourcePolicy({
      ...o,
      model,
      resume: { policyNormalization: r.normalization },
    });
    assert.equal(count(), 1);
    assert.deepEqual(cached.sourcePolicy, r.sourcePolicy);
    const receipt = await o.store.get(r.normalization.artifact);
    const saved = {
      contract: o.contract,
      context: o.context,
      contextArtifact: o.contextArtifact,
      graph: o.graph,
      graphArtifact: o.graphArtifact,
      review: o.review,
      policyNormalization: r.normalization,
      policy: r.sourcePolicy,
    };
    const root = { inputs: [receipt.id] },
      artifacts = new Map([[receipt.id, receipt]]);
    assert.deepEqual(
      validateReportPolicy(saved, root, artifacts),
      r.sourcePolicy,
    );
    assert.throws(
      () =>
        validateReportPolicy(
          { ...saved, policy: mergeRoutePolicies() },
          root,
          artifacts,
        ),
      /Effective source policy/,
    );
    assert.throws(
      () =>
        validateReportPolicy(
          {
            ...saved,
            policyNormalization: { ...r.normalization, authority: "human" },
          },
          root,
          artifacts,
        ),
      /provenance/,
    );
  }));
test("native-only continuation records an unresolved policy without asking a model", async () =>
  fixture(async (o, count, model) => {
    const r = await resolveSourcePolicy({
      ...o,
      model,
      verificationOnly: true,
    });
    assert.equal(count(), 0);
    assert.equal(r.normalization.status, "unresolved");
    assert.deepEqual(r.sourcePolicy, raw());
  }));
test("unknown policy outcomes are not silently replayed, while explicit replay is independently scoped", async () =>
  fixture(async (o, count, model) => {
    let requests = 0;
    const unknown = async () => {
      requests++;
      const e = Error("unknown fixture transport");
      e.modelRecord = {
        error: { code: "model_transport_error" },
        resource: { executionStarted: true },
        http: { status: null },
      };
      throw e;
    };
    const first = await resolveSourcePolicy({ ...o, model: unknown });
    assert.equal(requests, 1);
    assert.equal(first.normalization.unknownExternalOutcome, true);
    const stopped = await resolveSourcePolicy({
      ...o,
      model: unknown,
      resume: { policyNormalization: first.normalization },
    });
    assert.equal(requests, 1);
    assert.equal(stopped.normalization.unknownExternalOutcome, true);
    const resumed = await resolveSourcePolicy({
      ...o,
      model,
      resume: { policyNormalization: first.normalization },
      replayUnknown: true,
    });
    assert.equal(count(), 1);
    assert.equal(resumed.normalization.status, "resolved");
  }));
test("known invalid policy decisions are repaired within a bounded fresh model request", async () =>
  fixture(async (o) => {
    let requests = 0;
    const r = await resolveSourcePolicy({
      ...o,
      model: async () => ({
        parsed:
          ++requests === 1
            ? { ...repaired(), policy: mergeRoutePolicies() }
            : repaired(),
        record: { scripted: true, http: { status: 200 } },
      }),
    });
    assert.equal(requests, 2);
    assert.equal(r.normalization.status, "resolved");
  }));

test("unknown outcome survives a different reviewer policy and retains its original receipt", async () =>
  fixture(async (o, count, model) => {
    const first = await resolveSourcePolicy({
      ...o,
      model: async () => {
        const e = Error("fixture timeout");
        e.modelRecord = {
          error: { code: "model_timeout" },
          resource: { executionStarted: true },
        };
        throw e;
      },
    });
    const graph = {
      ...o.graph,
      policy: {
        ...raw(),
        forbiddenFamilies: ["axiom", "Source.method", "Another.method"],
      },
    };
    const next = await resolveSourcePolicy({
      ...o,
      graph,
      model,
      resume: { policyNormalization: first.normalization },
    });
    assert.equal(count(), 0);
    assert(next.normalization.unknownExternalOutcome);
    assert.notEqual(
      next.normalization.scopeHash,
      first.normalization.scopeHash,
    );
    assert(
      (await o.store.get(next.normalization.artifact)).inputs.includes(
        first.normalization.artifact,
      ),
    );
    assert(next.sourcePolicy.forbiddenFamilies.includes("Another.method"));
  }));
test("a process interruption after policy dispatch prevents a request before a normalization receipt exists", async () =>
  fixture(async (o, count, model) => {
    const r = await resolveSourcePolicy({
      ...o,
      model,
      resume: {
        unknownPolicyTasks: [
          {
            id: "fixture",
            inputs: [o.graphArtifact],
            externalOutcome: "unknown",
          },
        ],
      },
    });
    assert.equal(count(), 0);
    assert(r.normalization.unknownExternalOutcome);
    assert.deepEqual(r.sourcePolicy, raw());
  }));
