import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TeamRuntime } from "../server/team/runtime.mjs";
import { TeamResources } from "../server/resources/team-resources.mjs";
import { MathematicalTools } from "../server/tools/mathematics.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
test(
  "HTTP warm diagnostics retain strict before/after checks, exact versions and no proof coverage",
  { timeout: 240000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "warm-http-")),
      store = new EvidenceStore(root);
    const runtime = new TeamRuntime({
      store,
      resources: new TeamResources(),
      executor: {},
      mathTools: new MathematicalTools({ store }),
      extract: async () => ({
        paperSha256: sha256("fixture"),
        pageCount: 1,
        pages: [{ index: 0, text: "Engineering fixture only" }],
      }),
    });
    runtime.pump = () => {};
    await runtime.init();
    t.after(async () => {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    });
    const started = await runtime.start({ pdfBase64: "fixture" }),
      run = runtime.runs.get(started.id),
      actor = run.tasks[0];
    actor.status = "running";
    runtime.sessions.set("fixture", {
      runId: run.id,
      actorId: actor.id,
      signal: runtime.active.get(run.id).controller.signal,
      pending: new Set(),
    });
    const request = async (route, body) => {
      const r = await fetch(runtime.endpoint + route, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const value = await r.json();
      assert.equal(
        r.status,
        route.endsWith("start") ? 202 : 200,
        JSON.stringify(value),
      );
      return value;
    };
    const outputs = [];
    for (const code of [
      "import Std\nexample : True := by trivial",
      "import Std\nexample : False := by trivial",
    ]) {
      const op = await request("/operations/start", {
        operationId: randomUUID(),
        name: "lean_explore",
        arguments: { code },
      });
      await runtime.operations.jobs.get(op.operationId);
      const end = await request("/operations/get", {
        operationId: op.operationId,
      });
      assert.equal(end.status, "completed", JSON.stringify(end));
      outputs.push(end.result.result);
      const raw = run.operations.find((o) => o.id === op.operationId);
      for (const name of [
        "environment.verify",
        "environment.verify_after_use",
        "native.exploration",
      ])
        assert.ok(raw.nativeTimings.some((t) => t.name === name));
      assert.equal(
        raw.nativeTimings.filter((t) => t.name === "native.kernel").length,
        0,
      );
    }
    assert.equal(outputs[0].exitCode, 0);
    assert.equal(outputs[1].exitCode, 1);
    assert.equal(outputs[0].workerEpoch, outputs[1].workerEpoch);
    assert.equal(outputs[1].documentVersion, 2);
    assert.equal(run.proofReceiptIndex.length, 0);
    assert.equal(
      run.executionIndex.filter((e) => e.kind === "lean_exploration").length,
      2,
    );
  },
);
