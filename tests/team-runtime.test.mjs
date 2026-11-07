import { randomUUID } from "node:crypto";
import { finishFixture, assessFixture } from "./helpers/team-stop-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TeamRuntime } from "../server/team/runtime.mjs";
import { TeamResources } from "../server/resources/team-resources.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { MathematicalTools } from "../server/tools/mathematics.mjs";
import {
  publicCliEvent,
  cliArgs,
  codexFailure,
  CodexCliAdapter,
} from "../server/adapters/codex-cli.mjs";
import { validateAcceptance } from "../server/team/acceptance.mjs";
import { validateToolArguments } from "../server/team/tool-arguments.mjs";
import { TEAM_TOOLS } from "../server/team/tool-catalog.mjs";
import { publicTeamRun } from "../server/team/public-view.mjs";
import { selectTeamCertificate } from "../shared/team-evidence.mjs";

const source = {
  paperSha256: sha256("controlled-team-fixture"),
  pageCount: 1,
  pdfBase64: "JVBERi0=",
  pages: [
    {
      index: 0,
      text: "Every natural number equals itself.",
      quality: "text_layer",
    },
  ],
  extraction: "controlled_test_source",
};
test("acceptance separates proofs from counterexamples and rejects stale targets", async () => {
  const target = { contract: { targetHash: "exact" } };
  const receipt = {
    kind: "team:lean",
    payload: {
      actorId: "reviewer",
      result: {
        targetId: "target",
        mode: "counterexample",
        result: { status: "verified", targetHash: "exact" },
      },
    },
  };
  const input = {
    run: {},
    actor: { id: "reviewer" },
    submission: {
      resultKind: "theorem",
      targetIds: ["target"],
      artifactIds: [],
    },
    decision: { verdict: "pass", replayIds: ["receipt"] },
    getArtifact: async () => receipt,
    getTarget: () => target,
  };
  await assert.rejects(validateAcceptance(input), /No fresh exact-target/);
  input.submission.resultKind = "counterexample";
  await validateAcceptance(input);
  target.supersededBy = "new-target";
  await assert.rejects(validateAcceptance(input), /superseded/);
});
test("malformed model tool arguments cannot bypass the evidence category", () => {
  const schema = TEAM_TOOLS.find((t) => t.name === "submit_task").inputSchema;
  const input = {
    summary: "Draft",
    resultKind: "invented-proof",
    artifactIds: [],
    targetIds: [],
    limitations: [],
  };
  assert.throws(() => validateToolArguments(schema, input), /expected one of/);
  input.resultKind = "report";
  input.artifactIds = [null];
  assert.throws(() => validateToolArguments(schema, input), /expected string/);
});
test("public delivery shows unaccepted kernel results without promoting drafts or changing history", async () => {
  const run = {
    id: "run",
    engine: "team-v1",
    receipts: ["draft", "proof", "foreign"],
    submissions: [],
    targets: [{ id: "target", contract: { targetHash: "exact" } }],
  };
  const original = JSON.stringify(run);
  const proof = {
    kind: "team:lean",
    payload: {
      runId: "run",
      actorId: "task",
      result: {
        targetId: "target",
        mode: "proof",
        result: { status: "verified", targetHash: "exact" },
      },
    },
  };
  const view = await publicTeamRun(run, async (id) =>
    id === "proof"
      ? proof
      : id === "draft"
        ? { kind: "team:lean_draft", payload: { runId: "run" } }
        : { ...proof, payload: { ...proof.payload, runId: "other" } },
  );
  assert.equal(view.machineChecks.length, 1);
  assert.equal(view.machineChecks[0].independentlyAccepted, false);
  assert.equal(JSON.stringify(run), original);
});
test("summary replay does not hide the accepted certificate or inherit its acceptance", async () => {
  const run = {
    id: "run",
    engine: "team-v1",
    receipts: ["accepted", "summary-replay"],
    submissions: [
      { status: "pass", targetIds: ["target"], replayIds: ["accepted"] },
      { status: "pass", targetIds: [], replayIds: ["summary-replay"] },
    ],
    targets: [{ id: "target", contract: { targetHash: "exact" } }],
  };
  const before = JSON.stringify(run);
  const getArtifact = async (id) => ({
    kind: "team:lean",
    payload: {
      runId: "run",
      actorId: id,
      result: {
        targetId: "target",
        mode: "proof",
        result: { status: "verified", targetHash: "exact" },
      },
    },
  });
  const view = await publicTeamRun(run, getArtifact);
  assert.equal(view.machineChecks.at(-1).independentlyAccepted, false);
  assert.equal(selectTeamCertificate(view, "target").artifactId, "accepted");
  assert.equal(selectTeamCertificate(view, "different-target"), undefined);
  assert.equal(JSON.stringify(run), before);
  run.submissions[0].superseded = true;
  const revised = await publicTeamRun(run, getArtifact);
  assert.equal(
    selectTeamCertificate(revised, "target").independentlyAccepted,
    false,
  );
  run.targets[0].supersededBy = "new-target";
  assert.equal(
    selectTeamCertificate(await publicTeamRun(run, getArtifact), "target"),
    undefined,
  );
});
async function until(fn, timeout = 60000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw Error("Timed out waiting for test");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function fixture(t, script, { native = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-team-test-"));
  const store = new EvidenceStore(root);
  let runtime;
  const executor = {
    run: async (ctx) => {
      const session = runtime.sessions.get(ctx.token),
        run = runtime.runs.get(session.runId),
        actor = run.tasks.find((t) => t.id === session.actorId);
      const call = async (name, args = {}) => {
        const request = async (route, body) => {
          const response = await fetch(ctx.endpoint + route, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${ctx.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
          const data = await response.json();
          if (!response.ok) throw Error(data.error);
          return data;
        };
        let operation = await request("/operations/start", {
          operationId: randomUUID(),
          name,
          arguments: args,
        });
        while (operation.status === "running") {
          await new Promise((r) => setTimeout(r, 10));
          operation = await request("/operations/get", {
            operationId: operation.operationId,
          });
        }
        if (operation.status !== "completed")
          throw Error(operation.error?.message || operation.status);
        return operation.result;
      };
      await script({ call, run, actor, ctx });
      return {
        model: "controlled-fixture",
        reasoningEffort: "high",
        usage: { input_tokens: 1 },
        text: "Fixture finished",
      };
    },
  };
  const math = native
    ? new MathematicalTools({ store })
    : new MathematicalTools({
        store,
        checker: async (c) => ({
          status: "verified",
          targetHash: c.targetHash,
          mode: "proof",
          scope: "controlled_checker_fixture",
        }),
        inspector: async () => ({ status: "well_typed" }),
      });
  runtime = new TeamRuntime({
    store,
    executor,
    resources: new TeamResources({
      concurrency: 3,
      maxTurns: 30,
      maxRunMs: native ? 240000 : 60000,
    }),
    mathTools: math,
    extract: async () => source,
  });
  await runtime.init();
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return { runtime, store };
}

test("role lifecycle: parallel dynamic tasks, automatic acceptance, rework, final receipt closure", async (t) => {
  let activeWorkers = 0,
    overlap = false;
  const { runtime, store } = await fixture(t, async ({ call, run, actor }) => {
    if (actor.role === "main") {
      if (!run.tasks.some((t) => t.role === "task")) {
        const a = await call("create_task", {
          title: "Check claim",
          goal: "Verify the source claim",
          criteria: "Faithful source and actual Lean evidence",
        });
        const b = await call("create_task", {
          title: "Read context",
          goal: "Record source context",
          criteria: "Actual source reading",
        });
        await call("yield_work", { taskIds: [a.taskId, b.taskId] });
      } else
        await finishFixture(call, run, {
          summary: "Fixture completed; not a real-paper result.",
          limitations: ["Fixture only"],
        });
    } else if (actor.role === "task") {
      activeWorkers++;
      if (activeWorkers > 1) overlap = true;
      await new Promise((r) => setTimeout(r, 50));
      await call("read_source");
      const draft = await call("publish_artifact", {
        title: "Context",
        content: { text: "Source read" },
      });
      await call("submit_task", {
        summary: "Context recorded",
        resultKind: "report",
        artifactIds: [draft.artifactId],
        targetIds: [],
        limitations: [],
      });
      activeWorkers--;
    } else {
      const s = run.submissions.find((s) => s.id === actor.submissionId),
        owner = run.tasks.find((t) => t.id === s.taskId);
      await call("read_source");
      await assessFixture(call, run, actor, {
        verdict:
          owner.title === "Check claim" && s.version === 1 ? "rework" : "pass",
        explanation: "Source checked",
        issues: s.version === 1 ? ["Add explanation"] : [],
        replayIds: [],
      });
    }
  });
  const r = await runtime.start({ pdfBase64: source.pdfBase64 });
  await until(
    () => runtime.runs.get(r.id).root && !runtime.active.get(r.id).jobs.size,
  );
  const done = await runtime.load(r.id);
  assert.equal(done.status, "incomplete");
  assert.ok(overlap);
  assert.equal(done.tasks.find((t) => t.title === "Check claim").version, 2);
  assert.equal(done.tasks.filter((t) => t.role === "acceptance").length, 4);
  assert.equal(
    done.turns.every((t) => t.status === "received"),
    true,
  );
  const bundle = await store.bundle(done.root);
  assert.equal(
    bundle.artifacts.filter((a) => a.kind === "team:cli_turn").length,
    done.turns.length,
  );
  assert.equal(done.conclusion.wholePaperVerified, false);
});

test("acceptance cannot manufacture a proof or reuse another actor replay", async (t) => {
  const { runtime } = await fixture(t, async ({ call, run, actor }) => {
    if (actor.role === "main") {
      if (run.tasks.length === 1) {
        const a = await call("create_task", {
          title: "Prove",
          goal: "Source claim",
          criteria: "Native checked exact target",
        });
        await call("yield_work", { taskIds: [a.taskId] });
      } else
        await finishFixture(call, run, {
          summary: "No proof",
          limitations: ["No proof"],
        });
    } else if (actor.role === "task") {
      await call("submit_task", {
        summary: "I claim proof",
        resultKind: "theorem",
        artifactIds: [],
        targetIds: [],
        limitations: [],
      });
    } else {
      const s = run.submissions.find((s) => s.id === actor.submissionId);
      if (!s.final) {
        await assert.rejects(
          call("assess_submission", {
            verdict: "pass",
            explanation: "Trust me",
            issues: [],
            replayIds: [],
          }),
          /No fresh/,
        );
      }
      await assessFixture(call, run, actor, {
        verdict: s.final ? "pass" : "unresolved",
        explanation: "Missing proof",
        issues: [],
        replayIds: [],
      });
    }
  });
  const r = await runtime.start({ pdfBase64: source.pdfBase64 });
  await until(
    () => runtime.runs.get(r.id).root && !runtime.active.get(r.id).jobs.size,
  );
  assert.equal(runtime.runs.get(r.id).submissions[0].status, "unresolved");
});

test("CLI public projection drops private reasoning and pins requested model", () => {
  assert.equal(
    codexFailure("Selected model is at capacity. Please try a different model.")
      .code,
    "codex_capacity",
  );
  assert.equal(codexFailure("Network connection closed").code, "codex_failed");
  assert.equal(
    codexFailure("Some tool mentioned Selected model is at capacity.").code,
    "codex_failed",
  );
  assert.equal(
    publicCliEvent({
      type: "item.completed",
      item: { type: "reasoning", text: "private" },
    }),
    null,
  );
  assert.deepEqual(
    publicCliEvent({ type: "turn.completed", usage: { input_tokens: 2 } }),
    { type: "turn.completed", usage: { input_tokens: 2 } },
  );
  const args = cliArgs("/tmp/empty", "http://127.0.0.1:1");
  assert.ok(args.includes("gpt-6-sol"));
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ephemeral"));
});

test("CLI terminal success supersedes transient capacity diagnostics; terminal capacity remains retryable", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-capacity-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "fixture-cli.mjs");
  await writeFile(
    binary,
    `#!/usr/bin/env node
let input='';
for await (const part of process.stdin) input+=part;
console.log(JSON.stringify({type:'error',message:'Selected model is at capacity. Please try a different model.'}));
if(input==='recover') {
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Received final result'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1}}));
} else process.exitCode=1;
`,
    { mode: 0o700 },
  );
  const adapter = new CodexCliAdapter({ binary });
  const result = await adapter.run({
    prompt: "recover",
    endpoint: "http://127.0.0.1:1",
    token: "fixture",
  });
  assert.equal(result.text, "Received final result");
  await assert.rejects(
    adapter.run({
      prompt: "fail",
      endpoint: "http://127.0.0.1:1",
      token: "fixture",
    }),
    { code: "codex_capacity" },
  );
});

test("resources are independent, cancellation while queued never executes work", async () => {
  const r = new TeamResources({ concurrency: 1, maxTurns: 2, maxRunMs: 10000 }),
    account = { turns: 0, startedAt: Date.now() };
  let release;
  const first = r.execute(account, () => new Promise((s) => (release = s)));
  await until(() => release);
  const ac = new AbortController();
  let ran = false;
  const second = r.execute(
    account,
    () => {
      ran = true;
    },
    { signal: ac.signal },
  );
  ac.abort();
  await assert.rejects(second);
  release();
  await first;
  assert.equal(ran, false);
  assert.equal(account.turns, 1);
});

test("authorized capacity recovery retains work and does not duplicate a committed submission", async (t) => {
  const rejected = new Set();
  const { runtime, store } = await fixture(t, async ({ call, run, actor }) => {
    const capacity = () =>
      codexFailure(
        "Selected model is at capacity. Please try a different model.",
      );
    if (actor.role === "main") {
      if (!run.tasks.some((x) => x.role === "task")) {
        if (!rejected.has(actor.id)) {
          rejected.add(actor.id);
          await call("save_note", {
            text: "Received work survives CLI restart",
          });
          throw capacity();
        }
        assert.equal(actor.notes[0], "Received work survives CLI restart");
        const next = await call("create_task", {
          title: "Read",
          goal: "Read fixture",
          criteria: "Report",
        });
        await call("yield_work", { taskIds: [next.taskId] });
      } else
        await finishFixture(call, run, {
          summary: "Finished fixture",
          limitations: [],
        });
    } else if (actor.role === "task") {
      await call("submit_task", {
        summary: "Received report",
        resultKind: "report",
        artifactIds: [],
        targetIds: [],
        limitations: [],
      });
      throw capacity(); // Submission already committed: no second task turn.
    } else {
      const s = run.submissions.find((x) => x.id === actor.submissionId);
      if (!s.final && !rejected.has(actor.id)) {
        rejected.add(actor.id);
        throw capacity();
      }
      await assessFixture(call, run, actor, {
        verdict: "pass",
        explanation: "Checked",
        issues: [],
        replayIds: [],
      });
    }
  });
  runtime.resources.capacityRetryDelay = () => 1;
  const r = await runtime.start({ pdfBase64: source.pdfBase64 });
  await until(
    () => runtime.runs.get(r.id).root && !runtime.active.get(r.id).jobs.size,
  );
  const done = await runtime.load(r.id);
  assert.ok(done.tasks.every((x) => x.status === "completed"));
  assert.equal(done.tasks.length, 4);
  const task = done.tasks.find((x) => x.role === "task");
  assert.equal(done.turns.filter((x) => x.actorId === task.id).length, 1);
  assert.equal(
    done.turns.filter((x) => x.recovery === "authorized_capacity_restart")
      .length,
    3,
  );
  const bundle = await store.bundle(done.root);
  assert.equal(
    bundle.artifacts.filter(
      (x) =>
        x.kind === "team:cli_turn" && x.payload.result.restartAuthorization,
    ).length,
    3,
  );
});

test("unrelated unknown CLI errors are not covered by capacity restart authorization", async (t) => {
  let calls = 0;
  const { runtime } = await fixture(t, async () => {
    calls++;
    throw codexFailure("Network response lost");
  });
  const r = await runtime.start({ pdfBase64: source.pdfBase64 });
  await until(
    () => runtime.runs.get(r.id).root && !runtime.active.get(r.id).jobs.size,
  );
  assert.equal(calls, 1);
  assert.equal(runtime.runs.get(r.id).status, "interrupted");
});

test("capacity backoff releases scarce slots and is cancellable before dispatch", async () => {
  const r = new TeamResources({
    concurrency: 1,
    maxTurns: 10,
    maxRunMs: 60000,
  });
  const account = { turns: 0, startedAt: Date.now() };
  const ac = new AbortController();
  const waiting = r.execute(account, () => assert.fail("Must not dispatch"), {
    signal: ac.signal,
    notBefore: Date.now() + 60000,
  });
  const rejection = assert.rejects(waiting);
  assert.equal(await r.execute(account, () => 42), 42);
  ac.abort();
  await rejection;
  assert.equal(account.turns, 1);
});

test("stop drains live actors, archives unknown outcomes and never dispatches again", async (t) => {
  let entered = false;
  const { runtime } = await fixture(t, async ({ ctx }) => {
    entered = true;
    await new Promise((resolve, reject) =>
      ctx.signal.addEventListener("abort", () => reject(Error("aborted")), {
        once: true,
      }),
    );
  });
  const r = await runtime.start({ pdfBase64: source.pdfBase64 });
  await until(() => entered);
  const stopped = await runtime.cancel(r.id);
  assert.equal(stopped.status, "cancelled");
  assert.ok(stopped.root);
  assert.ok(stopped.tasks.every((t) => t.status === "cancelled"));
  assert.equal(stopped.turns[0].status, "unknown");
  assert.equal(runtime.active.get(r.id).jobs.size, 0);
  const bundle = await runtime.store.bundle(stopped.root);
  assert.ok(
    bundle.artifacts.some(
      (a) =>
        a.id === stopped.turns[0].artifact &&
        a.kind === "team:cli_turn" &&
        a.payload.result.status === "unknown",
    ),
  );
  assert.equal(
    bundle.artifacts.find((a) => a.id === stopped.root).payload.turns[0].status,
    "unknown",
  );
});

test("circular task wait is rejected without blocking independent work", async (t) => {
  const { runtime } = await fixture(t, async ({ call, run, actor }) => {
    if (actor.role === "main") {
      if (run.tasks.length === 1) {
        const child = await call("create_task", {
          title: "Dependency",
          goal: "Wait for parent",
          criteria: "Test only",
          dependsOn: [actor.id],
        });
        await assert.rejects(
          call("yield_work", { taskIds: [child.taskId] }),
          /Circular wait/,
        );
        await call("save_note", { text: "Cycle detected correctly" });
      }
      // Fixture intentionally stops here; this is not a successful review.
    }
  });
  const r = await runtime.start({ pdfBase64: source.pdfBase64 });
  await until(
    () => runtime.runs.get(r.id).root && !runtime.active.get(r.id).jobs.size,
  );
  assert.equal(
    runtime.runs.get(r.id).tasks[0].notes[0],
    "Cycle detected correctly",
  );
  assert.equal(runtime.runs.get(r.id).status, "interrupted");
});

test("native exact target: autonomous tool path and acceptance replays use actual Lean", async (t) => {
  const { runtime } = await fixture(
    t,
    async ({ call, run, actor }) => {
      if (actor.role === "main") {
        if (run.tasks.length === 1) {
          const a = await call("create_task", {
            title: "Native fixture",
            goal: "Verify fixture",
            criteria: "Native Lean",
          });
          await call("yield_work", { taskIds: [a.taskId] });
        } else
          await finishFixture(call, run, {
            summary: "Controlled native test only",
            limitations: ["Not paper evidence"],
          });
      } else if (actor.role === "task") {
        const draft = await call("lean_draft", {
          code: "import Std\nexample : False := by sorry\n",
        });
        assert.equal(draft.result.exitCode, 0);
        assert.equal(draft.scope, "diagnostic_only_even_if_exit_code_zero");
        const target = await call("propose_target", {
          proposal: {
            label: "Fixture",
            quote: source.pages[0].text,
            statement: source.pages[0].text,
            assumptions: [],
            leanTarget: "∀ n : Nat, n = n",
            ambiguity: "",
          },
          pageIndex: 0,
          sourceSpans: [{ pageIndex: 0, quote: source.pages[0].text }],
          kind: "claim",
        });
        const proof = await call("check_lean", {
          targetId: target.id,
          proof: "by intro n; rfl",
        });
        assert.equal(proof.result.status, "verified");
        await call("submit_task", {
          summary: "Exact fixture proved",
          resultKind: "theorem",
          artifactIds: [proof.artifactId],
          targetIds: [target.id],
          limitations: [],
        });
      } else {
        const s = run.submissions.find((s) => s.id === actor.submissionId);
        const ids = [];
        if (!s.final) {
          const original = await call("read_evidence", {
            artifactId: s.artifactIds[0],
          });
          const p = original.payload.result;
          const fresh = await call("check_lean", {
            targetId: p.targetId,
            proof: p.proof,
          });
          assert.equal(fresh.result.status, "verified");
          ids.push(fresh.artifactId);
        }
        await assessFixture(call, run, actor, {
          verdict: "pass",
          explanation: "Checked",
          issues: [],
          replayIds: ids,
        });
      }
    },
    { native: true },
  );
  const r = await runtime.start({ pdfBase64: source.pdfBase64 });
  await until(
    () => runtime.runs.get(r.id).root && !runtime.active.get(r.id).jobs.size,
  );
  const done = await runtime.load(r.id);
  assert.deepEqual(
    done.tasks
      .filter((t) => t.error)
      .map((t) => ({ title: t.title, error: t.error })),
    [],
  );
  assert.equal(done.submissions[0].status, "pass");
  const replay = await runtime.replay(r.id);
  assert.equal(replay.results.length, 1);
  assert.equal(replay.results[0].status, "verified");
});

test(
  "main HTTP tool flow continues after truthful partial report, repairs persistent workspace and lemmas, then independently closes scope",
  { timeout: 240000 },
  async (t) => {
    let continued = false;
    const { runtime, store } = await fixture(
      t,
      async ({ call, run, actor }) => {
        if (actor.role === "main") {
          if (run.tasks.length === 1) {
            await assert.rejects(
              call("finish_review", {
                summary: "Limitations only",
                limitations: ["Hard"],
                stopProposal: {
                  reason: "no_viable_path",
                  explanation: "Hard",
                  objectives: [],
                },
              }),
              /actual attempts/,
            );
            const goal = await call("register_objective", {
              title: "Source theorem",
              description: source.pages[0].text,
              kind: "theorem",
              sourceSpans: [{ pageIndex: 0, quote: source.pages[0].text }],
            });
            await call("revise_objective", {
              objectiveId: run.objectives[0].id,
              reason: "Record all claims in the controlled source",
              dependencies: [goal.id],
            });
            const worker = await call("create_task", {
              title: "Construct proof",
              goal: "Construct exact source proof",
              criteria: "Independent source and Lean acceptance",
              objectiveIds: [goal.id],
            });
            await call("yield_work", { taskIds: [worker.taskId] });
          } else {
            assert.equal(run.objectives[1].status, "proved");
            await call("finish_review", {
              summary: "Controlled source exact proof",
              limitations: ["Synthetic fixture, not real-paper performance"],
              stopProposal: {
                reason: "goals_resolved",
                explanation: "Exact objective rechecked; scope for acceptance",
              },
            });
          }
        } else if (actor.role === "task") {
          const goal = run.objectives[1];
          if (actor.version === 1) {
            await call("submit_task", {
              summary: "Read source, proof remains open",
              afterAcceptance: "continue",
              resultKind: "report",
              artifactIds: [],
              targetIds: [],
              limitations: ["Proof not constructed"],
            });
            return;
          }
          continued = true;
          assert.equal(run.status, "running");
          assert.equal(run.submissions[0].status, "pass");
          assert.equal(goal.status, "open");
          const target = await call("propose_target", {
            objectiveId: goal.id,
            proposal: {
              label: "Fixture",
              quote: source.pages[0].text,
              statement: source.pages[0].text,
              assumptions: [],
              leanTarget: "∀ n : Nat, n = n",
              ambiguity: "",
            },
            pageIndex: 0,
            sourceSpans: [{ pageIndex: 0, quote: source.pages[0].text }],
            kind: "claim",
          });
          const ws = await call("workspace_create", {
            title: "Proof project",
            targetId: target.id,
          });
          const broken = await call("workspace_write", {
            workspaceId: ws.workspaceId,
            expectedRevision: 0,
            files: {
              "Helper.lean":
                "import Std\ntheorem helper (n : Nat) : n = n := by exact noSuchProof\n",
              "Main.lean":
                "import Helper\nexample (n : Nat) : n = n := helper n\n",
            },
          });
          const failed = await call("workspace_check", {
            workspaceId: ws.workspaceId,
            files: ["Main.lean"],
          });
          assert.equal(failed.success, false);
          await call("record_attempt", {
            objectiveId: goal.id,
            approach: "Compile helper and caller",
            result: "Undefined name diagnostic",
            nextAction: "Replace invalid proof term",
            artifactIds: [failed.artifactId],
          });
          await assert.rejects(
            call("workspace_write", {
              workspaceId: ws.workspaceId,
              expectedRevision: 0,
              files: { "Main.lean": "" },
            }),
            /changed/,
          );
          const fork = await call("workspace_create", {
            title: "Repair branch",
            fromArtifact: broken.artifactId,
          });
          const fixed = await call("workspace_write", {
            workspaceId: fork.workspaceId,
            expectedRevision: 0,
            files: {
              "Helper.lean":
                "import Std\ntheorem helper (n : Nat) : n = n := by rfl\n",
            },
          });
          await call("workspace_merge", {
            workspaceId: ws.workspaceId,
            expectedRevision: 1,
            fromArtifact: fixed.artifactId,
            expectedFiles: { "Helper.lean": broken.files["Helper.lean"] },
          });
          const build = await call("workspace_check", {
            workspaceId: ws.workspaceId,
            files: ["Main.lean"],
          });
          assert.equal(build.success, true, JSON.stringify(build));
          assert.match(build.scope, /diagnostic/);
          const plan = await call("plan_lemmas", {
            targetId: target.id,
            parts: [
              {
                name: "Self",
                target: "∀ n : Nat, n + 0 = n",
                purpose: "Identity helper",
                dependsOn: [],
              },
            ],
            assembly: "by intro h; exact h",
          });
          assert.equal(plan.ready, true, JSON.stringify(plan));
          assert.deepEqual(
            (await call("assemble_lemmas", { projectId: plan.projectId }))
              .missing,
            ["Self"],
          );
          assert.equal(
            (
              await call("check_lemma", {
                projectId: plan.projectId,
                name: "Self",
                proof: "by exact noSuchProof",
              })
            ).accepted,
            false,
          );
          await call("check_lemma", {
            projectId: plan.projectId,
            name: "Self",
            proof: "by intro n; rfl",
          });
          // A new tool adapter reconstructs the saved lemma project without running anything.
          runtime.math.workspaces.projects.clear();
          assert.equal(
            (await call("read_lemma_projects"))[0].parts[0].accepted,
            true,
          );
          const assembled = await call("assemble_lemmas", {
            projectId: plan.projectId,
          });
          assert.equal(assembled.accepted, true, JSON.stringify(assembled));
          await call("submit_task", {
            summary: "Root assembled after repair",
            resultKind: "theorem",
            artifactIds: [assembled.proofArtifact, build.artifactId],
            targetIds: [target.id],
            limitations: [],
          });
        } else {
          const s = run.submissions.find((s) => s.id === actor.submissionId),
            goal = run.objectives.find((g) => g.kind === "theorem");
          let decisions = [],
            replays = [];
          if (s.final) {
            decisions = [
              {
                objectiveId: run.objectives[0].id,
                version: run.objectives[0].version,
                outcome: "covered",
                explanation: "The single source claim is accounted for",
                sourceAssessment:
                  "Controlled source contains precisely this identity",
              },
            ];
          } else if (s.resultKind === "report") {
            decisions = [
              {
                objectiveId: goal.id,
                version: goal.version,
                outcome: "continue",
                explanation:
                  "Truthful report; construct the still-missing proof",
              },
            ];
          } else {
            const evidence = await call("read_evidence", {
              artifactId: s.artifactIds[0],
            });
            const checked = await call("check_lean", {
              targetId: goal.targetId,
              proof: evidence.payload.result.proof,
            });
            replays = [checked.artifactId];
            decisions = [
              {
                objectiveId: goal.id,
                version: goal.version,
                outcome: "proved",
                explanation: "Exact root independently checked",
                sourceAssessment: "Same Nat quantifier and equality as source",
                evidenceIds: replays,
              },
            ];
          }
          await call("assess_submission", {
            verdict: "pass",
            explanation: "Report and objective separately assessed",
            issues: [],
            replayIds: replays,
            objectiveDecisions: decisions,
            ...(s.final
              ? {
                  stopVerdict: "stop",
                  stopExplanation: "All controlled objectives closed",
                  reviewedObjectiveIds: run.objectives.map((g) => g.id),
                }
              : {}),
          });
        }
      },
      { native: true },
    );
    const started = await runtime.start({ pdfBase64: source.pdfBase64 });
    await until(
      () =>
        runtime.runs.get(started.id).root &&
        !runtime.active.get(started.id).jobs.size,
      180000,
    );
    const done = await runtime.load(started.id);
    assert.deepEqual(
      done.tasks.filter((t) => t.error).map((t) => t.error),
      [],
    );
    assert.equal(continued, true);
    assert.equal(done.status, "completed");
    assert.equal(done.conclusion.wholePaperVerified, false);
    assert.equal(done.conclusion.formalObjectivesResolved, true);
    assert.equal(done.tasks.find((t) => t.role === "task").version, 2);
    assert.equal(
      (await runtime.replay(done.id)).results.every(
        (r) => r.status === "verified",
      ),
      true,
    );
    const bundle = await store.bundle(done.root);
    assert.ok(
      bundle.artifacts.some((a) => a.kind === "team:workspace_lemma_assembly"),
    );
  },
);
