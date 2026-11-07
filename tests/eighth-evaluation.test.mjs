import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  semanticRegistration,
  registeredSemanticGuard,
  validateSemanticDataset,
  SEMANTIC_THRESHOLDS,
  EVALUATION_CODE_PATHS,
} from "../server/evaluation-registration.mjs";
import {
  evaluationTimeline,
  evaluationClosure,
  evaluationRecordBinding,
} from "../server/evaluation-report.mjs";
import {
  nativeInspectionFailure,
  inspectionErrorKind,
} from "../server/inspection-diagnostic.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { EvidenceStore, sha256, digest } from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";
import { randomUUID } from "node:crypto";

test("resource interruption is unknown, keeps the target and stops before semantic calls", async () => {
  const failure = {
    exitCode: null,
    termination: "signal:SIGABRT",
    stderr: "lean::memory_exception: excessive memory consumption",
  };
  assert.equal(nativeInspectionFailure(failure), "native_resource_exhausted");
  assert.equal(
    inspectionErrorKind({ status: "tool_unavailable", ...failure }),
    "native_resource_exhausted",
  );
  assert.equal(
    nativeInspectionFailure({ exitCode: null, termination: "timeout" }),
    "native_execution_interrupted",
  );
  assert.equal(
    nativeInspectionFailure({
      exitCode: 1,
      stderr: "unknown identifier",
      source: "memory_exception",
    }),
    null,
  );
  const base = path.resolve(
    process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/eighth-test-records",
  );
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "resource-")),
    store = new EvidenceStore(dir);
  await store.init();
  const quote = "Every natural number n equals itself.";
  const source = {
    text: quote,
    pageIndex: 0,
    paperSha256: sha256(quote),
    artifact: sha256("fixture"),
  };
  const contract = createContract(
    source,
    {
      label: "resource fixture",
      quote,
      statement: quote,
      assumptions: [],
      leanTarget: "∀ n : Nat, n = n",
    },
    "std-v1",
  );
  const run = {
    id: randomUUID(),
    mode: "model",
    status: "running",
    contract,
    context: {
      paperSha256: source.paperSha256,
      pages: [{ pageIndex: 0, text: quote }],
      supplements: [],
    },
    tasks: [],
  };
  run.contractArtifact = await store.put("task:R05", contract);
  let calls = 0;
  const pipeline = new ReviewPipeline({
    store,
    model: async () => {
      calls++;
      throw Error("Must not dispatch");
    },
    targetChecker: async () => ({
      status: "tool_unavailable",
      failureKind: "native_resource_exhausted",
      ...failure,
    }),
  });
  const alignment = [
    "variables",
    "quantifiers",
    "domain",
    "assumptions",
    "conclusion",
    "definitions",
  ].map((category) => ({
    category,
    explanation: "Controlled fixture",
    leanFragment: "n",
    anchors: [{ pageIndex: 0, quote }],
  }));
  await assert.rejects(
    pipeline.reviewTranslation(
      run,
      { proposal: { alignment } },
      {},
      new AbortController(),
    ),
    (e) => e.recoveryStop === "native_environment_unavailable",
  );
  assert.equal(calls, 0);
  assert.equal(run.pendingObligations[0].type, "environment");
  assert.equal(run.contract.targetHash, contract.targetHash);
});

const fixture = async (name) =>
  JSON.parse(await readFile(`evaluation/sets/${name}/inputs.json`));
const gold = async (name) =>
  JSON.parse(await readFile(`evaluation/sets/${name}/evaluator-gold.json`));
test("formal and boundary manifests reject weakened partitions, thresholds and old unmarked sets", async () => {
  const d = await fixture("eighth-batch-semantics"),
    g = await gold("eighth-batch-semantics");
  validateSemanticDataset(d, g, false);
  validateSemanticDataset(
    await fixture("eighth-semantic-development"),
    await gold("eighth-semantic-development"),
    true,
  );
  assert.throws(() =>
    validateSemanticDataset(
      d,
      { ...g, thresholds: { ...SEMANTIC_THRESHOLDS, unknownCorrect: 10 } },
      false,
    ),
  );
  assert.throws(() =>
    validateSemanticDataset({ ...d, exposure: "known_regression" }, g, false),
  );
  assert.throws(() =>
    validateSemanticDataset(
      d,
      {
        ...g,
        labels: g.labels.map((l, i) =>
          i ? l : { ...l, expectation: "unknown" },
        ),
      },
      false,
    ),
  );
  assert.throws(() =>
    validateSemanticDataset({ ...d, cases: d.cases.slice(1) }, g, false),
  );
});
test("preregistered inputs, code, configuration and the registration itself are immutable before dispatch", async () => {
  const base = path.resolve(
    process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/eighth-test-records",
  );
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "registration-"));
  for (const name of EVALUATION_CODE_PATHS) {
    if (name.endsWith(".json")) await writeFile(path.join(root, name), "{}");
    else await mkdir(path.join(root, name));
  }
  const ds = path.join(root, "evaluation", "cases");
  await mkdir(ds);
  const inputs = JSON.stringify(await fixture("eighth-semantic-development"));
  await writeFile(ds + "/inputs.json", inputs);
  await writeFile(
    ds + "/evaluator-gold.json",
    JSON.stringify(await gold("eighth-semantic-development")),
  );
  const config = { model: "controlled", key: "fixture-only" };
  const expected = await semanticRegistration({
    root,
    datasetPath: ds,
    development: true,
    config,
  });
  const reg = path.join(root, "registration.json"),
    bytes = JSON.stringify(expected);
  await writeFile(reg, bytes);
  const guard = await registeredSemanticGuard({
    root,
    registrationPath: reg,
    expected,
    config,
  });
  await guard.assertCurrent();
  await writeFile(ds + "/inputs.json", inputs + "\n");
  await assert.rejects(guard.assertCurrent(), /changed/);
  await writeFile(ds + "/inputs.json", inputs);
  await writeFile(root + "/server/new.mjs", "// changed");
  await assert.rejects(guard.assertCurrent(), /changed/);
  const changed = await semanticRegistration({
    root,
    datasetPath: ds,
    development: true,
    config: { ...config, model: "other" },
  });
  await assert.rejects(
    registeredSemanticGuard({
      root,
      registrationPath: reg,
      expected: changed,
      config,
    }),
    /preregistration/,
  );
  await writeFile(reg, bytes + "\n");
  await assert.rejects(guard.assertCurrent(), /changed/);
});
const formal = () => ({
  contract: { targetHash: "t" },
  checkArtifact: "kernel",
  semanticArtifact: "semantic",
  check: { status: "verified", mode: "proof", targetHash: "t", axioms: [] },
  conclusion: { semantic: "agent_reviewed", theorem: "formalized_proved" },
  originalProofRoute: {
    root: "route",
    summary: { status: "source_proof_missing" },
  },
});
test("completed and missing source proof never become full paper or author route certificates", () => {
  const f = formal(),
    run = {
      status: "completed",
      conclusion: { reviewComplete: true },
      reviewScope: { selectedClaimIds: ["a"], maxSelectedClaims: 1 },
      claims: [{ id: "a", formalResult: f }, { id: "uncovered" }],
    };
  const evidence = {
    integrity: true,
    recordBound: true,
    implementationUnchanged: true,
    replay: {
      integrity: true,
      reproduced: true,
      revalidated: true,
      sameEnvironment: true,
    },
  };
  const r = evaluationClosure(run, evidence);
  assert.equal(r.selectedTargetClosed, true);
  assert.equal(r.sourceProofMissing, true);
  assert.equal(r.originalProofProvidedAndVerified, false);
  assert.equal(r.wholePaperVerified, false);
  assert.equal(
    evaluationClosure(
      { ...run, reviewScope: { ...run.reviewScope, maxSelectedClaims: null } },
      evidence,
    ).selectedTargetClosed,
    false,
  );
  assert.equal(
    evaluationClosure(run, { ...evidence, recordBound: false })
      .selectedTargetClosed,
    false,
  );
  f.check.mode = "typecheck";
  assert.equal(evaluationClosure(run, evidence).selectedTargetClosed, false);
  f.check.mode = "proof";
  f.check.targetHash = "foreign";
  assert.equal(evaluationClosure(run, evidence).selectedTargetClosed, false);
  f.check.targetHash = "t";
  assert.equal(
    evaluationClosure(run, {
      ...evidence,
      replay: { ...evidence.replay, revalidated: false },
    }).selectedTargetClosed,
    false,
  );
  assert.equal(
    evaluationClosure(run, { ...evidence, activeRecords: [{ id: "live" }] })
      .selectedTargetClosed,
    false,
  );
  delete f.checkArtifact;
  assert.equal(evaluationClosure(run, evidence).selectedTargetClosed, false);
});
test("evaluation binds claims and scope to the immutable root before accepting mutable summaries", () => {
  const claims = [{ id: "a", formalResult: formal() }];
  const reviewScope = { selectedClaimIds: ["a"] };
  const conclusion = { claims, reviewScope, reviewComplete: true };
  const artifact = {
    kind: "adaptive:conclude",
    payload: { value: conclusion },
    inputs: [],
  };
  const root = digest(artifact);
  const bundle = {
    schemaVersion: "lemma.evidence.v1",
    root,
    artifacts: [{ id: root, ...artifact }],
  };
  const run = { root, claims, reviewScope, conclusion };
  assert.equal(evaluationRecordBinding(run, bundle).bound, true);
  for (const change of [
    { conclusion: { ...conclusion, reviewComplete: false } },
    { claims: [] },
    { reviewScope: { selectedClaimIds: ["unarchived"] } },
  ])
    assert.throws(
      () => evaluationRecordBinding({ ...run, ...change }, bundle),
      /immutable conclusion/,
    );
  const failure = {
    kind: "review_blocked",
    payload: { reason: "no result" },
    inputs: [],
  };
  const failedRoot = digest(failure);
  assert.equal(
    evaluationRecordBinding(
      { ...run, root: failedRoot },
      {
        schemaVersion: "lemma.evidence.v1",
        root: failedRoot,
        artifacts: [{ id: failedRoot, ...failure }],
      },
    ).bound,
    false,
  );
});
test("timing preserves overlapping intervals, queue, unknown ends and reserve provenance", () => {
  const run = {
    id: "r",
    modelCalls: 1,
    tasks: [{ id: "task", role: "R03", startedAt: 100, endedAt: 500 }],
    modelBudget: {
      entries: [
        {
          id: "m",
          reservedAt: 200,
          dispatchedAt: 220,
          endedAt: 400,
          protectedMs: 170000,
          observedQueueMs: 20,
          state: "received",
        },
      ],
    },
    nativeTimings: [{ id: "n", startedAtMs: 250, name: "native" }],
  };
  const r = evaluationTimeline(
    run,
    [run],
    { startedAt: 100 },
    { endedAt: 600 },
  );
  assert.equal(r.wallMs, 500);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows.find((x) => x.kind === "native").elapsedMs, null);
  assert.equal(r.rows.find((x) => x.kind === "model").protectedMs, 170000);
  assert.equal(r.rows.find((x) => x.kind === "model").queueMs, 20);
});
