import test from "node:test";
import assert from "node:assert/strict";
import {
  sourceDeclarations,
  compilerDeclarations,
} from "../server/declaration-names.mjs";
import { rankPremiseDeclarations } from "../server/premise-index.mjs";
import { inspectionSelection } from "../server/inspection-selection.mjs";
import { compactCheck } from "../server/check-result.mjs";
import { canonical, digest, sha256 } from "../server/evidence.mjs";
import { declarationQueriesFromTarget } from "../server/knowledge.mjs";
const file = "Mathlib/Fixture.lean";
test("definition discovery includes global and qualified identifiers without reading comments or strings", () => {
  const names = declarationQueriesFromTarget(
    "∀ f : ℝ → ℝ, Continuous f → (Real.log 1 = 0) /- Hidden.constant -/ -- Fake.name\n ∧ LemmaPaper.Local = LemmaPaper.Local",
  );
  assert(names.includes("Continuous"));
  assert(names.includes("Real.log"));
  assert(names.includes("ℝ"));
  assert(!names.includes("Hidden.constant"));
  assert(!names.includes("Fake.name"));
  assert(!names.includes("LemmaPaper.Local"));
  assert(
    !declarationQueriesFromTarget('"NotA.definition"').includes(
      "NotA.definition",
    ),
  );
  assert.equal(
    declarationQueriesFromTarget("Continuous ∧ Continuous").filter(
      (n) => n === "Continuous",
    ).length,
    1,
  );
});
test("source candidate namespaces respect sections, nested comments, strings and explicit roots", () => {
  const source = `/- namespace Wrong\n/- nested -/\ndef fake := 0\n-/\nnamespace Alpha\nsection S\nnamespace Beta\ndef value := 1\nend Beta\nend S\n-- namespace Wrong\ndef _root_.Global.item := 2\nprivate def hidden := 0\ndef text := "namespace Wrong\\ndef fake := 1"\nend Alpha\nnamespace Gamma\ndef value := 3\nend Gamma`;
  const names = sourceDeclarations(source, file).map((e) => e.name);
  assert.deepEqual(names, [
    "Alpha.Beta.value",
    "Global.item",
    "Alpha.text",
    "Gamma.value",
  ]);
});
test("compiler declaration metadata replaces source-level guesses and rejects foreign/stale identities", () => {
  const source =
    "namespace Space\n@[simp] theorem result : True := by trivial\nend Space";
  const metadata = {
    version: 5,
    module: "Mathlib.Fixture",
    decls: { "Space.result": [1, 0, 1, 48, 1, 16, 1, 22] },
  };
  const entries = compilerDeclarations(metadata, source, file);
  assert.equal(entries[0].name, "Space.result");
  assert.equal(entries[0].nameOrigin, "lean_compiler_metadata");
  assert.equal(entries[0].line, 2);
  assert.throws(() =>
    compilerDeclarations(
      { ...metadata, module: "Mathlib.Other" },
      source,
      file,
    ),
  );
  assert.throws(() =>
    compilerDeclarations(
      { ...metadata, decls: { Bad: [9, 0, 9, 1, 9, 0, 9, 1] } },
      source,
      file,
    ),
  );
});
test("qualified exact lookup is case-sensitive and is not crowded out by another namespace or a per-file quota", () => {
  const entries = [
    "A.log",
    "B.log",
    "A.LOG",
    "A.log_one",
    "A.log_two",
    "A.log_three",
    "A.log_four",
  ].map((name, i) => ({
    name,
    file,
    module: "Mathlib.Fixture",
    line: i + 1,
    snippet: "def " + name + " := 1",
  }));
  assert.equal(
    rankPremiseDeclarations(entries, ["B.log"], "", 1)[0].name,
    "B.log",
  );
  assert.equal(
    rankPremiseDeclarations(entries, ["A.LOG"], "", 1)[0].name,
    "A.LOG",
  );
  const four = rankPremiseDeclarations(
    entries,
    ["A.log_one", "A.log_two", "A.log_three", "A.log_four"],
    "",
    4,
  );
  assert.equal(four.length, 4);
  assert.ok(four.every((e) => e.matchKind === "exact_full_name"));
});
test("built-in profiles and external receipt identities are distinct; legacy known profiles remain explicit and safe", () => {
  const owned = sha256("owned"),
    foreign = sha256("foreign"),
    installed = new Map([[owned, { id: owned }]]);
  const selection = inspectionSelection(
    { libraryIds: ["number-combinatorics-v1", owned] },
    installed,
  );
  assert.equal(selection.profile.id, "number-combinatorics-v1");
  assert.equal(selection.receipts[0].id, owned);
  assert.equal(
    selection.notices[0].code,
    "legacy_profile_parameter_normalized",
  );
  assert.equal(
    inspectionSelection({ profileId: "analysis-continuity-v1" }, installed)
      .receipts.length,
    0,
  );
  assert.throws(
    () =>
      inspectionSelection({ externalLibraryReceiptIds: [foreign] }, installed),
    (e) => e.toolError.code === "external_library_receipt_not_owned",
  );
  assert.throws(
    () =>
      inspectionSelection(
        { externalLibraryReceiptIds: ["analysis-continuity-v1"] },
        installed,
      ),
    (e) => e.toolError.code === "invalid_external_library_receipt",
  );
  assert.throws(
    () =>
      inspectionSelection(
        { profileId: "std-v1", libraryIds: ["number-combinatorics-v1"] },
        installed,
      ),
    (e) => e.toolError.code === "conflicting_profile_selection",
  );
});
test("all native result variants remain strict JSON evidence without converting failures into successes", () => {
  const hash = sha256("target");
  for (const raw of [
    {
      status: "tool_unavailable",
      targetHash: hash,
      stage: "environment",
      environment: { ready: false },
      reason: "not installed",
    },
    {
      status: "not_well_typed",
      targetHash: hash,
      parser: { exitCode: 1, stdout: "syntax error" },
    },
    {
      status: "not_well_typed",
      targetHash: hash,
      exitCode: 1,
      stdout: "unknown name",
    },
    { status: "well_typed", targetHash: hash, exitCode: 0, declarations: [] },
  ]) {
    const value = compactCheck(raw);
    assert.doesNotThrow(() => digest(value));
    assert.equal(value.status, raw.status);
    assert.equal(value.exitCode, raw.exitCode ?? null);
  }
  assert.throws(
    () => canonical({ native: { exitCode: undefined } }),
    (e) => e.evidenceValuePath === "$.native.exitCode",
  );
  assert.equal(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test("a failed optional declaration query preserves the other native signatures", async () => {
  const { declarationQueryResults } =
    await import("../server/declaration-query.mjs");
  const rows = declarationQueryResults(
    ["Space.good", "Space.bad"],
    "LEMMA_DECL:Space.good\nSpace.good : Nat\nLEMMA_DECL:Space.bad\nQuery.lean:4:0: error: Unknown identifier `Space.bad`\n",
  );
  assert.equal(rows[0].verifiedInEnvironment, true);
  assert.equal(rows[1].status, "query_failed");
  assert.equal(rows[1].verifiedInEnvironment, false);
  assert.equal(
    declarationQueryResults(["Space.good"], "", { executed: false })[0].status,
    "not_checked",
  );
});

test("module selections reject foreign executions, borrowed ancestry and unready receipts", async () => {
  const { selectedInspectionModules } =
    await import("../server/translation-modules.mjs");
  const source = sha256("source"),
    paper = sha256("paper"),
    id = sha256("receipt"),
    root = sha256("report");
  const modules = [
    {
      name: "Mathlib.Test",
      file: "Mathlib/Test.lean",
      sourceSha256: sha256("module"),
    },
  ];
  const receipt = {
    id,
    kind: "harness:inspection_modules",
    inputs: [source],
    payload: {
      runId: "owned",
      paperSha256: paper,
      sourceArtifact: source,
      modules,
      preparation: { status: "ready", modules },
    },
  };
  const report = {
    id: root,
    kind: "harness:report",
    inputs: [id],
    payload: { runId: "owned" },
  };
  const map = new Map([
    [id, receipt],
    [root, report],
    [source, { id: source, kind: "source", inputs: [], payload: {} }],
  ]);
  const model = {
      source: "deepagents-js",
      harnessRoot: root,
      harnessRunId: "owned",
    },
    identity = { paperSha256: paper, sourceArtifact: source };
  assert.deepEqual(
    selectedInspectionModules(map, model, [id], identity),
    modules,
  );
  for (const patch of [
    { runId: "foreign" },
    { paperSha256: sha256("another") },
    { preparation: { status: "incomplete", modules } },
  ]) {
    const changed = new Map(map);
    changed.set(id, { ...receipt, payload: { ...receipt.payload, ...patch } });
    assert.throws(() =>
      selectedInspectionModules(changed, model, [id], identity),
    );
  }
  const unreachable = new Map(map);
  unreachable.set(root, { ...report, inputs: [source] });
  assert.throws(() =>
    selectedInspectionModules(unreachable, model, [id], identity),
  );
  assert.throws(() =>
    selectedInspectionModules(
      map,
      { ...model, source: "model_claim" },
      [id],
      identity,
    ),
  );
});

test("pipeline receipts bind exact task instances despite concurrent same-role and nested tool events", async () => {
  const { ReviewPipeline } = await import("../server/pipeline.mjs");
  const { EvidenceStore } = await import("../server/evidence.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-task-identity-")),
    store = new EvidenceStore(dir);
  await store.init();
  const p = new ReviewPipeline({ store }),
    run = { id: randomUUID(), tasks: [] };
  const one = await store.put("one", {}),
    two = await store.put("two", {}),
    shared = { same: "value" };
  let releaseA,
    releaseB,
    entered = 0,
    ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const action = (label) => async () => {
    const gate = new Promise((resolve) => {
      if (label === "a") releaseA = resolve;
      else releaseB = resolve;
    });
    if (++entered === 2) ready();
    await gate;
    run.tasks.push({
      id: randomUUID(),
      role: "HARNESS_TOOL",
      output: await store.put("nested-" + label, {}),
      status: "succeeded",
    });
    return shared;
  };
  try {
    const a = p.task(run, "R03", "one", "fixture", [one], action("a")),
      b = p.task(run, "R03", "two", "fixture", [two], action("b"));
    await started;
    releaseB();
    const vb = await b;
    releaseA();
    const va = await a;
    assert.notEqual(va, vb);
    assert.notEqual(p.taskReceipt(va).id, p.taskReceipt(vb).id);
    assert.notEqual(p.taskReceipt(va).output, p.taskReceipt(vb).output);
    assert.deepEqual((await store.get(p.taskReceipt(va).output)).inputs, [one]);
    assert.deepEqual((await store.get(p.taskReceipt(vb).output)).inputs, [two]);
    assert.throws(() => p.taskReceipt({ ...va }), /execution-owned/);
    let error;
    try {
      await p.task(run, "RDP", "bad input", "fixture", [one], async () => {
        run.tasks.push({
          id: randomUUID(),
          role: "HARNESS_TOOL",
          status: "failed",
        });
        throw Error("controlled input error");
      });
    } catch (e) {
      error = e;
    }
    assert.equal(error.pipelineTaskReceipt.role, "RDP");
    assert.equal(
      (await store.get(error.pipelineTaskReceipt.output)).kind,
      "task:RDP:blocked",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("native definition printing is retained alongside theorem signatures", async () => {
  const { declarationQueryResults, validDeclarationQueryName } =
    await import("../server/declaration-query.mjs");
  for (const name of ["Space.α₄", "Continuous", "Nat.add_comm"])
    assert(validDeclarationQueryName(name));
  for (const name of ["Space..value", "A\n#eval 1", "foo; import Bad"])
    assert(!validDeclarationQueryName(name));
  for (const printed of [
    "def Space.value : Nat := 1",
    "noncomputable def Space.value : Nat := 1",
    "theorem Space.value : True := by trivial",
    "structure Space.value.{u_1, u_2} : Type (max u_1 u_2)",
    "@Space.value.{u_1} : {α : Type u_1} → α → α",
  ]) {
    const result = declarationQueryResults(
      ["Space.value"],
      "LEMMA_DECL:Space.value\n" + printed + "\n",
    );
    assert.equal(result[0].verifiedInEnvironment, true, printed);
  }
});
