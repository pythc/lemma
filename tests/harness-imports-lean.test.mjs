import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  DeepProofHarness,
  harnessModelAdapter,
} from "../server/deep-harness.mjs";
import {
  OriginalProofEngine,
  replayOriginalProof,
} from "../server/original-proof.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";

const module = "Mathlib.Analysis.Convex.Function";
const text = "Use the fixture identity.";
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-import-goal-"));
  const store = new EvidenceStore(dir);
  await store.init();
  const source = await store.put("explicit_scripted_goal_fixture", {
    text,
    paperSha256: sha256(text),
    pageIndex: 0,
    pages: [{ index: 0, text }],
  });
  const context = { pages: [{ pageIndex: 0, text }], supplements: [] };
  const contextArtifact = await store.put(
    "explicit_scripted_context",
    context,
    [source],
  );
  const translationArtifact = await store.put(
    "explicit_scripted_translation",
    { scope: "fixture_not_real_paper" },
    [source],
  );
  const contract = createContract(
    { text, artifact: source, paperSha256: sha256(text), pageIndex: 0 },
    {
      label: "fixture",
      quote: text,
      statement: "explicit fixture",
      assumptions: [],
      leanTarget: "∀ n : Nat, n = n",
    },
    "analysis-continuity-v1",
    { contextArtifact, translationArtifact },
  );
  const contractArtifact = await store.put(
    "explicit_scripted_contract",
    contract,
    [source, contextArtifact, translationArtifact],
  );
  return {
    dir,
    store,
    source,
    context,
    contextArtifact,
    contractArtifact,
    contract,
  };
}
const toolCall = (id, name, args) => ({
  message: {
    content: null,
    tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
  },
  record: { scripted: true, id },
});
const lastTool = (r) => {
  const message = r.messages.filter((m) => m.role === "tool").at(-1);
  if (!message) return null;
  try {
    return JSON.parse(message.content);
  } catch {
    return message.content;
  }
};
test(
  "real SDK extends pinned imports, prepares the fixed Goal, writes through a physical alias and imports it under native Lean",
  { timeout: 240000 },
  async () => {
    const f = await fixture();
    let runId,
      primary = 0,
      summaries = 0,
      extendedHash;
    const harness = new DeepProofHarness({
      store: f.store,
      model: async (_config, r) => {
        if (r.role === "HARNESS_CONTEXT_SUMMARY") {
          summaries++;
          return {
            message: {
              content: "Explicit fixture navigation. The task is unchanged.",
            },
            record: { scripted: true, summary: summaries },
          };
        }
        primary++;
        const value = lastTool(r);
        const workspace = await realpath(
          path.join(f.store.root, "harness-workspaces", runId),
        );
        if (primary === 1)
          return toolCall("modules", "add_mathlib_modules", {
            modules: [module],
          });
        if (primary === 2) {
          assert.equal(value.contract.leanTarget, f.contract.leanTarget);
          assert.notEqual(value.contract.targetHash, f.contract.targetHash);
          assert(value.contract.imports.includes(module));
          extendedHash = value.contract.targetHash;
          return toolCall("prepare", "prepare_goal", {});
        }
        if (primary === 3) {
          assert.equal(value.status, "well_typed", JSON.stringify(value));
          assert.equal(value.targetHash, extendedHash);
          assert.match(value.compiledSha256, /^[a-f0-9]{64}$/);
          assert.equal(
            value.scope,
            "goal_signature_only_not_a_proof_certificate",
          );
          return toolCall("write", "write_file", {
            file_path: path.join(workspace, "Probe.lean"),
            content: "import Goal\n#check LemmaHarness.goal\n",
          });
        }
        if (primary === 4) {
          assert.equal(
            await readFile(path.join(workspace, "Probe.lean"), "utf8"),
            "import Goal\n#check LemmaHarness.goal\n",
          );
          return toolCall("probe", "run_command", {
            command: "lean Probe.lean",
          });
        }
        if (primary === 5) {
          assert.equal(value.exitCode, 0, JSON.stringify(value));
          assert.equal(value.targetHash, extendedHash);
          assert.match(value.stdout, /LemmaHarness.goal/);
          return toolCall("reserved", "run_command", {
            command: "printf 'changed' > Goal.lean",
          });
        }
        assert.equal(primary, 6);
        assert.notEqual(
          value.exitCode,
          0,
          "a shell cannot replace the fixed goal",
        );
        assert(
          (await readFile(path.join(workspace, "Goal.lean"), "utf8")).includes(
            f.contract.leanTarget,
          ),
        );
        return {
          message: {
            content: JSON.stringify({
              mode: "proof",
              route: "original",
              proof: "by intro n; rfl",
            }),
          },
          record: { scripted: true, final: true },
        };
      },
    });
    try {
      const result = await harness.run({
        config: { model: "explicit-scripted-goal-only" },
        contract: f.contract,
        inputs: [f.source, f.contextArtifact, f.contractArtifact],
        goal: "Explicit execution fixture, not mathematical performance.",
        maxCalls: 12,
        onCreated: async (r) => {
          runId = r.id;
        },
      });
      assert.equal(result.check.status, "verified", result.check.reason);
      assert.equal(result.contract.targetHash, extendedHash);
      assert.equal(result.check.targetHash, extendedHash);
      assert.equal(result.record.modelCalls, primary + summaries);
      const bundle = await f.store.bundle(result.record.harnessRoot);
      assert(
        bundle.artifacts.some((a) => a.kind === "harness:mathlib_modules"),
      );
      assert(
        bundle.artifacts.some(
          (a) =>
            a.kind === "harness:tool" &&
            a.payload.name === "prepare_goal" &&
            a.payload.value.status === "well_typed",
        ),
      );
    } finally {
      await harness.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  },
);
test(
  "preparing a False signature never produces a theorem certificate",
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    const { targetHash, ...body } = f.contract;
    body.leanTarget = "False";
    const { digest } = await import("../server/evidence.mjs");
    const contract = { ...body, targetHash: digest(body) };
    let calls = 0;
    const harness = new DeepProofHarness({
      store: f.store,
      model: async (_cfg, r) => {
        calls++;
        if (calls === 1) return toolCall("signature", "prepare_goal", {});
        assert.equal(lastTool(r).status, "well_typed");
        return {
          message: { content: JSON.stringify({ diagnosticOnly: true }) },
          record: { scripted: true, final: true },
        };
      },
    });
    try {
      const result = await harness.run({
        config: { model: "explicit-scripted-false-signature" },
        contract,
        inputs: [f.source],
        goal: "Type only, never prove False.",
        maxCalls: 3,
      });
      assert.equal(result.check, null);
      assert.equal(result.parsed.diagnosticOnly, true);
    } finally {
      await harness.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  },
);
test(
  "a source step may add pinned imports and still close and replay its exact parent with unchanged mathematics",
  { timeout: 240000 },
  async () => {
    const f = await fixture();
    let workerCalls = 0;
    const harness = new DeepProofHarness({
      store: f.store,
      model: async (_cfg, r) => {
        workerCalls++;
        if (workerCalls === 1)
          return toolCall("source-modules", "add_mathlib_modules", {
            modules: [module],
          });
        assert(lastTool(r).contract.imports.includes(module));
        return {
          message: {
            content: JSON.stringify({
              mode: "proof",
              route: "original",
              proof: "by intro n; rfl",
              explanation: "explicit controlled fixture",
            }),
          },
          record: { scripted: true, final: true },
        };
      },
    });
    const managed = harnessModelAdapter({
      store: f.store,
      harness,
      model: async () => {
        throw Error("Unexpected unmanaged fixture request");
      },
    });
    const engine = new OriginalProofEngine({
      store: f.store,
      model: async (cfg, r) => {
        if (["R06_STEP", "R06_REPAIR"].includes(r.role)) return managed(cfg, r);
        if (r.role === "R06_GRAPH")
          return {
            parsed: {
              steps: [
                {
                  name: "Identity",
                  title: "fixture identity",
                  kind: "explicit",
                  anchors: [{ pageIndex: 0, quote: text }],
                  target: f.contract.leanTarget,
                  dependsOn: [],
                  explanation: "fixture",
                },
              ],
              assembly: "by intro h; exact h",
              policy: {},
            },
            record: { fixture: true },
          };
        if (["R06_INTERFACES", "R06_INTERFACE_REPAIR"].includes(r.role))
          return {
            parsed: { graph: r.input.graph, changes: [], interfaces: [] },
            record: { fixture: true },
          };
        if (r.role === "R06_ALIGN")
          return {
            parsed: {
              coverage: "complete",
              missingSteps: [],
              checks: r.input.graph.steps.map((s) => ({
                name: s.name,
                status: "faithful",
                anchors: s.anchors,
                explanation: "explicit fixture mapping",
              })),
              summary: "fixture",
            },
            record: { fixture: true },
          };
        if (["R06_ROUTE_AUDIT", "R06_CONNECTION_AUDIT"].includes(r.role))
          return {
            parsed: {
              status: "faithful",
              explanation: "explicit fixture route",
            },
            record: { fixture: true },
          };
        throw Error("Unexpected source fixture role " + r.role);
      },
    });
    try {
      const route = await engine.review({
        contract: f.contract,
        context: f.context,
        sourceArtifact: f.source,
        contractArtifact: f.contractArtifact,
        contextArtifact: f.contextArtifact,
        config: { model: "explicit-scripted-source-import" },
      });
      assert.equal(route.assembly.status, "verified", route.assembly.reason);
      assert.equal(route.summary.counts.unverified, 0);
      assert(route.steps[0].contract.imports.includes(module));
      assert.equal(route.assembly.contract.leanTarget, f.contract.leanTarget);
      const replay = await replayOriginalProof(
        await f.store.bundle(route.root),
        route.root,
      );
      assert.equal(replay.reproduced, true);
      assert.equal(replay.allStepsVerified, true);
    } finally {
      await harness.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  },
);
