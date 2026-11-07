import test from "node:test";
import assert from "node:assert/strict";
import { translationPhaseDecision } from "../server/translation-phase.mjs";
import { preFidelityReserve } from "../server/path-budget.mjs";
const owner = { run: { parentReviewId: "p" } };
const parent = (remainingMs) => ({
  createdAt: new Date(Date.now() - 240000 + remainingMs).toISOString(),
  limits: { maxModelCalls: 12, maxRunMs: 240000 },
  modelCalls: 6,
});
test("translation submits before exploration consumes the unchanged closure reserve", () => {
  const budget = parent(190000);
  const r = translationPhaseDecision({
    owner,
    budget,
    run: { modelCalls: 0 },
    maxCalls: 20,
  });
  assert.equal(r.submission, true);
  assert.equal(r.reason, "exploration_would_spend_submission_time");
  assert.equal(r.protectedCalls, 4);
  assert.equal(
    r.protectedMs,
    preFidelityReserve(budget, owner.run, 4).protectedMs,
  );
  assert.equal(r.protectedMs, 170000);
  assert.equal(r.explorationRequiredMs, 230000);
  assert.equal(
    r.remaining.remainingCalls,
    6,
    "call count alone previously allowed exploration",
  );
});
test("ample time keeps exploration; low calls and component submission keep original caps", () => {
  assert.equal(
    translationPhaseDecision({
      owner,
      budget: parent(239000),
      run: { modelCalls: 0 },
      maxCalls: 20,
    }).submission,
    false,
  );
  const b = parent(239000);
  b.modelCalls = 7;
  assert.equal(
    translationPhaseDecision({
      owner,
      budget: b,
      run: { modelCalls: 0 },
      maxCalls: 20,
    }).reason,
    "mandatory_call_reserve",
  );
  const component = {
    schemaVersion: "lemma.admission-budget.v1",
    limits: { maxModelCalls: 4 },
    modelBudget: { entries: [{ state: "received", purpose: "R03" }] },
  };
  assert.equal(
    translationPhaseDecision({
      owner: { run: { admissionBudgetId: "a" } },
      budget: component,
      run: { modelCalls: 1 },
      maxCalls: 4,
    }).reason,
    "component_submission_slot",
  );
});
