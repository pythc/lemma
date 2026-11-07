import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  realpath,
  mkdir,
  access,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import {
  analysisLibraryStatus,
  libraryEnvironment,
} from "../server/libraries.mjs";
import { runBounded, sandboxProfile, LEAN_VERSION } from "../server/lean.mjs";
import { MATHLIB_COMMIT } from "../shared/library-profiles.mjs";

const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/analysis-cases.json", import.meta.url),
    "utf8",
  ),
);
const pdf = await readFile(
  new URL("../public/analysis-fixtures.pdf", import.meta.url),
);
assert.equal(
  (await analysisLibraryStatus()).ready,
  true,
  "Domain checks require the pinned installed library; do not silently skip.",
);
async function settle(pipeline, id, expected) {
  const until = Date.now() + 110000;
  while (Date.now() < until) {
    const run = await pipeline.store.getRun(id);
    if (run.status === "blocked") assert.fail(run.error);
    if (run.status === expected && !pipeline.active.has(id)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("Domain run did not reach its expected stage");
}

test(
  "analysis library read permissions still deny external content, external writes and networking",
  { timeout: 60000 },
  async () => {
    const parent = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "lemma-analysis-isolation-")),
    );
    const directory = path.join(parent, "allowed");
    await mkdir(directory);
    const canary = path.join(parent, "outside.txt"),
      output = path.join(parent, "outside-write.txt");
    const marker = "DISPOSABLE_ANALYSIS_CANARY";
    try {
      await writeFile(canary, marker);
      const code = `import Std.Internal.UV.TCP
def main : IO Unit := do
  try
    IO.println (← IO.FS.readFile ${JSON.stringify(canary)})
  catch _ => IO.println "READ_DENIED"
  try
    IO.FS.writeFile ${JSON.stringify(output)} "temporary"
    IO.println "WRITE_SUCCEEDED"
  catch _ => IO.println "WRITE_DENIED"
  try
    let socket ← Std.Internal.UV.TCP.Socket.new
    socket.bind (.v4 { addr := Std.Net.IPv4Addr.ofParts 127 0 0 1, port := 0 })
    socket.listen 1
    IO.println "NETWORK_SUCCEEDED"
  catch _ => IO.println "NETWORK_DENIED"
`;
      await writeFile(path.join(directory, "Canary.lean"), code);
      const binary = path.resolve(
        `.tools/lean-${LEAN_VERSION}-darwin_aarch64/bin/lean`,
      );
      const options = {
        cwd: directory,
        env: { PATH: path.dirname(binary), TMPDIR: directory, LANG: "C.UTF-8" },
      };
      // This unrestricted baseline is trusted test code using generated files and loopback only.
      const baseline = await runBounded(
        binary,
        ["--run", "Canary.lean"],
        options,
      );
      assert.equal(baseline.exitCode, 0);
      for (const text of [marker, "WRITE_SUCCEEDED", "NETWORK_SUCCEEDED"])
        assert.ok(baseline.stdout.includes(text));
      await rm(output);
      const library = await libraryEnvironment("analysis-continuity-v1");
      assert.equal(library.ready, true);
      const isolated = await runBounded(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          sandboxProfile(directory, library.searchPaths),
          binary,
          "--run",
          "Canary.lean",
        ],
        options,
      );
      assert.equal(isolated.exitCode, 0, JSON.stringify(isolated));
      for (const text of ["READ_DENIED", "WRITE_DENIED", "NETWORK_DENIED"])
        assert.ok(isolated.stdout.includes(text));
      assert.ok(!isolated.stdout.includes(marker));
      await assert.rejects(access(output));
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
for (const [pageIndex, item] of fixture.cases.entries()) {
  test(
    `real analysis ${item.label}: PDF -> fixed library -> ${item.expected} -> replay`,
    { timeout: 120000 },
    async () => {
      const folder = await mkdtemp(
        path.join(os.tmpdir(), "lemma-analysis-test-"),
      );
      try {
        const pipeline = new ReviewPipeline({
          store: new EvidenceStore(folder),
          getConfig: async () => null,
        });
        await pipeline.init();
        const first = await pipeline.start({
          mode: "manual",
          libraryProfile: fixture.libraryProfile,
          pdfBase64: pdf.toString("base64"),
          paperSha256: sha256(pdf),
          pageIndex,
          proposal: item,
        });
        const draft = await settle(pipeline, first.id, "awaiting_confirmation");
        assert.equal(draft.contract.libraryProfile, fixture.libraryProfile);
        assert.equal(draft.contract.libraryRevision, MATHLIB_COMMIT);
        await assert.rejects(
          pipeline.approve(first.id, {
            targetHash: draft.contract.targetHash,
            confirmed: true,
            libraryProfile: "std-v1",
            proof: item.proof,
          }),
          /不能修改/,
        );
        await pipeline.approve(first.id, {
          targetHash: draft.contract.targetHash,
          confirmed: true,
          semanticArtifact: draft.semanticArtifact,
          resolutions: draft.semanticReview.issues.map((issue) => ({
            issueId: issue.id,
            decision: "confirmed_with_reason",
            reason:
              "Authored analysis fixture: checked the exact source, interval and quantifiers against the declared target.",
          })),
          proof: item.proof,
          proofMode: item.proofMode,
        });
        const final = await settle(pipeline, first.id, "completed");
        assert.equal(
          final.conclusion.theorem,
          item.expected,
          JSON.stringify(final.check),
        );
        assert.equal(final.conclusion.originalProof, "unverified");
        assert.equal(final.conclusion.wholePaperVerified, false);
        assert.equal(final.check.environment.library.contentVerified, true);
        assert.equal(final.check.environment.library.dependencies.length, 8);
        assert.equal(final.check.environment.library.commit, MATHLIB_COMMIT);
        const bundle = await pipeline.store.bundle(final.root);
        const replay = await pipeline.replay(bundle, final.root);
        assert.equal(replay.reproduced, true, JSON.stringify(replay));
        assert.equal(replay.conclusion.theorem, item.expected);
        assert.equal(replay.revalidated, item.expected !== "unknown");
        const name =
          item.expected === "formalized_proved" ? "proved" : item.expected;
        await writeFile(
          new URL(
            `../evidence/capability-analysis-${name}-bundle.json`,
            import.meta.url,
          ),
          JSON.stringify(bundle, null, 2) + "\n",
        );
        await writeFile(
          new URL(
            `../evidence/capability-analysis-${name}-replay.json`,
            import.meta.url,
          ),
          JSON.stringify(replay, null, 2) + "\n",
        );
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  );
}
