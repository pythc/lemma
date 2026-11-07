import test from "node:test";
import assert from "node:assert/strict";
import { executionContext } from "../server/execution-context.mjs";
import { queryCache } from "../server/native-query-cache.mjs";
import { intervalUnionMs } from "../server/native-timing.mjs";
test("read-only native cache binds owner, target, imports, source, policy and fresh environment identity; cancellation invalidates", async () => {
  const contract = {
      targetHash: "a",
      imports: ["Std"],
      sourceArtifact: "s",
      allowedAxioms: [],
    },
    env = { ready: true, distribution: "v1", sandbox: "p1" },
    run = { id: "one" },
    abort = new AbortController(),
    options = { names: [], definitions: [], signal: abort.signal };
  await executionContext.run({ run }, async () => {
    const c = queryCache(contract, env, options);
    c.put({ status: "well_typed", value: 1 });
    assert(c.get());
    for (const delta of [
      { targetHash: "b" },
      { imports: ["Lean"] },
      { sourceArtifact: "other" },
      { allowedAxioms: ["new"] },
    ])
      assert.equal(
        queryCache({ ...contract, ...delta }, env, options).get(),
        null,
      );
    assert.equal(
      queryCache(contract, { ...env, distribution: "v2" }, options).get(),
      null,
    );
    assert.equal(
      queryCache(contract, { ...env, sandbox: "p2" }, options).get(),
      null,
    );
    assert.equal(
      queryCache(contract, env, { ...options, names: ["Nat"] }).get(),
      null,
    );
    await executionContext.run({ run: { id: "one" } }, async () =>
      assert.equal(queryCache(contract, env, options).get(), null),
    );
    abort.abort();
    assert.equal(c.get(), null);
    const fresh = queryCache(contract, env, {
      ...options,
      signal: new AbortController().signal,
    });
    assert.equal(fresh.get(), null);
    fresh.put({ status: "not_well_typed" });
    assert.equal(fresh.get(), null);
  });
  assert.equal(queryCache(contract, env, options), null);
});
test("nested and overlapping native spans are not added twice", () =>
  assert.equal(
    intervalUnionMs([
      { startedAtMs: 0, endedAtMs: 10 },
      { startedAtMs: 2, endedAtMs: 8 },
      { startedAtMs: 9, endedAtMs: 20 },
      { startedAtMs: 30, endedAtMs: 32 },
    ]),
    22,
  ));

test("path capacity never pools sibling, duplicate, failed or unbound environment observations", async () => {
  const { remainingPathEstimate } = await import("../server/path-budget.mjs");
  const parent = {
    id: "p",
    createdAt: new Date().toISOString(),
    limits: { maxModelCalls: 12, maxRunMs: 240000 },
    modelCalls: 0,
  };
  const sample = {
    id: "s",
    ownerId: "c",
    targetHash: "t",
    name: "native.kernel",
    elapsedMs: 10,
    status: "returned",
    attributes: {},
  };
  const owner = {
    id: "c",
    contract: { targetHash: "t" },
    nativeTimings: [
      sample,
      sample,
      { ...sample, id: "x", ownerId: "other", elapsedMs: 1 },
    ],
  };
  parent.nativeTimings = [{ ...sample, id: "parent", elapsedMs: 1 }];
  let result = remainingPathEstimate(parent, owner);
  assert.equal(result.feasibleMinimum, null);
  assert.equal(result.native.kernel.ms, 30000);
  assert.deepEqual(result.native.kernel.samples, ["s"]);
  owner.nativeTimings.push({
    ...sample,
    id: "failed",
    status: "failed",
    elapsedMs: 45000,
  });
  result = remainingPathEstimate(parent, owner);
  assert.equal(result.native.kernel.ms, 45000);
  assert.equal(result.native.kernel.confidence, "capacity_unknown");
  assert.equal(result.feasibleMinimum, null);
});
