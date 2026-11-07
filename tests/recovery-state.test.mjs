import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { reserveRecovery, recoveryState } from "../server/recovery-state.mjs";
const claim = () => ({
  id: "claim",
  anchor: { pageIndex: 0, quote: "a source proposition" },
  libraryProfile: "std-v1",
});
const child = () => ({
  id: randomUUID(),
  paperSha256: "paper",
  status: "blocked",
  libraryProfile: "std-v1",
  error: "所选片段缺少结论，不能形成完整命题。",
  tasks: [{ role: "R03", status: "blocked" }],
});
test("renaming jobs, errors or parent evidence does not reopen an unchanged source failure", () => {
  const r = {},
    c = claim(),
    a = child();
  reserveRecovery(r, a, c, "retry_translation");
  const b = {
    ...child(),
    error: "selectedQuote 截断，无法形成完整命题。",
    tasks: [{ id: randomUUID(), role: "R03", status: "blocked" }],
  };
  assert.equal(
    recoveryState(a, c).fingerprint,
    recoveryState(b, c).fingerprint,
  );
  assert.throws(() => reserveRecovery(r, b, c, "retry_translation"), /未改变/);
  assert.equal(r.recoveryAttempts.length, 1);
  assert.ok(c.formalizationStalled);
});
test("actual source, target and imported environment changes allow a new repair", () => {
  for (const change of [
    (c, a) => {
      c.formalScope = { scopeHash: "complete-source" };
    },
    (c, a) => {
        a.contract = { targetHash: "new-target", leanTarget: "∀ n : Nat, n = n", imports: [] };
    },
    (c, a) => {
      a.contract = { imports: ["Mathlib.NewModule"] };
    },
  ]) {
    const r = {},
      c = claim(),
      a = child();
    reserveRecovery(r, a, c, "recover_domain");
    change(c, a);
    reserveRecovery(r, a, c, "recover_domain");
    assert.equal(r.recoveryAttempts.length, 2);
  }
});
test("native diagnostics distinguish real repairs and unknown external outcomes are never replayed", () => {
  const r = {},
    c = claim(),
    a = child();
  a.check = { status: "not_verified", stdout: "unknown constant A" };
  reserveRecovery(r, a, c, "recover_domain");
  a.check.stdout = "unsolved goals";
  reserveRecovery(r, a, c, "recover_domain");
  a.domainRecovery = { externalOutcomeUnknown: true };
  assert.throws(() => reserveRecovery(r, a, c, "recover_domain"), /未知/);
  assert.equal(r.recoveryAttempts.length, 2);
});
