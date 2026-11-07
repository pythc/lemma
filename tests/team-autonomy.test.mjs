import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { TeamRuntime } from "../server/team/runtime.mjs";
import { TeamResources } from "../server/resources/team-resources.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import {
  sourceSpan,
  resolveSourceSpans,
  locateSource,
} from "../server/team/source-spans.mjs";
import { boardView, readBoardObject } from "../server/team/board.mjs";
import { reuseAcceptedProof } from "../server/tools/accepted-proof.mjs";
import { validateProofAudit } from "../server/lean-audit.mjs";
const source = {
  paperSha256: sha256("independent engineering fixture"),
  pageCount: 1,
  pages: [{ index: 0, text: "An exact source.\nFor all x,\n  x = x." }],
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function fixture(t, math) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-autonomy-"));
  const store = new EvidenceStore(dir);
  const runtime = new TeamRuntime({
    store,
    executor: {
      run: async () => {
        throw Error("No model allowed");
      },
    },
    resources: new TeamResources(),
    extract: async () => source,
    mathTools: math || { run: async () => ({ ok: true }) },
  });
  runtime.pump = () => {};
  await runtime.init();
  const initial = await runtime.start({ pdfBase64: "fixture" }),
    run = runtime.runs.get(initial.id),
    actor = run.tasks[0];
  actor.status = "running";
  const controller = new AbortController();
  const session = {
    runId: run.id,
    actorId: actor.id,
    signal: controller.signal,
    pending: new Set(),
  };
  t.after(async () => {
    controller.abort();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    runtime,
    run,
    actor,
    store,
    session,
    call: (name, args = {}) => runtime.call(run.id, actor.id, name, args),
  };
}
test("durable operation survives client loss, same ID does not replay, completion is retrievable by another turn", async (t) => {
  const hold = deferred();
  let invoked = 0;
  const f = await fixture(t, {
    run: async () => {
      invoked++;
      await hold.promise;
      return { answer: "received" };
    },
  });
  const operationId = randomUUID(),
    request = {
      operationId,
      name: "lean_draft",
      arguments: { code: "diagnostic" },
    };
  const first = await f.runtime.operations.start(f.session, request);
  assert.equal(first.status, "running");
  await f.runtime.operations.start(f.session, request);
  for (let n = 0; n < 100 && !invoked; n++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(invoked, 1);
  await assert.rejects(
    f.runtime.operations.start(f.session, {
      ...request,
      arguments: { code: "changed" },
    }),
    /different input/,
  );
  const pending = await f.call("submit_task", {
    summary: "premature",
    resultKind: "report",
    artifactIds: [],
    targetIds: [],
    limitations: [],
  });
  assert.equal(pending.submitted, false);
  assert.equal(f.run.submissions.length, 0);
  await f.call("save_progress", {
    summary: "Working while operation is pending",
  });
  assert.equal(f.actor.status, "running");
  await f.call("yield_work", { operationIds: [operationId] });
  assert.equal(f.actor.status, "waiting");
  hold.resolve();
  await f.runtime.operations.jobs.get(operationId);
  const saved = await f.runtime.operations.get(f.run.id, operationId);
  assert.equal(saved.result.answer, "received");
  assert.equal(invoked, 1);
  assert.equal(saved.status, "completed");
  assert.ok(saved.artifactId);
  assert.equal(
    f.session.pending.size,
    0,
    "durable operation must not occupy a CLI session pending drain",
  );
});
test("late target preserved while a concurrent objective revision cannot be overwritten", async (t) => {
  const hold = deferred(),
    entered = deferred();
  const f = await fixture(t, {
    run: async (name, a, ctx) => {
      entered.resolve();
      await hold.promise;
      const target = {
        id: randomUUID(),
        taskId: ctx.actor.id,
        objectiveId: a.objectiveId,
        contract: { targetHash: "test" },
      };
      target.artifact = await ctx.record("target", target);
      await ctx.addTarget(target);
      return target;
    },
  });
  const goal = await f.call("register_objective", {
    title: "Auxiliary",
    description: "Source-bound goal",
    kind: "lemma",
    sourceSpans: [{ pageIndex: 0, quote: "An exact source." }],
  });
  const operationId = randomUUID();
  await f.runtime.operations.start(f.session, {
    operationId,
    name: "propose_target",
    arguments: {
      objectiveId: goal.id,
      proposal: {
        label: "Auxiliary",
        quote: "An exact source.",
        statement: "Synthetic claim",
        assumptions: [],
        leanTarget: "True",
      },
      pageIndex: 0,
      sourceSpans: [{ pageIndex: 0, quote: "An exact source." }],
      kind: "lemma",
    },
  });
  await entered.promise;
  await f.call("revise_objective", {
    objectiveId: goal.id,
    reason: "Changed mathematical scope",
    description: "Different scope",
  });
  f.actor.version++; // Another published actor version, no proof supplied.
  hold.resolve();
  await f.runtime.operations.jobs.get(operationId);
  const result = await f.runtime.operations.get(f.run.id, operationId);
  assert.equal(result.status, "completed");
  assert.equal(f.run.targets.length, 1);
  assert.equal(f.run.targets[0].bindingStatus, "unbound_version_changed");
  assert.equal(f.run.objectives.find((x) => x.id === goal.id).targetId, null);
  assert.equal(f.run.objectives.find((x) => x.id === goal.id).version, 2);
});
test("partial deliverable completes chosen task without closing objective or forcing repetition", async (t) => {
  const f = await fixture(t);
  const child = f.runtime.task(
    "task",
    "Investigate",
    "Investigate source",
    "Report sources",
    f.actor.id,
  );
  child.status = "running";
  child.objectiveIds = [f.run.objectives[0].id];
  f.run.tasks.push(child);
  const sub = await f.runtime.call(f.run.id, child.id, "submit_task", {
    summary: "Partial but useful finding",
    resultKind: "report",
    artifactIds: [],
    targetIds: [],
    limitations: ["Open proof"],
  });
  const accept = f.run.tasks.find((x) => x.id === sub.acceptanceTaskId);
  accept.status = "running";
  await f.runtime.call(f.run.id, accept.id, "assess_submission", {
    verdict: "pass",
    explanation: "Partial report accurate",
    issues: [],
    replayIds: [],
    objectiveDecisions: [
      {
        objectiveId: f.run.objectives[0].id,
        version: 1,
        outcome: "continue",
        explanation: "Proof remains open",
      },
    ],
  });
  assert.equal(child.status, "completed");
  assert.equal(child.version, 1);
  assert.equal(f.run.objectives[0].status, "open");
  assert.equal(f.run.tasks.filter((x) => x.role === "acceptance").length, 1);
  assert.ok(f.run.messages.some((m) => m.to === f.actor.id));
  await f.call("save_progress", { summary: "Choose a different strategy" });
  assert.equal(f.run.tasks.filter((x) => x.role === "acceptance").length, 1);
});
test("Agent explicitly chooses to continue its own task after acceptance", async (t) => {
  const f = await fixture(t);
  const sub = await f.call("submit_task", {
    summary: "Useful milestone",
    resultKind: "report",
    artifactIds: [],
    targetIds: [],
    limitations: [],
    afterAcceptance: "continue",
  });
  const accept = f.run.tasks.find((x) => x.id === sub.acceptanceTaskId);
  accept.status = "running";
  await f.runtime.call(f.run.id, accept.id, "assess_submission", {
    verdict: "pass",
    explanation: "Accepted milestone",
    issues: [],
    replayIds: [],
  });
  assert.equal(f.actor.status, "queued");
  assert.equal(f.actor.version, 2);
});
test("source handles preserve original bytes, reject changed identities, do not normalize math", () => {
  const found = locateSource(source, {
    query: "For all x, x = x.",
    ignoreWhitespace: true,
  });
  assert.equal(found.total, 1);
  const selected = found.selections[0];
  assert.match(selected.quote, /\n/);
  assert.deepEqual(resolveSourceSpans(source, [selected]), [selected]);
  assert.deepEqual(
    resolveSourceSpans(source, [
      {
        pageIndex: 0,
        start: selected.start,
        end: selected.end,
        sourceRef: selected.sourceRef,
      },
    ]),
    [selected],
  );
  assert.throws(
    () =>
      resolveSourceSpans({ ...source, paperSha256: sha256("different PDF") }, [
        selected,
      ]),
    /identity/,
  );
  assert.throws(
    () =>
      resolveSourceSpans(source, [{ ...selected, quote: "For all x, x = x." }]),
    /text changed/,
  );
  assert.equal(
    locateSource(source, { query: "For all x, x ≠ x.", ignoreWhitespace: true })
      .total,
    0,
  );
  assert.throws(() => sourceSpan(source, 0, 0, 999999), /offsets/);
});
test("compact board preserves complete history behind pagination and typed object read", () => {
  const tasks = Array.from({ length: 1000 }, (_, i) => ({
    id: "task-" + i,
    title: "Task",
    goal: "x".repeat(9000),
    role: "task",
    status: "completed",
    notes: ["x".repeat(50000)],
  }));
  const run = {
    tasks,
    objectives: [],
    receipts: ["a".repeat(64)],
    targets: [],
    submissions: [],
  };
  const view = boardView(run, tasks[0]);
  assert.equal(view.tasks.length, 20);
  assert.equal(view.pagination.tasks.total, 1000);
  assert.ok(JSON.stringify(view).length < 30000);
  assert.equal(
    boardView(run, tasks[0], { section: "tasks", offset: 20, limit: 20 })
      .tasks[0].id,
    "task-979",
  );
  assert.equal(
    readBoardObject(run, { id: "task-0", kind: "tasks" }).value.notes[0].length,
    50000,
  );
  assert.equal(run.tasks.length, 1000);
});
test("evidence lookup differentiates object IDs, malformed and unreceived artifact hashes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.getArtifact(f.run, f.actor.id), /object ID/);
  await assert.rejects(f.runtime.getArtifact(f.run, "abcd"), /complete 64/);
  await assert.rejects(
    f.runtime.getArtifact(f.run, "f".repeat(64)),
    /not received/,
  );
});
test("structured theorem audit accepts universe parameters but rejects wrong target and axioms", () => {
  const contract = { targetHash: "target", allowedAxioms: ["propext"] },
    audit = {
      schema: "lemma.kernel-audit.v1",
      declaration: "LemmaReview.checked",
      kind: "theorem",
      typeRepr: "forall",
      universes: ["u_1", "u_2"],
      targetHash: "target",
      proofHash: "proof",
      mode: "proof",
      axioms: ["propext"],
    };
  assert.equal(validateProofAudit(audit, contract, "proof", "proof"), true);
  for (const bad of [
    { ...audit, targetHash: "other" },
    { ...audit, axioms: ["sorryAx"] },
    { ...audit, kind: "axiom" },
    { ...audit, proofHash: "different" },
  ])
    assert.equal(validateProofAudit(bad, contract, "proof", "proof"), false);
});
test("same-run independent proof reuse preserves provenance, rejects changes and opinions", async () => {
  const target = {
    id: "target",
    artifact: "target-artifact",
    contract: { targetHash: "fixed" },
  };
  const environment = {
    ready: true,
    runnerSha256: "checker",
    library: { ready: true, treeSha256: "tree" },
  };
  const native = {
    targetId: "target",
    contract: target.contract,
    proof: "by rfl",
    mode: "proof",
    result: { status: "verified", targetHash: "fixed", environment },
  };
  const records = {
    accept: {
      kind: "team:acceptance",
      payload: { actorId: "reviewer-one", result: { verdict: "pass" } },
    },
    check: {
      kind: "team:lean",
      payload: { actorId: "reviewer-one", result: native },
    },
  };
  const run = {
    submissions: [
      {
        status: "pass",
        taskId: "worker",
        targetIds: ["target"],
        acceptanceArtifact: "accept",
        replayIds: ["check"],
      },
    ],
  };
  let saved;
  const ctx = {
    run,
    actor: { id: "reviewer-two", role: "acceptance" },
    getArtifact: async (id) => records[id],
    getTarget: () => target,
    record: async (kind, value) => {
      saved = { kind, value };
      return "reuse";
    },
  };
  const args = {
    targetId: "target",
    proof: "by rfl",
    acceptanceArtifactId: "accept",
    replayArtifactId: "check",
  };
  const env = async () => ({
    lean: { ready: true, runnerSha256: "checker" },
    library: { ready: true, treeSha256: "tree", searchPaths: [] },
  });
  const result = await reuseAcceptedProof(args, ctx, env);
  assert.equal(result.nativeCheckExecuted, false);
  assert.equal(saved.kind, "lean_reuse");
  assert.equal(result.originalProofReceipt, "check");
  await assert.rejects(
    reuseAcceptedProof({ ...args, proof: "by exact rfl" }, ctx, env),
    /changed/,
  );
  await assert.rejects(
    reuseAcceptedProof(args, ctx, async () => ({
      lean: { ready: true, runnerSha256: "changed" },
      library: { ready: true, treeSha256: "tree" },
    })),
    /checker changed/,
  );
  target.supersededBy = "new";
  await assert.rejects(reuseAcceptedProof(args, ctx, env), /changed/);
});

test("large immutable evidence remains fully addressable beyond its tool preview", async () => {
  const { evidenceView, selectEvidence } =
    await import("../server/team/evidence-view.mjs");
  const large = {
    id: "a".repeat(64),
    kind: "test",
    payload: {
      result: {
        status: "verified",
        dependencies: {
          complete: true,
          edges: Array.from({ length: 20000 }, (_, i) => [
            "constant_" + i,
            ["dependency_" + i],
          ]),
        },
      },
    },
  };
  const view = evidenceView(large, large.id);
  assert.equal(view._view.complete, false);
  assert.equal(view.payload.result.status, "verified");
  assert.equal(large.payload.result.dependencies.edges.length, 20000);
  const page = selectEvidence(large, {
    path: ["payload", "result", "dependencies", "edges"],
    offset: 19990,
    limit: 100,
  });
  assert.equal(page.value.length, 10);
  assert.equal(page.nextOffset, null);
  assert.equal(page.value[9][0], "constant_19999");
});

test("concurrent content verification does not retain stale results after writes", async () => {
  const { sharedContentTree } = await import("../server/toolchain-tree.mjs");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-tree-coalesce-"));
  try {
    await mkdir(path.join(dir, "lib"));
    await writeFile(path.join(dir, "lib", "a"), "first");
    const [a, b] = await Promise.all([
      sharedContentTree(dir, ["lib"]),
      sharedContentTree(dir, ["lib"]),
    ]);
    assert.deepEqual(a, b);
    assert.notEqual(a, b);
    await writeFile(path.join(dir, "lib", "a"), "changed");
    const c = await sharedContentTree(dir, ["lib"]);
    assert.notEqual(c.sha256, a.sha256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelling an operation drains its work and seals the received cancellation without replay", async (t) => {
  const f = await fixture(t, {
    run: async (name, args, { signal }) => {
      await new Promise((resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(Error("stopped operation")),
          { once: true },
        ),
      );
    },
  });
  f.session.signal = f.runtime.active.get(f.run.id).controller.signal;
  const operationId = randomUUID();
  await f.runtime.operations.start(f.session, {
    operationId,
    name: "lean_draft",
    arguments: { code: "cancel fixture" },
  });
  await f.runtime.cancel(f.run.id);
  const op = await f.runtime.operations.get(f.run.id, operationId);
  assert.equal(op.status, "cancelled");
  assert.ok(op.artifactId);
  assert.ok(f.run.root);
  assert.equal(f.runtime.operations.jobs.size, 0);
});

test("input persistence failure cannot dispatch or leave a phantom running operation", async (t) => {
  let invoked = 0;
  const f = await fixture(t, {
    run: async () => {
      invoked++;
      return {};
    },
  });
  const save = f.runtime.projection.save.bind(f.runtime.projection);
  let fail = true;
  f.runtime.projection.save = async (...args) => {
    if (fail) {
      fail = false;
      throw Error("disk unavailable");
    }
    return save(...args);
  };
  const request = {
    operationId: randomUUID(),
    name: "lean_draft",
    arguments: { code: "diagnostic" },
  };
  await assert.rejects(
    f.runtime.operations.start(f.session, request),
    /disk unavailable/,
  );
  const result = await f.runtime.operations.start(f.session, request);
  assert.equal(result.status, "failed");
  assert.equal(result.executionDispatched, false);
  assert.equal(invoked, 0);
  assert.equal(f.runtime.operations.jobs.size, 0);
});

test("work arriving during submission receipt storage prevents task transition", async (t) => {
  const hold = deferred(),
    receipt = deferred(),
    commit = deferred();
  const f = await fixture(t, {
    run: async () => {
      await hold.promise;
      return {};
    },
  });
  const record = f.runtime.record.bind(f.runtime);
  f.runtime.record = async (...args) => {
    const id = await record(...args);
    if (args[2] === "submission") {
      receipt.resolve();
      await commit.promise;
    }
    return id;
  };
  const submission = f.call("submit_task", {
    summary: "interleaved",
    resultKind: "report",
    limitations: [],
    artifactIds: [],
    targetIds: [],
  });
  await receipt.promise;
  const operation = await f.runtime.operations.start(f.session, {
    operationId: randomUUID(),
    name: "lean_draft",
    arguments: { code: "diagnostic" },
  });
  commit.resolve();
  await assert.rejects(submission, /No task transition committed/);
  assert.equal(f.run.submissions.length, 0);
  assert.equal(f.actor.status, "running");
  hold.resolve();
  const op = await operation;
  await f.runtime.operations.jobs.get(op.operationId);
});
