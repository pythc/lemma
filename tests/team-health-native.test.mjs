import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { TeamRuntime } from "../server/team/runtime.mjs";
import { TeamResources } from "../server/resources/team-resources.mjs";
import { MathematicalTools } from "../server/tools/mathematics.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { leanPool } from "../server/resource-pool.mjs";

test(
  "real native tools record admission, optional draft-to-project repair and same-run collaboration",
  { timeout: 180000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lemma-health-native-")),
      store = new EvidenceStore(root);
    const runtime = new TeamRuntime({
      store,
      mathTools: new MathematicalTools({ store }),
      executor: {
        run: async () => {
          throw Error("Model not used in controlled engineering fixture");
        },
      },
      resources: new TeamResources(),
      extract: async () => ({
        paperSha256: sha256("fixture"),
        pageCount: 1,
        pages: [{ index: 0, text: "Engineering fixture" }],
      }),
    });
    runtime.pump = () => {};
    await runtime.init();
    t.after(async () => {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    });
    const start = await runtime.start({ pdfBase64: "fixture" }),
      run = runtime.runs.get(start.id),
      actor = run.tasks[0];
    actor.status = "running";
    const signal = runtime.active.get(run.id).controller.signal;
    const session = {
      runId: run.id,
      actorId: actor.id,
      signal,
      pending: new Set(),
    };
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const operationId of ids)
      await runtime.operations.start(session, {
        operationId,
        name: "lean_draft",
        arguments: {
          code: `import Std\nexample (n : Nat) : n = n := by rfl -- independent ${operationId}`,
        },
      });
    await Promise.all(ids.map((id) => runtime.operations.jobs.get(id)));
    for (const id of ids) {
      const op = run.operations.find((o) => o.id === id);
      assert.equal(op.status, "completed");
      assert.ok(
        op.resourceEvents.some(
          (e) => e.resource === "lean-host" && e.phase === "queued",
        ),
      );
      assert.ok(
        op.resourceEvents.some(
          (e) => e.resource === "lean-host" && e.phase === "executing",
        ),
      );
      assert.ok(
        !op.resourceEvents.some((e) => e.resource === "lean"),
        "no duplicate local Lean admission",
      );
      assert.ok(Date.parse(op.endedAt) >= Date.parse(op.executionStartedAt));
    }
    const result = (await runtime.operations.get(run.id, ids[0])).result;
    assert.equal(result.result.exitCode, 0);
    assert.match(result.scope, /diagnostic/);
    const call = (name, args) =>
      runtime.call(run.id, actor.id, name, args, signal);
    const workspace = await call(
      result.workspaceOption.tool,
      result.workspaceOption.arguments,
    );
    const list = await call("workspace_list", {});
    assert.equal(list.projects[0].workspaceId, workspace.workspaceId);
    const original = await call("workspace_read", {
      workspaceId: workspace.workspaceId,
      file: "Draft.lean",
    });
    assert.match(original.content, /example/);
    await call("workspace_write", {
      workspaceId: workspace.workspaceId,
      expectedRevision: 0,
      files: {
        "Draft.lean": "import Std\nexample : True := by exact doesNotExist",
      },
    });
    assert.equal(
      (await call("workspace_check", { workspaceId: workspace.workspaceId }))
        .success,
      false,
    );
    await call("workspace_write", {
      workspaceId: workspace.workspaceId,
      expectedRevision: 1,
      files: { "Draft.lean": "import Std\nexample : True := by trivial" },
    });
    assert.equal(
      (await call("workspace_check", { workspaceId: workspace.workspaceId }))
        .success,
      true,
    );
    const saved = await store.get(workspace.artifactId);
    assert.match(saved.payload.result.files["Draft.lean"], /n = n/);
    assert.equal(
      run.proofReceiptIndex.length,
      0,
      "Diagnostic builds never become exact proof receipts",
    );
    assert.equal(leanPool.running, 0);
  },
);
