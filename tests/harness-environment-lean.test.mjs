import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DeepProofHarness } from "../server/deep-harness.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";
import { environmentCatalog } from "../server/lean-environments.mjs";
const toolCall = (id, name, args) => ({
  message: {
    content: null,
    tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
  },
  record: { scripted: true },
});
const lastTool = (r) => {
  const last = r.messages.filter((m) => m.role === "tool").at(-1);
  return last ? JSON.parse(last.content) : null;
};
async function fixture(dir, profile, target) {
  const store = new EvidenceStore(path.join(dir, "store"));
  await store.init();
  const source = await store.put("explicit_scripted_environment_fixture", {
    text: "fixture",
  });
  const contract = createContract(
    {
      text: "fixture",
      artifact: source,
      paperSha256: sha256("fixture"),
      pageIndex: 0,
    },
    {
      label: "fixture",
      quote: "fixture",
      statement: "fixture",
      assumptions: [],
      leanTarget: target,
    },
    profile,
  );
  return { store, source, contract };
}

test(
  "harness shell compiles Mathlib in the selected environment without exposing app data or issuing a certificate",
  { timeout: 180000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-shell-native-"));
    const { store, source, contract } = await fixture(
      dir,
      "analysis-continuity-v1",
      "∀ x : ℝ, x ≤ x",
    );
    const secret = path.join(dir, "not-in-workspace.txt");
    await writeFile(secret, "SHELL_MUST_NOT_READ_THIS_CANARY");
    let calls = 0;
    const harness = new DeepProofHarness({
      store,
      model: async (_cfg, r) => {
        calls++;
        const value = lastTool(r);
        if (calls === 1)
          return toolCall("compile", "run_command", {
            command: "lean Goal.lean",
          });
        if (calls === 2) {
          assert.equal(value.exitCode, 0, JSON.stringify(value));
          assert.equal(
            value.scope,
            "diagnostic_command_not_a_proof_certificate",
          );
          assert.equal(value.libraryRevision, contract.libraryRevision);
          return toolCall("outside", "run_command", {
            command: `cat '${secret.replaceAll("'", "'\\''")}'`,
          });
        }
        if (calls === 3) {
          assert.notEqual(value.exitCode, 0);
          assert(!value.stdout.includes("SHELL_MUST_NOT_READ_THIS_CANARY"));
          return toolCall("network", "run_command", {
            command: "/usr/bin/curl --connect-timeout 1 http://127.0.0.1:4178/",
          });
        }
        assert.notEqual(value.exitCode, 0, "shell remains offline");
        return {
          message: { content: JSON.stringify({ diagnosticOnly: true }) },
          record: { scripted: true },
        };
      },
    });
    try {
      const result = await harness.run({
        config: { model: "scripted-environment-only" },
        contract,
        inputs: [source],
        goal: "Explicit native environment fixture, not mathematical performance",
        maxCalls: 5,
      });
      assert.equal(
        result.check,
        null,
        "a shell type probe is not a theorem certificate",
      );
      assert.equal(result.parsed.diagnosticOnly, true);
    } finally {
      await harness.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "sealed environment selection updates the workspace goal and native certificate together",
  { timeout: 180000 },
  async () => {
    const alternate = (await environmentCatalog()).find(
      (e) => e.ready && e.descriptor?.id === "lean-4.34.1",
    );
    assert(
      alternate,
      "The installed second sealed environment is required; do not silently skip",
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-shell-alternate-"));
    const { store, source, contract } = await fixture(
      dir,
      "std-v1",
      "∀ n : Nat, n = n",
    );
    let calls = 0,
      runId;
    const harness = new DeepProofHarness({
      store,
      model: async (_cfg, r) => {
        calls++;
        const value = lastTool(r);
        if (calls === 1) return toolCall("prepare-default", "prepare_goal", {});
        if (calls === 2) {
          assert.equal(value.status, "well_typed");
          return toolCall("select", "select_environment", {
            id: alternate.descriptor.id,
          });
        }
        if (calls === 3) {
          const current = JSON.parse(
            await readFile(
              path.join(
                store.root,
                "harness-workspaces",
                runId,
                "current-contract.json",
              ),
              "utf8",
            ),
          );
          assert.equal(current.targetHash, value.contract.targetHash);
          assert.notEqual(current.targetHash, contract.targetHash);
          assert.equal(
            current.executionEnvironment.id,
            alternate.descriptor.id,
          );
          assert.equal(current.leanTarget, contract.leanTarget);
          await assert.rejects(
            readFile(
              path.join(store.root, "harness-workspaces", runId, "Goal.olean"),
            ),
            { code: "ENOENT" },
          );
          return toolCall("prepare-alternate", "prepare_goal", {});
        }
        if (calls === 4) {
          assert.equal(value.status, "well_typed", JSON.stringify(value));
          assert.equal(value.executionEnvironment, alternate.descriptor.id);
          return toolCall("compile", "run_command", {
            command:
              "printf 'import Goal\\n#check LemmaHarness.goal\\n' > Probe.lean\nlean Probe.lean",
          });
        }
        assert.equal(value.exitCode, 0, JSON.stringify(value));
        assert.equal(value.executionEnvironment, alternate.descriptor.id);
        return {
          message: {
            content: JSON.stringify({
              mode: "proof",
              proof: "by intro n; rfl",
            }),
          },
          record: { scripted: true },
        };
      },
    });
    try {
      const result = await harness.run({
        config: { model: "scripted-environment-switch-only" },
        contract,
        inputs: [source],
        goal: "Explicit environment binding fixture",
        maxCalls: 6,
        onCreated: async (r) => {
          runId = r.id;
        },
      });
      assert.equal(result.check.status, "verified");
      assert.equal(
        result.contract.executionEnvironment.id,
        alternate.descriptor.id,
      );
      assert.equal(result.check.targetHash, result.contract.targetHash);
      assert(
        (await store.bundle(result.record.harnessRoot)).artifacts.some(
          (a) => a.kind === "harness:environment_goal",
        ),
      );
    } finally {
      await harness.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
