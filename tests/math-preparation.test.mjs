import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  translationSchema,
  validateTranslationWire,
  TRANSLATION_PROTOCOL,
  ALIGNMENT_CATEGORIES,
} from "../server/translation-wire.mjs";
import { sourceAnchorIndex } from "../server/source-anchor-index.mjs";
import { INDEXED_ANCHOR_V2 } from "../server/audit-wire.mjs";
import { validateAlignment } from "../server/semantics.mjs";
import { createContract } from "../server/contracts.mjs";
import { digest } from "../server/evidence.mjs";
import {
  reserveExperiment,
  settleExperiment,
} from "../server/experiment-budget.mjs";
import { compactCheck } from "../server/check-result.mjs";
import {
  inspectionErrorKind,
  nativeInspectionFailure,
} from "../server/inspection-diagnostic.mjs";
import { assessMathReadiness } from "../server/math-readiness.mjs";
import { SEMANTIC_THRESHOLDS } from "../server/evaluation-registration.mjs";
const quote =
  "For any integers p and q, if p is at most q and q is at most p, then p equals q.";
const target = "∀ (p q : Int), p ≤ q → q ≤ p → p = q";
const context = {
  paperSha256: digest(quote),
  selectedPage: 0,
  pages: [{ pageIndex: 0, text: quote }],
  supplements: [],
  anchorProtocol: INDEXED_ANCHOR_V2,
};
const contract = createContract(
  {
    paperSha256: context.paperSha256,
    pageIndex: 0,
    text: quote,
    artifact: digest("fixture"),
  },
  {
    label: "fixture",
    quote,
    statement: quote,
    assumptions: [],
    leanTarget: target,
  },
  "std-v1",
);
const proposal = (anchor) => ({
  label: "fixture",
  quote,
  statement: quote,
  assumptions: [],
  leanTarget: target,
  ambiguity: "",
  alignment: ALIGNMENT_CATEGORIES.map((category) => ({
    category,
    explanation: "Controlled test",
    leanFragment: target,
    anchors: [anchor],
  })),
});
test("translation v2 reuses source-bound IDs without accepting duplicate, foreign or fabricated locations", () => {
  assert.equal(TRANSLATION_PROTOCOL, "lemma.translation-wire.v2");
  const [a] = sourceAnchorIndex(context),
    p = proposal({ anchorId: a.anchorId });
  validateTranslationWire(p);
  assert(translationSchema.safeParse(p).success);
  const aligned = validateAlignment(p.alignment, contract, context);
  assert.equal(aligned.length, 6);
  assert(aligned.every((x) => x.anchors[0].quote === quote));
  // Existing v1 source quotes continue to validate; no old receipts rewritten.
  validateAlignment(
    validateTranslationWire(proposal({ pageIndex: 0, quote })).alignment,
    contract,
    context,
  );
  for (const anchor of [
    { pageIndex: 0, quote: "at most" },
    { anchorId: "a".repeat(20) },
    {
      anchorId: sourceAnchorIndex({
        ...context,
        paperSha256: digest("foreign"),
      })[0].anchorId,
    },
  ])
    assert.throws(() =>
      validateAlignment(
        validateTranslationWire(proposal(anchor)).alignment,
        contract,
        { ...context, anchorIndex: [{ anchorId: "a".repeat(20), quote }] },
      ),
    );
  assert.throws(() =>
    validateTranslationWire(
      proposal({ anchorId: a.anchorId, pageIndex: 0, quote }),
    ),
  );
  const changed = proposal({ anchorId: a.anchorId });
  changed.alignment[0].leanFragment = "False";
  assert.throws(() => validateAlignment(changed.alignment, contract, context));
});
test("index navigation preserves cross-page and supplement scope without inventing definitions", () => {
  const source = {
    ...context,
    pages: [
      { pageIndex: 0, text: "Define W(n) as n + 1." },
      { pageIndex: 1, text: "Then W(n) is positive for every natural n." },
    ],
    propositionScope: {
      spans: [
        { pageIndex: 0, quote: "Define W(n) as n + 1." },
        { pageIndex: 1, quote: "Then W(n) is positive for every natural n." },
      ],
    },
  };
  const index = sourceAnchorIndex(source);
  assert.deepEqual([...new Set(index.map((x) => x.pageIndex))], [0, 1]);
  assert(!index.some((x) => x.quote === "W(n)"));
  const p = proposal({ supplementId: "s", quote: "Supporting definition." });
  validateTranslationWire(p);
  assert.throws(() => validateAlignment(p.alignment, contract, context));
});
test("smaller independent experimental caps reject a third request and retain a charged unknown", async () => {
  const base = path.resolve(
    process.env.LEMMA_TEST_EVIDENCE_DIR || "evidence/preparation-unit",
  );
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "budget-"));
  const env = {
    LEMMA_EXPERIMENT_LEDGER: dir,
    LEMMA_EXPERIMENT_COHORT: "translationDev",
  };
  await writeFile(
    dir + "/ledger.json",
    JSON.stringify({ maxCalls: 200, caps: { translationDev: 2 }, entries: [] }),
  );
  const first = await reserveExperiment({ role: "R03" }, env);
  await settleExperiment(
    first,
    { requestId: "received", finishReason: "stop" },
    null,
  );
  const second = await reserveExperiment({ role: "R04" }, env);
  await settleExperiment(
    second,
    {
      requestId: "unknown",
      error: { code: "model_timeout", delivery: "unknown" },
    },
    Error("unknown"),
  );
  await assert.rejects(reserveExperiment({}, env), /cap exhausted/);
  const result = JSON.parse(await readFile(dir + "/ledger.json"));
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[1].state, "failed_charged");
  for (const maxCalls of [0, 297, 1.5]) {
    await writeFile(
      dir + "/ledger.json",
      JSON.stringify({ maxCalls, caps: { translationDev: 2 }, entries: [] }),
    );
    await assert.rejects(reserveExperiment({}, env), /Invalid/);
  }
});
test("public native projection distinguishes query failure from a typed target", () => {
  const result = {
    status: "query_incomplete",
    targetTypeStatus: "well_typed",
    declarationQueryStatus: "incomplete",
    declarations: [
      { name: "Missing", status: "query_failed", verifiedInEnvironment: false },
    ],
    exitCode: 1,
  };
  const compact = compactCheck(result);
  assert.equal(compact.targetTypeStatus, "well_typed");
  assert.equal(compact.declarationQueryStatus, "incomplete");
  assert.equal(inspectionErrorKind(result), "declaration_query_incomplete");
  assert.equal(compact.mode, null);
});
test("observed interrupted olean read is a tool interruption, never a rejected mathematical target", () => {
  const failure = {
    exitCode: 1,
    termination: null,
    stdout:
      "ParserCheck.lean:1:0: error: failed to open file '/fixed/Lean/Compiler/LCNF/LiveVars.olean': Interrupted system call\n",
    stderr: "",
  };
  assert.equal(
    nativeInspectionFailure(failure),
    "native_execution_interrupted",
  );
  assert.equal(
    inspectionErrorKind({ parser: failure }),
    "native_execution_interrupted",
  );
  assert.equal(
    nativeInspectionFailure({
      ...failure,
      stdout: "error: unknown identifier MissingType",
    }),
    null,
  );
  assert.equal(
    nativeInspectionFailure({
      ...failure,
      stdout: "error: excessive memory consumption",
    }),
    "native_resource_exhausted",
  );
});
test("readiness rejects mixed versions, missing checks, altered thresholds, incomplete groups and pending calls", () => {
  const hash = digest("fixed-version");
  const status = { accept: "accepted", reject: "rejected", unknown: "unknown" };
  const cases = Array.from({ length: 20 }, (_, i) => ({
    caseId: `F${i}`,
    reference: {
      expectation: i < 10 ? "accept" : i < 16 ? "reject" : "unknown",
    },
  }));
  const rows = [0, 1, 2].flatMap((repeat) =>
    cases.map((r) => ({
      ...r,
      repeat,
      status: status[r.reference.expectation],
      complete: true,
      firstPassComplete: true,
    })),
  );
  const e = {
    implementation: hash,
    currentImplementation: hash,
    engineering: {
      passed: true,
      implementationUnchanged: true,
      evaluationImplementation: { sha256: hash },
      cleanReplay: {
        integrity: true,
        reproduced: true,
        revalidated: true,
        sameEnvironment: true,
      },
    },
    native: {
      passed: true,
      implementation: hash,
      implementationUnchanged: true,
      steps: ["indexed-admission", "runtime-boundaries", "author-route"].map(
        (name) => ({ name, exitCode: 0, tests: 1, failures: 0 }),
      ),
    },
    developmentVersion: hash,
    development: {
      passed: true,
      implementationUnchanged: true,
      rows: ["D1", "D2", "D3", "D4", "H8", "H9"].map((id) => ({
        id,
        passed: true,
        firstSubmissionStructured: true,
        native: "well_typed",
        adjudication: { admission: "allowed" },
        calls: 4,
      })),
    },
    boundary: {
      developmentAccepted: true,
      implementationUnchanged: true,
      registrationUnchanged: true,
      plan: { implementation: { sha256: hash } },
      rows: rows.slice(0, 6),
    },
    formal: {
      accepted: true,
      implementationUnchanged: true,
      registrationUnchanged: true,
      plan: {
        implementation: { sha256: hash },
        thresholds: SEMANTIC_THRESHOLDS,
      },
      rows,
    },
    ledger: {
      maxCalls: 200,
      priorBatchCredit: 0,
      caps: {
        translationDev: 24,
        translationRework: 24,
        semanticDev: 24,
        semanticBase: 120,
        semanticRepair: 8,
      },
      entries: [],
    },
    preservation: {
      unchanged: true,
      globalBudgetUnchanged: true,
      csUnchanged: true,
      priorLedgersUnchanged: true,
    },
    startPlan: {
      prepared: true,
      inputHashVerified: true,
      originalPdfStarted: false,
      callsPerRun: 12,
      minutesPerRun: 4,
      repetitions: 2,
      emptyStorePerRun: true,
      requiresReadinessNotice: true,
      noTargetsOrProofsSupplied: true,
    },
  };
  assert.equal(assessMathReadiness(e).ready, true);
  for (const mutate of [
    (x) => (x.currentImplementation = "other"),
    (x) => (x.developmentVersion = "other"),
    (x) => (x.engineering.evaluationImplementation.sha256 = "other"),
    (x) => x.development.rows.pop(),
    (x) => (x.development.rows[0].calls = 5),
    (x) => (x.formal = null),
    (x) => (x.formal.plan.thresholds.firstPassComplete = 56),
    (x) => (x.formal.rows[0].repeat = 3),
    (x) => (x.formal.rows[10].status = "accepted"),
    (x) => (x.formal.rows[16].status = "accepted"),
    (x) => x.native.steps.pop(),
    (x) => (x.engineering.cleanReplay.revalidated = false),
    (x) =>
      x.ledger.entries.push({
        cohort: "translationDev",
        state: "reserved_charged",
      }),
    (x) =>
      x.ledger.entries.push({
        cohort: "translationDev",
        state: "failed_charged",
        delivery: "unknown",
      }),
    (x) =>
      x.ledger.entries.push({
        cohort: "translationDev",
        state: "failed_charged",
        delivery: { outcome: "unknown", headersSent: true },
      }),
    (x) => (x.ledger.caps.translationDev = 25),
    (x) => (x.preservation.csUnchanged = false),
    (x) => (x.startPlan.originalPdfStarted = true),
  ]) {
    const changed = structuredClone(e);
    mutate(changed);
    assert.equal(assessMathReadiness(changed).ready, false, mutate.toString());
  }
  assert.equal(assessMathReadiness({}).ready, false);
});
