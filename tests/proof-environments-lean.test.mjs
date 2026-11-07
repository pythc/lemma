import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  environmentCatalog,
  resolveEnvironment,
} from "../server/lean-environments.mjs";
import {
  createContract,
  withExecutionEnvironment,
} from "../server/contracts.mjs";
import { checkProof } from "../server/lean.mjs";
import { inspectTarget } from "../server/lean-query.mjs";
import { sha256 } from "../server/evidence.mjs";
import { proofMemoryScope } from "../server/proof-memory.mjs";

test(
  "two real sealed Lean versions check and replay exact targets with isolated cache identities",
  { timeout: 180000 },
  async () => {
    const entry = (await environmentCatalog()).find(
      (e) => e.descriptor?.id === "lean-4.34.1",
    );
    assert(
      entry?.ready,
      "Install the pinned second environment; never silently skip native acceptance",
    );
    const c = createContract(
      {
        paperSha256: sha256("native environment fixture"),
        pageIndex: 0,
        text: "nat identity",
        artifact: sha256("fixture"),
      },
      {
        label: "native fixture",
        quote: "nat identity",
        statement: "nat identity",
        assumptions: [],
        leanTarget: "∀ n : Nat, n + 0 = n",
      },
    );
    const alternate = withExecutionEnvironment(c, entry.descriptor);
    assert.notEqual(proofMemoryScope(c), proofMemoryScope(alternate));
    const proof = "by intro n; rfl";
    const defaultCheck = await checkProof(c, proof, { dependencyAudit: true });
    const alternateCheck = await checkProof(alternate, proof, {
      dependencyAudit: true,
    });
    assert.equal(defaultCheck.status, "verified", JSON.stringify(defaultCheck));
    assert.equal(
      alternateCheck.status,
      "verified",
      JSON.stringify(alternateCheck),
    );
    assert.equal(defaultCheck.environment.version, "4.35.0");
    assert.equal(alternateCheck.environment.version, "4.34.1");
    assert.notEqual(defaultCheck.targetHash, alternateCheck.targetHash);
    const replay = await checkProof(alternate, proof, {
      dependencyAudit: true,
    });
    assert.equal(replay.status, "verified");
    assert.equal(replay.sourceSha256, alternateCheck.sourceSha256);
    const query = await inspectTarget(alternate, { names: ["Nat.add_zero"] });
    assert.equal(query.status, "well_typed", JSON.stringify(query));
    await assert.rejects(
      resolveEnvironment({
        ...entry.descriptor,
        distributionSha256: sha256("tampered"),
      }),
      /changed/,
    );
    await mkdir("evidence/proof-workspace-20261019", { recursive: true });
    await writeFile(
      "evidence/proof-workspace-20261019/environments.json",
      JSON.stringify(
        {
          scope:
            "native_Std_fixture_not_Yang_in_Lean_4_34_or_all_external_libraries",
          defaultCheck,
          alternateCheck,
          replay,
          query,
        },
        null,
        2,
      ),
    );
  },
);

test(
  "real harness selects a sealed version, checks competing proofs and replays its evidence",
  { timeout: 240000 },
  async () => {
    const { DeepProofHarness, replayHarness } =
      await import("../server/deep-harness.mjs");
    const { EvidenceStore } = await import("../server/evidence.mjs");
    const store = new EvidenceStore(
      ".runtime/proof-workspace-20261019/native-harness",
    );
    await store.init();
    const source = await store.put("explicit_native_harness_fixture", {
      text: "nat identity",
    });
    const c = createContract(
      {
        paperSha256: sha256("native harness fixture"),
        pageIndex: 0,
        text: "nat identity",
        artifact: source,
      },
      {
        label: "fixture",
        quote: "nat identity",
        statement: "fixture",
        assumptions: [],
        leanTarget: "∀ n : Nat, n+0=n",
      },
    );
    const script = [
      ["list_environments", {}],
      ["prepare_environment", { version: "4.34.1" }],
      ["select_environment", { id: "lean-4.34.1" }],
      ["run_command", { command: "lean --version" }],
      ["select_environment", { id: "lean-4.35.0" }],
      ["run_command", { command: "lean --version" }],
      ["select_environment", { id: "lean-4.34.1" }],
      [
        "check_candidates",
        {
          candidates: [
            { label: "identity", proof: "by intro n; rfl" },
            {
              label: "invalid alternative",
              proof: "by exact False.elim False.intro",
            },
          ],
        },
      ],
    ];
    let index = 0;
    const h = new DeepProofHarness({
      store,
      model: async (_c, r) => {
        const next = script[index++];
        return {
          message: next
            ? {
                content: null,
                tool_calls: [
                  {
                    id: `native-${index}`,
                    function: {
                      name: next[0],
                      arguments: JSON.stringify(next[1]),
                    },
                  },
                ],
              }
            : {
                content: JSON.stringify({
                  proof: "by intro n; rfl",
                  mode: "proof",
                  route: "original",
                }),
              },
          record: { fixture: true, role: r.role },
        };
      },
    });
    try {
      const result = await h.run({
        contract: c,
        config: { model: "native_fixture", maxOutputTokens: 1000 },
        goal: "Explicit controlled native harness fixture; not a paper review",
        inputs: [source],
        maxCalls: 9,
      });
      assert.equal(result.check.status, "verified");
      assert.equal(result.check.environment.version, "4.34.1");
      const replay = await replayHarness(store, result.record.harnessRunId);
      assert.equal(replay.reproduced, true);
      const bundle = await store.bundle(result.record.harnessRoot);
      const command = bundle.artifacts.find(
        (a) => a.kind === "harness:tool" && a.payload.name === "run_command",
      );
      assert.match(command.payload.value.stdout, /version 4\.34\.1/);
      assert.equal(command.payload.value.executionEnvironment, "lean-4.34.1");
      const restored = bundle.artifacts.filter(
        (a) => a.kind === "harness:tool" && a.payload.name === "run_command",
      )[1];
      assert.match(restored.payload.value.stdout, /version 4\.35\.0/);
      assert.equal(restored.payload.value.executionEnvironment, "lean-4.35.0");
      const branches = bundle.artifacts.find(
        (a) =>
          a.kind === "harness:tool" && a.payload.name === "check_candidates",
      ).payload.value.branches;
      assert.deepEqual(
        branches.map((b) => b.check.status),
        ["verified", "not_verified"],
      );
      await writeFile(
        "evidence/proof-workspace-20261019/native-harness.json",
        JSON.stringify(
          {
            id: result.record.harnessRunId,
            root: result.record.harnessRoot,
            branches: branches.map((b) => ({
              label: b.label,
              status: b.check.status,
              memoryArtifact: b.memoryArtifact,
            })),
            replay,
            scope: "controlled_Std_fixture_not_autonomous_paper_result",
          },
          null,
          2,
        ),
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "native batched interface probes check Prop sorts without proving the propositions",
  { timeout: 90000 },
  async () => {
    const { proofBlueprint, checkBlueprint } =
      await import("../server/proof-workspace.mjs");
    const c = createContract(
      {
        paperSha256: sha256("interface type fixture"),
        pageIndex: 0,
        text: "types",
        artifact: sha256("types"),
      },
      {
        label: "fixture",
        quote: "types",
        statement: "types",
        assumptions: [],
        leanTarget: "True",
      },
    );
    const graph = {
      steps: [
        {
          name: "A",
          title: "A",
          kind: "explicit",
          anchors: [],
          target: "True",
          dependsOn: [],
        },
        {
          name: "B",
          title: "B",
          kind: "omitted",
          anchors: [],
          target: "False",
          dependsOn: [],
        },
      ],
    };
    const good = await checkBlueprint(proofBlueprint(graph, c), checkProof);
    assert.equal(good.status, "well_typed");
    assert.equal(good.batchChecks.length, 1);
    assert.match(good.scope, /only/);
    graph.steps[1].target = "Nat";
    const bad = await checkBlueprint(proofBlueprint(graph, c), checkProof);
    assert.equal(bad.status, "incomplete");
    assert.equal(bad.checks[0].status, "well_typed");
    assert.equal(bad.checks[1].status, "invalid");
    await writeFile(
      "evidence/proof-workspace-20261019/blueprint-native.json",
      JSON.stringify(
        { good, bad, scope: "sort_checks_only_False_is_not_proved" },
        null,
        2,
      ),
    );
  },
);

test(
  "a checked proof is recompiled after the selected environment changes",
  { timeout: 120000 },
  async () => {
    const { DeepProofHarness } = await import("../server/deep-harness.mjs");
    const { EvidenceStore } = await import("../server/evidence.mjs");
    const store = new EvidenceStore(
      ".runtime/proof-workspace-20261019/native-harness",
    );
    await store.init();
    const source = await store.put("explicit_version_switch_fixture", {
      text: "identity",
    });
    const c = createContract(
      {
        paperSha256: sha256("version switch"),
        pageIndex: 0,
        text: "identity",
        artifact: source,
      },
      {
        label: "fixture",
        quote: "identity",
        statement: "fixture",
        assumptions: [],
        leanTarget: "∀ n : Nat, n+0=n",
      },
    );
    const script = [
      ["select_environment", { id: "lean-4.34.1" }],
      ["check_lean", { proof: "by intro n; rfl" }],
      ["select_environment", { id: "lean-4.35.0" }],
    ];
    let calls = 0;
    const h = new DeepProofHarness({
      store,
      model: async (_c, r) => {
        const next = script[calls++];
        return {
          message: next
            ? {
                content: null,
                tool_calls: [
                  {
                    id: `switch-${calls}`,
                    function: {
                      name: next[0],
                      arguments: JSON.stringify(next[1]),
                    },
                  },
                ],
              }
            : {
                content: JSON.stringify({
                  proof: "by intro n; rfl",
                  mode: "proof",
                }),
              },
          record: { fixture: true, role: r.role },
        };
      },
    });
    try {
      const result = await h.run({
        config: { model: "native_fixture", maxOutputTokens: 1000 },
        contract: c,
        goal: "Controlled environment identity fixture",
        inputs: [source],
        maxCalls: 4,
      });
      assert.equal(result.check.status, "verified");
      assert.equal(result.check.environment.version, "4.35.0");
      assert.equal(result.contract.targetHash, c.targetHash);
    } finally {
      await h.close();
    }
  },
);
