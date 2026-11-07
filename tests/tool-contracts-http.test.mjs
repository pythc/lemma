import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { TeamRuntime } from "../server/team/runtime.mjs";
import { TeamResources } from "../server/resources/team-resources.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { MathematicalTools } from "../server/tools/mathematics.mjs";
import { TEAM_TOOLS } from "../server/team/tool-catalog.mjs";
import { resolveReference } from "../server/team/references.mjs";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
test(
  "real HTTP and stdio MCP share executable contracts and durable same-run references",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-contract-http-"));
    const store = new EvidenceStore(dir);
    let native = 0;
    const runtime = new TeamRuntime({
      store,
      mathTools: new MathematicalTools({
        store,
        checker: async () => {
          native++;
          throw Error("Unexpected native dispatch");
        },
      }),
      resources: new TeamResources(),
      executor: {
        run: async () => {
          throw Error("No model in fixture");
        },
      },
      extract: async () => ({
        paperSha256: sha256("contract fixture"),
        pageCount: 1,
        pages: [
          {
            index: 0,
            text: "Synthetic source.\n\nA distinct original statement.",
          },
        ],
      }),
    });
    runtime.pump = () => {};
    await runtime.init();
    const started = await runtime.start({ pdfBase64: "fixture" }),
      run = runtime.runs.get(started.id),
      actor = run.tasks[0];
    await runtime.edit(run.id, (r) => {
      r.tasks[0].status = "running";
    });
    const token = "fixture-" + randomUUID();
    runtime.sessions.set(token, {
      runId: run.id,
      actorId: actor.id,
      signal: runtime.active.get(run.id).controller.signal,
      pending: new Set(),
    });
    let proc;
    t.after(async () => {
      proc?.kill();
      await runtime.cancel(run.id);
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    });
    const req = async (route, body) => {
      const r = await fetch(runtime.endpoint + route, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      assert.ok(r.ok);
      return r.json();
    };
    const call = async (name, args, id = randomUUID()) => {
      let op = await req("/operations/start", {
        operationId: id,
        name,
        arguments: args,
      });
      while (op.status === "running") {
        await delay(5);
        op = await req("/operations/get", { operationId: op.operationId });
      }
      return op;
    };
    assert.deepEqual(await req("/tools", {}), TEAM_TOOLS);
    proc = spawn(process.execPath, ["server/adapters/team-mcp.mjs"], {
      env: {
        ...process.env,
        LEMMA_TEAM_ENDPOINT: runtime.endpoint,
        LEMMA_TEAM_TOKEN: token,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map();
    let seq = 0;
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      const r = JSON.parse(line);
      pending.get(r.id)?.(r.result);
      pending.delete(r.id);
    });
    const rpc = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        proc.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    assert.deepEqual((await rpc("tools/list")).tools, TEAM_TOOLS);
    const selected = await call("select_source", {
      pageIndex: 0,
      paragraphIndex: 1,
    });
    assert.equal(selected.status, "completed");
    const handle = selected.result.refs.selectionId;
    assert.ok(handle.startsWith("ref:selection:"));
    const byOpRef = await req("/operations/get", {
      operationId: selected.refs.operationId,
    });
    assert.equal(byOpRef.artifactId, selected.artifactId);
    const proposal = {
      label: "Synthetic",
      statement: "Synthetic statement",
      assumptions: [],
      leanTarget: "True",
    };
    const target = await call("propose_target", {
      kind: "lemma",
      proposal,
      source: {
        locator: { kind: "selection", ref: handle },
        coverage: [{ selectionId: handle }],
      },
    });
    assert.equal(target.status, "completed", JSON.stringify(target));
    assert.ok(target.result.refs.id.startsWith("ref:target:"));
    const cases = [
      [
        "propose_target",
        {
          kind: "lemma",
          proposal,
          profile: "mathlib",
          pageIndex: 0,
          sourceSpans: [],
        },
        "profile_unsupported",
      ],
      [
        "propose_target",
        {
          kind: "lemma",
          proposal: { ...proposal, quote: "Synthetic source." },
          modules: ["Mathlib.DoesNotExist"],
          sourceSpans: [],
        },
        "source_locator_missing",
      ],
      [
        "propose_target",
        {
          kind: "lemma",
          proposal: { ...proposal, quote: "shortened" },
          locatorSelectionId: handle,
          sourceSpans: [{ selectionId: handle }],
          modules: ["Mathlib.DoesNotExist"],
        },
        "source_selection_conflict",
      ],
      [
        "read_source_span",
        { pageIndex: 0, start: 0, end: 9000 },
        "source_range_invalid",
      ],
      [
        "save_progress",
        { summary: "Bad identity", artifactIds: ["a".repeat(31)] },
        "reference_invalid",
      ],
    ];
    for (const [name, args, code] of cases) {
      const before = run.receipts.length;
      const op = await call(name, args);
      assert.equal(op.status, "failed");
      assert.equal(op.error.code, code);
      assert.equal(op.error.dispatchState, "not_dispatched");
      assert.ok(
        !run.operations.find((o) => o.id === op.operationId).resourceStages
          ?.length,
      );
      if (run.receipts.length === before) {
        const events = await runtime.operations.journal.call("events", {
          runId: run.id,
          limit: 1000,
        });
        assert.ok(
          events.some(
            (e) =>
              e.action_id === op.operationId && e.kind === "admission_rejected",
          ),
        );
      } else assert.ok(run.receipts.length >= before + 1);
    }
    assert.equal(native, 0);
    const id = randomUUID(),
      args = {
        summary: "Durable checkpoint",
        artifactIds: [selected.result.refs.selectionId],
      };
    const once = await call("save_progress", args, id);
    const before = run.receipts.length;
    const again = await call("save_progress", args, id);
    assert.equal(once.artifactId, again.artifactId);
    assert.equal(run.receipts.length, before);
    const stored = await store.getRun(run.id),
      operation = stored.operations.find((o) => o.id === id);
    const inputs = (await store.get(operation.inputArtifact)).payload.result;
    assert.equal(inputs.originalArguments.artifactIds[0], handle);
    assert.equal(
      inputs.resolvedArguments.artifactIds[0],
      selected.result.selectionId,
    );
    assert.equal(operation.originalArguments, undefined);
    assert.equal(
      resolveReference(stored, handle, "selection"),
      selected.result.selectionId,
    );
    const persistedRef = stored.references.find((r) => r.ref === handle);
    await runtime.cancel(run.id);
    const sealed = await store.getRun(run.id);
    assert.deepEqual(
      sealed.references.find((r) => r.ref === handle),
      persistedRef,
    );
    const mcp = await rpc("tools/call", {
      name: "get_operation",
      arguments: { operationId: once.refs.operationId },
    });
    assert.equal(mcp.isError, undefined);
    assert.equal(JSON.parse(mcp.content[0].text).operationId, once.operationId);
  },
);
