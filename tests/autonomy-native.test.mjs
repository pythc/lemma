import test from "node:test";
import assert from "node:assert/strict";
import { checkProof } from "../server/lean.mjs";
import { createContract } from "../server/contracts.mjs";
import { sha256 } from "../server/evidence.mjs";
const contract = (target) =>
  createContract(
    {
      paperSha256: sha256("generic audit fixture"),
      pageIndex: 0,
      text: "Every element equals itself.",
      artifact: sha256("fixture source"),
    },
    {
      label: "Identity",
      quote: "Every element equals itself.",
      statement: "Identity for any type",
      assumptions: [],
      leanTarget: target,
    },
  );
test(
  "real Lean universe-polymorphic identity yields structured exact certificate and complete file-based dependencies",
  { timeout: 120000 },
  async () => {
    const c = contract("∀ (α : Type _) (x : α), x = x");
    const r = await checkProof(c, "by intro α x; rfl", {
      dependencyAudit: true,
    });
    assert.equal(r.status, "verified", JSON.stringify(r));
    assert.ok(r.kernelAudit.universes.length > 0);
    assert.equal(r.kernelAudit.targetHash, c.targetHash);
    assert.equal(r.dependencies.complete, true);
    assert.equal(r.stdout.includes("LEMMA_DEPENDENCIES:"), false);
    assert.equal(r.kernelAudit.axioms.includes("sorryAx"), false);
  },
);
test(
  "failed proof cannot be accepted because a structured receipt or declaration exists",
  { timeout: 120000 },
  async () => {
    const r = await checkProof(
      contract("∀ (α : Type _) (x : α), x = x"),
      "by intro α x",
      { dependencyAudit: true },
    );
    assert.equal(r.status, "not_verified");
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.axioms.includes("sorryAx"));
  },
);

test(
  "native dependency graph larger than 4 MiB is saved completely outside bounded stdout",
  { timeout: 180000 },
  async () => {
    const { mkdtemp, writeFile, readFile, rm, realpath } =
      await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { binary, runBounded, sandboxProfile } =
      await import("../server/lean.mjs");
    const { dependencyCommand, parseDependencies } =
      await import("../server/lean-dependencies.mjs");
    const dir = await realpath(
      await mkdtemp(path.join(tmpdir(), "lemma-large-audit-")),
    );
    try {
      const ns = "AuditFixture" + "x".repeat(1000),
        count = 4500;
      const lines = [
        "import Lean",
        "set_option maxRecDepth 8192",
        "set_option maxHeartbeats 3000000",
        `namespace ${ns}`,
        "theorem p0 : (0 : Nat) = 0 := rfl",
      ];
      for (let i = 1; i < count; i++)
        lines.push(`theorem p${i} : (0 : Nat) = 0 := p${i - 1}`);
      lines.push(
        `end ${ns}`,
        `theorem LemmaReview.checked : (0 : Nat) = 0 := ${ns}.p${count - 1}`,
        dependencyCommand(0, { outputFile: "Dependencies.json" }),
      );
      await writeFile(path.join(dir, "Large.lean"), lines.join("\n"));
      const runtime = { binary, toolRoot: path.dirname(path.dirname(binary)) };
      const result = await runBounded(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          sandboxProfile(dir, [], runtime),
          binary,
          "-M",
          "6144",
          "Large.lean",
        ],
        {
          cwd: dir,
          env: { PATH: path.dirname(binary) },
          timeoutMs: 150000,
          maxOutput: 4 * 1024 * 1024,
        },
      );
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(result.termination, null);
      const raw = await readFile(path.join(dir, "Dependencies.json"), "utf8");
      assert.ok(Buffer.byteLength(raw) > 4 * 1024 * 1024);
      assert.ok(Buffer.byteLength(result.stdout) < 10000);
      const parsed = parseDependencies("LEMMA_DEPENDENCIES:" + raw);
      assert.equal(parsed.complete, true);
      assert.ok(parsed.edges.length >= count);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "real native environment identity permits exact accepted-proof reuse without another check",
  { timeout: 120000 },
  async () => {
    const { checkEnvironment } = await import("../server/lean.mjs");
    const { reuseAcceptedProof } =
      await import("../server/tools/accepted-proof.mjs");
    const { validateAcceptance } =
      await import("../server/team/acceptance.mjs");
    const c = contract("∀ (α : Type _) (x : α), x = x"),
      proof = "by intro α x; rfl";
    const native = await checkProof(c, proof, { dependencyAudit: true });
    assert.equal(native.status, "verified");
    const target = {
      id: "native-target",
      contract: c,
      artifact: "source-target",
    };
    const records = {
      acceptance: {
        kind: "team:acceptance",
        payload: { actorId: "prior-reviewer", result: { verdict: "pass" } },
      },
      check: {
        kind: "team:lean",
        payload: {
          actorId: "prior-reviewer",
          result: {
            targetId: target.id,
            contract: c,
            proof,
            mode: "proof",
            result: native,
          },
        },
      },
    };
    const actor = { id: "new-reviewer", role: "acceptance" };
    const run = {
      submissions: [
        {
          status: "pass",
          taskId: "author",
          targetIds: [target.id],
          acceptanceArtifact: "acceptance",
          replayIds: ["check"],
        },
      ],
    };
    const result = await reuseAcceptedProof(
      {
        targetId: target.id,
        proof,
        acceptanceArtifactId: "acceptance",
        replayArtifactId: "check",
      },
      {
        run,
        actor,
        getArtifact: async (id) => records[id],
        getTarget: () => target,
        record: async (kind, value) => {
          records.reuse = {
            kind: "team:" + kind,
            payload: { actorId: actor.id, result: value },
          };
          return "reuse";
        },
      },
      checkEnvironment,
    );
    assert.equal(result.nativeCheckExecuted, false);
    assert.equal(result.originalProofReceipt, "check");
    await validateAcceptance({
      run,
      actor,
      submission: { resultKind: "theorem", targetIds: [target.id] },
      decision: { verdict: "pass", replayIds: ["reuse"] },
      getArtifact: async (id) => records[id],
      getTarget: () => target,
    });
  },
);
