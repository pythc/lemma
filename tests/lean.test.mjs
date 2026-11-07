import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  access,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createContract, deriveConclusion } from "../server/contracts.mjs";
import {
  checkProof,
  leanStatus,
  runBounded,
  sandboxProfile,
  LEAN_VERSION,
} from "../server/lean.mjs";

const fixtures = JSON.parse(
  await readFile(
    new URL("../fixtures/verification-cases.json", import.meta.url),
    "utf8",
  ),
).cases;
const environment = await leanStatus();
assert.equal(
  environment.ready,
  true,
  "Real checker gate requires the verified local Lean toolchain; this test must not silently skip.",
);
function contractFor(item) {
  return createContract(
    {
      paperSha256: "a".repeat(64),
      artifact: "b".repeat(64),
      pageIndex: 0,
      text: item.quote,
    },
    item,
  );
}
for (const item of fixtures)
  test(
    `real Lean: ${item.label} yields ${item.expected}`,
    { timeout: 40000 },
    async () => {
      const contract = contractFor(item),
        check = await checkProof(contract, item.proof, {
          mode: item.proofMode,
        });
      const result = deriveConclusion({
        contract,
        check,
        status: "completed",
        approval: { confirmed: true, targetHash: contract.targetHash },
      });
      assert.equal(result.theorem, item.expected, JSON.stringify(check));
      assert.equal(result.originalProof, "unverified");
      assert.equal(result.wholePaperVerified, false);
      if (item.expected === "unknown") {
        assert.notEqual(check.exitCode, 0);
        assert.equal(check.status, "not_verified");
        assert.ok(
          check.axioms.includes("sorryAx"),
          "Lean can print a failed placeholder declaration, so exit status is a required gate.",
        );
      } else {
        assert.equal(check.parser.exitCode, 0);
        assert.equal(check.status, "verified");
      }
    },
  );

test(
  "real Lean parser prevents declaration injection into target or proof",
  { timeout: 60000 },
  async () => {
    const item = fixtures[0];
    const contract = contractFor({
      ...item,
      leanTarget: "True) := by trivial\ntheorem injected : (True",
    });
    const targetAttack = await checkProof(contract, "by trivial");
    assert.equal(targetAttack.status, "not_verified");
    assert.notEqual(targetAttack.parser.exitCode, 0);
    const proofAttack = await checkProof(
      contractFor(item),
      "by intro n; rfl\ntheorem extra : True := by trivial",
    );
    assert.equal(proofAttack.status, "not_verified");
    assert.notEqual(proofAttack.parser.exitCode, 0);
  },
);

test(
  "real Lean does not silently invent implicit variables for an incomplete target",
  { timeout: 40000 },
  async () => {
    const contract = contractFor({ ...fixtures[0], leanTarget: "n = n" });
    const result = await checkProof(contract, "by rfl");
    assert.equal(result.status, "not_verified");
    assert.match(result.stdout, /Unknown identifier|unknown identifier/);
  },
);

test(
  "actual sandbox denies outside read/write and networking with trusted disposable canaries",
  { timeout: 60000 },
  async () => {
    const parent = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "lemma-isolation-test-")),
    );
    const directory = path.join(parent, "allowed");
    await mkdir(directory);
    const canary = path.join(parent, "outside.txt"),
      output = path.join(parent, "outside-write.txt");
    const marker = "DISPOSABLE_CANARY_NO_PRIVATE_DATA";
    await writeFile(canary, marker);
    const binary = path.resolve(
      `.tools/lean-${LEAN_VERSION}-darwin_aarch64/bin/lean`,
    );
    const env = {
      PATH: path.dirname(binary),
      LANG: "C.UTF-8",
      TMPDIR: directory,
    };
    const cases = [
      {
        name: "Read",
        code: `import Std\ndef main : IO Unit := do\n  IO.println (← IO.FS.readFile ${JSON.stringify(canary)})\n`,
      },
      {
        name: "Write",
        code: `import Std\ndef main : IO Unit := do\n  IO.FS.writeFile ${JSON.stringify(output)} "created"\n  IO.println "WRITE_SUCCEEDED"\n`,
      },
      {
        name: "Network",
        code: `import Std.Internal.UV.TCP\ndef main : IO Unit := do\n  let socket ← Std.Internal.UV.TCP.Socket.new\n  socket.bind (.v4 { addr := Std.Net.IPv4Addr.ofParts 127 0 0 1, port := 0 })\n  socket.listen 1\n  IO.println "NETWORK_SUCCEEDED"\n`,
      },
    ];
    try {
      for (const item of cases) {
        const file = `${item.name}.lean`;
        await writeFile(path.join(directory, file), item.code);
        // The baseline is trusted test code operating solely on generated temporary files/loopback.
        // No submitted paper or model code is ever executed outside the sandbox.
        const baseline = await runBounded(
          binary,
          ["-M", "1024", "--run", file],
          { cwd: directory, env },
        );
        assert.equal(
          baseline.exitCode,
          0,
          `Canary must work without restriction: ${JSON.stringify(baseline)}`,
        );
        if (item.name === "Write") await rm(output);
        const isolated = await runBounded(
          "/usr/bin/sandbox-exec",
          [
            "-p",
            sandboxProfile(directory),
            binary,
            "-M",
            "1024",
            "--run",
            file,
          ],
          { cwd: directory, env },
        );
        assert.notEqual(
          isolated.exitCode,
          0,
          `${item.name} unexpectedly escaped the sandbox`,
        );
        assert.ok(!isolated.stdout.includes(marker));
        assert.ok(!isolated.stdout.includes("WRITE_SUCCEEDED"));
        assert.ok(!isolated.stdout.includes("NETWORK_SUCCEEDED"));
        if (item.name === "Write") await assert.rejects(access(output));
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
