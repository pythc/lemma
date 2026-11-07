import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { cleanReplay } from "../server/clean-replay.mjs";
import { callModel } from "../server/model.mjs";

const output = path.resolve(process.argv[2] || `../math-review-clean-acceptance-${randomUUID()}`);
await mkdir(output, { recursive: false });
const report = { classification: "authored_native_execution_checks_not_model_accuracy", cases: [] };
const pipeline = new ReviewPipeline({ store: new EvidenceStore(path.join(output, "source-store")), getConfig: async () => null });
await pipeline.init();
const fixture = JSON.parse(await readFile(new URL("../fixtures/analysis-cases.json", import.meta.url), "utf8"));
const pdf = await readFile(new URL("../public/analysis-fixtures.pdf", import.meta.url));
const settle = async (id, expected) => {
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const r = await pipeline.store.getRun(id);
    if (!pipeline.active.has(id)) {
      if (r.status !== expected) throw Error(JSON.stringify({ status: r.status, error: r.error }));
      return r;
    }
    await delay(50);
  }
  throw Error("Native fixture exceeded its explicit acceptance time budget");
};
try {
  for (const valid of [true, false]) {
    const item = fixture.cases[0], name = valid ? "accepted" : "rejected";
    const first = await pipeline.start({ mode: "manual", libraryProfile: fixture.libraryProfile,
      pdfBase64: pdf.toString("base64"), paperSha256: sha256(pdf), pageIndex: 0, proposal: item });
    const draft = await settle(first.id, "awaiting_confirmation");
    await pipeline.approve(first.id, { confirmed: true, targetHash: draft.contract.targetHash,
      semanticArtifact: draft.semanticArtifact,
      resolutions: draft.semanticReview.issues.map((i) => ({ issueId: i.id,
        decision: "confirmed_with_reason", reason: "Explicit authored execution fixture; not a research semantic annotation." })),
      proof: valid ? item.proof : "by exact False.elim (by contradiction)", proofMode: "proof" });
    const final = await settle(first.id, "completed");
    assert.equal(final.check.status, valid ? "verified" : "not_verified");
    const file = path.join(output, `${name}.json`);
    await writeFile(file, JSON.stringify(await pipeline.store.bundle(final.root)));
    const replay = await cleanReplay(file, final.root, path.join(output, `${name}-clean`));
    report.cases.push({ name, root: final.root, sourceCheck: final.check, replay });
    assert.equal(replay.reproduced, true, JSON.stringify(replay));
    assert.equal(replay.revalidated, valid);
    if (valid) {
      const mismatch = await cleanReplay(file, "0".repeat(64), path.join(output, "wrong-root"));
      report.wrongRoot = mismatch;
      assert.equal(mismatch.integrity, false);
      assert.equal(mismatch.reproduced, false);
      // Reuse the independent checkout, corrupt its actual compiler and launch a
      // fresh no-model replay. Evidence is retained alongside the rejection.
      const project = path.join(output, `${name}-clean/project`);
      const binary = path.join(project, ".tools/lean-4.35.0-darwin_aarch64/bin/lean");
      await chmod(binary, 0o700);
      await writeFile(binary, "CORRUPTED COMPILER, EXECUTION MUST BE REFUSED\n");
      const { spawnSync } = await import("node:child_process");
      const corruptResult = path.join(output, "corrupt-replay.json");
      const child = spawnSync(process.execPath, ["scripts/replay.mjs", file,
        `--expected-root=${final.root}`, `--output=${corruptResult}`], {
        cwd: project, env: { PATH: "/usr/bin:/bin", LEMMA_REPLAY_OFFLINE: "1" }, timeout: 180_000,
      });
      report.corruptEnvironment = { exitCode: child.status, result: JSON.parse(await readFile(corruptResult, "utf8")) };
      assert.equal(report.corruptEnvironment.result.reproduced, false);
      assert.equal(report.corruptEnvironment.result.revalidated, false);
    }
  }
  process.env.LEMMA_REPLAY_OFFLINE = "1";
  await assert.rejects(callModel({}, {}), { code: "model_disabled_for_replay" });
  delete process.env.LEMMA_REPLAY_OFFLINE;
  report.modelDispatchRejected = true;
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = { message: e.message, code: e.code || null };
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, passed: report.passed, error: report.error || null }));
}
