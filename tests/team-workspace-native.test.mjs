import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TeamWorkspaceTools } from "../server/tools/team-workspace.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";
import { checkProof } from "../server/lean.mjs";
test(
  "workspace extends diagnostic imports while retaining the exact pinned target; saved proof term checks separately",
  { timeout: 180000 },
  async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "lemma-workspace-environment-"),
    );
    try {
      const store = new EvidenceStore(dir);
      await store.init();
      const source = {
        paperSha256: sha256("fixture"),
        pageIndex: 0,
        text: "Nat identity",
        artifact: sha256("source"),
      };
      const target = {
        id: randomUUID(),
        artifact: sha256("target"),
        contract: createContract(source, {
          label: "Fixture",
          quote: "Nat identity",
          statement: "Nat identity",
          assumptions: [],
          leanTarget: "∀ n : Nat, n = n",
        }),
      };
      const run = {
        id: randomUUID(),
        sourceArtifact: source.artifact,
        paperSha256: source.paperSha256,
      };
      const ctx = {
        run,
        getTarget: (id) => {
          assert.equal(id, target.id);
          return target;
        },
        getArtifact: (id) => store.get(id),
        record: (kind, result, inputs = []) =>
          store.put(
            "team:" + kind,
            { runId: run.id, actorId: "fixture", result },
            inputs,
          ),
      };
      const tools = new TeamWorkspaceTools(store, checkProof),
        ws = await tools.run(
          "workspace_create",
          { title: "Imports fixture", targetId: target.id },
          ctx,
        );
      await tools.run(
        "workspace_write",
        {
          workspaceId: ws.workspaceId,
          expectedRevision: 0,
          files: {
            "Library.lean":
              "import Mathlib.Data.Nat.Basic\n#check Nat.add_zero\n",
            "Proof.lean": "by intro n; rfl",
          },
        },
        ctx,
      );
      const result = await tools.run(
        "workspace_check",
        { workspaceId: ws.workspaceId, files: ["Library.lean"] },
        ctx,
      );
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.modules[0].name, "Mathlib.Data.Nat.Basic");
      const checked = await tools.run(
        "check_workspace_target",
        {
          workspaceId: ws.workspaceId,
          targetId: target.id,
          file: "Proof.lean",
        },
        ctx,
      );
      assert.equal(checked.result.status, "verified");
      assert.equal(checked.result.targetHash, target.contract.targetHash);
      await assert.rejects(
        tools.run(
          "workspace_write",
          {
            workspaceId: ws.workspaceId,
            expectedRevision: 1,
            files: { "../Escape.lean": "import Std" },
          },
          ctx,
        ),
        /traversal/,
      );
      assert.equal(
        (
          await tools.run(
            "workspace_read",
            { workspaceId: ws.workspaceId },
            ctx,
          )
        ).revision,
        1,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
