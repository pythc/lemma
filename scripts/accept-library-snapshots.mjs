// Real native/cache acceptance with an explicitly authored execution fixture.
// This is not an autonomous paper or a mathematical generalization benchmark.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createContract } from "../server/contracts.mjs";
import { sha256, digest } from "../server/evidence.mjs";
import { checkProof } from "../server/lean.mjs";
import { libraryAccess } from "../server/library-access.mjs";
import { withLibrarySnapshot } from "../server/libraries.mjs";
import { moduleManifest, ensureDomainModules } from "../server/domain-library.mjs";

const fixture = "Authored execution fixture: the square of every real number is nonnegative.";
const contract = createContract({
  text: fixture, paperSha256: sha256(fixture), pageIndex: 0, artifact: sha256("fixture-source"),
}, {
  label: "snapshot execution fixture", quote: fixture, statement: fixture,
  assumptions: [], leanTarget: "∀ x : ℝ, 0 ≤ x ^ 2",
}, "analysis-continuity-v1");
const proof = "by intro x; exact sq_nonneg x";

if (process.argv[2] === "--worker") {
  process.send({ event: "attempting" });
  try {
    const mode = process.argv[3], id = process.argv[4];
    const result = mode === "extend"
      ? await ensureDomainModules(await moduleManifest(["Mathlib.Analysis.SpecialFunctions.Bessel"]))
      : await withLibrarySnapshot(id, () => checkProof(contract, proof));
    process.send({ event: "result", result });
  } catch (error) {
    process.send({ event: "failure", message: error.message, code: error.code, domain: error.domainRecord || null });
  }
  process.disconnect();
} else {
  const out = path.resolve(process.argv[2] || `evidence/foundations-20261021/09-native-${randomUUID()}`);
  await mkdir(out, { recursive: false });
  const report = {
    classification: "authored_execution_fixture_real_Lean_and_official_cache_not_paper_accuracy",
    startedAt: new Date().toISOString(), contract, proof,
  };
  const children = [];
  const worker = (mode, id = "") => {
    const child = fork(new URL(import.meta.url), ["--worker", mode, id], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    children.push(child);
    let attempting, finish;
    const started = new Promise((r) => (attempting = r));
    const result = new Promise((r) => (finish = r));
    const state = { started, result, enteredResult: false };
    child.on("message", (m) => {
      if (m.event === "attempting") attempting();
      else { state.enteredResult = true; finish(m); }
    });
    child.on("exit", (code, signal) => {
      attempting();
      if (!state.enteredResult) finish({ event: "failure", message: `Worker exited: ${code ?? signal}` });
    });
    return state;
  };
  try {
    console.log("Checking actual Lean against a sealed Mathlib snapshot");
    report.before = await checkProof(contract, proof);
    assert.equal(report.before.status, "verified", JSON.stringify(report.before));
    const id = report.before.environment.library.snapshot.id;
    let update;
    await libraryAccess.read(async () => {
      update = worker("extend");
      await update.started;
      await delay(500);
      report.writerExcludedWhileReadHeld = !update.enteredResult;
      assert.equal(report.writerExcludedWhileReadHeld, true);
    });
    console.log("Acquiring the pinned official Bessel module in the isolated cache");
    report.extension = await update.result;
    assert.equal(report.extension.event, "result", JSON.stringify(report.extension));
    assert.equal(report.extension.result.status, "ready");
    assert.equal(report.extension.result.acquisition, "pinned_official_cache_append",
      "This acceptance requires a genuine cache extension; use a fresh isolated cache when repeating.");
    console.log("Rechecking the original snapshot in a separate Node process");
    report.replay = await worker("check", id).result;
    assert.equal(report.replay.event, "result", JSON.stringify(report.replay));
    assert.equal(report.replay.result.status, "verified");
    assert.equal(digest(report.before.environment), digest(report.replay.result.environment));
    assert.equal(report.before.sourceSha256, report.replay.result.sourceSha256);
    report.sameOriginalEnvironment = true;
    report.newPublicationDiffers = report.extension.result.after.sha256 !== id;
    assert.equal(report.newPublicationDiffers, true);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = { message: error.message, code: error.code || null };
    process.exitCode = 1;
  } finally {
    report.endedAt = new Date().toISOString();
    await writeFile(path.join(out, "result.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ output: out, passed: report.passed, error: report.error || null }));
    for (const c of children)
      if (c.connected) c.disconnect();
  }
}
