import { writeFile, mkdir, readFile } from "node:fs/promises";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { OriginalProofService } from "../server/original-proof-service.mjs";
import { modelConfig } from "../server/model.mjs";
import { writeEvidenceFile } from "../server/evidence-io.mjs";
import { missingSourceGoals } from "../server/source-goal-recovery.mjs";
const out = "evidence/original-proof-20261019";
await mkdir(out, { recursive: true });
const store = new EvidenceStore(".runtime/original-proof-20261019/store");
await store.init();
const baseline = [
  ["bolzano-weierstrass", "ad575b42-d11e-479d-a26b-d0513940a02e"],
  ["yang-zhu", "270eb3a5-6e59-4a4a-99de-a99b068ef774"],
];
const service = new OriginalProofService({
  store,
  getConfig: () => modelConfig(process.cwd()),
});
async function readReceipt(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
const snapshot = ".runtime/original-proof-20261019/final-audit-loaded-source";
await mkdir(snapshot, { recursive: true });
const sourceIdentity = await Promise.all(
  [
    "server/original-proof.mjs",
    "server/lean-dependencies.mjs",
    "server/original-proof-service.mjs",
    "server/source-candidates.mjs",
    "server/evidence.mjs",
    "server/evidence-io.mjs",
    "server/runtime-limits.mjs",
    "server/source-goal-recovery.mjs",
    "server/source-theorem.mjs",
    "server/pipeline.mjs",
    "scripts/recheck-original-proof-candidates.mjs",
  ].map(async (path) => {
    const bytes = await readFile(path);
    await writeFile(`${snapshot}/${path.split("/").at(-1)}`, bytes);
    return { path, sha256: sha256(bytes) };
  }),
);
await writeFile(
  `${out}/final-audit-source-identities.json`,
  JSON.stringify(sourceIdentity, null, 2),
);
async function waitActive(targets, phase) {
  let last = "";
  while (service.active.size) {
    const states = await Promise.all(
      targets.map(async (t) => {
        const r = await store.getRun(t.id);
        return {
          ...t,
          status: r.status,
          active: r.tasks
            .filter((t) => ["running", "queued"].includes(t.status))
            .map((t) => [t.role, t.title, t.status]),
          steps:
            r.originalProofRoute?.steps?.map((s) => [s.name, s.status]) || [],
        };
      }),
    );
    const value = JSON.stringify({ phase, states });
    if (value !== last) console.log(value);
    last = value;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
async function dispatch(
  parents,
  phase,
  verificationOnly,
  goalRecoveryOnly = false,
) {
  const suffix =
    phase === "autonomous"
      ? "autonomous-policy2"
      : phase === "recovery"
        ? "target-recovery-policy2"
        : "candidate-audit-policy3";
  const receipt = `${out}/${suffix}-runs.json`;
  const old = await readReceipt(receipt);
  if (old) {
    if (old.length !== parents.length)
      throw Error(
        "Incomplete dispatch receipt: inspect existing jobs before proceeding.",
      );
    for (const t of old)
      if ((await store.getRun(t.id)).status === "running")
        throw Error(
          "Existing review may still be active. Inspect it; do not silently replay.",
        );
    return old;
  }
  const targets = [];
  for (const parent of parents) {
    const name = parent.name || parent[0],
      id = parent.id || parent[1],
      r = await store.getRun(id);
    if (r.status === "running") throw Error("Prior review still active");
    const completeGraph =
      r.originalProofRoute?.graph && r.originalProofRoute?.review;
    const knownBudgetCheckpoint =
      !verificationOnly &&
      r.originalProofRoute?.graph &&
      r.error?.includes("原证明核验达到运行限制");
    if (!completeGraph && !knownBudgetCheckpoint)
      throw Error("No completed source graph and semantic checkpoint");
    const next = await service.start({
      reviewRunId: r.reviewRunId,
      continuedFrom: id,
      verificationOnly,
      replayUnknown: false,
      goalRecoveryOnly,
    });
    targets.push({ name, id: next.id, continuedFrom: id });
    await writeFile(receipt, JSON.stringify(targets, null, 2));
    console.log(
      JSON.stringify({ event: "dispatched", phase, name, id: next.id }),
    );
  }
  await waitActive(targets, phase);
  return targets;
}
async function saveResults(targets, suffix, replay) {
  for (const { name, id } of targets) {
    const r = await store.getRun(id);
    await writeFile(`${out}/${name}-${suffix}-result.json`, JSON.stringify(r));
    if (r.root)
      await writeEvidenceFile(
        `${out}/${name}-${suffix}-bundle.ndjson`,
        store,
        r.root,
      );
    const summary = {
      name,
      id,
      status: r.status,
      root: r.root,
      summary: r.originalProofRoute?.summary,
      error: r.error || null,
      steps: r.originalProofRoute?.steps?.map((s) => ({
        name: s.name,
        title: s.title,
        status: s.status,
        check: s.check?.status || null,
        mode: s.check?.mode || null,
        route: s.route || null,
        assessment: s.routeAssessment?.explanation || null,
        explanation: s.explanation,
        artifact: s.artifact,
      })),
    };
    if (replay && r.status === "completed") {
      try {
        const v = await service.replay(id);
        await writeFile(
          `${out}/${name}-${suffix}-replay.json`,
          JSON.stringify(v, null, 2),
        );
        summary.replay = {
          reproduced: v.reproduced,
          replayedChecks: v.replayedChecks,
          uncheckedSteps: v.uncheckedSteps,
          allStepsVerified: v.allStepsVerified,
        };
      } catch (e) {
        summary.replayError = e.message;
      }
    }
    await writeFile(
      `${out}/${name}-${suffix}-summary.json`,
      JSON.stringify(summary, null, 2),
    );
    console.log(
      JSON.stringify({ event: "results_saved", phase: suffix, ...summary }),
    );
  }
}
while (
  (
    await Promise.all(
      baseline.map(async ([_, id]) => (await store.getRun(id)).status),
    )
  ).includes("running")
)
  await new Promise((r) => setTimeout(r, 2000));
const autonomous = await dispatch(baseline, "autonomous", false);
await saveResults(autonomous, "autonomous-policy2", false);
const needRecovery = [];
for (const t of autonomous) {
  const r = await store.getRun(t.id);
  if (
    r.originalProofRoute?.review &&
    missingSourceGoals(r.originalProofRoute.graph).length
  )
    needRecovery.push(t);
}
const recovered = needRecovery.length
  ? await dispatch(needRecovery, "recovery", false, true)
  : [];
if (recovered.length)
  await saveResults(recovered, "target-recovery-policy2", false);
const auditParents = autonomous.map(
  (t) => recovered.find((r) => r.name === t.name) || t,
);
let audited = await readReceipt(`${out}/policy2-runs.json`);
if (audited) {
  if (audited.length !== auditParents.length)
    throw Error("Incomplete final receipt: inspect it before continuing.");
  for (const t of audited)
    if ((await store.getRun(t.id)).status === "running")
      throw Error("A final audit is active; do not duplicate it.");
} else {
  const ready = [],
    pending = [];
  for (const t of auditParents) {
    const r = await store.getRun(t.id),
      p = r.originalProofRoute;
    if (
      r.status === "completed" &&
      r.goalRecoveryOnly === true &&
      p.proofPolicyVersion === 3 &&
      p.sourceAlignmentPolicyVersion === 3 &&
      p.strategy === "missing_targets_received_candidates"
    ) {
      const receipt = `${out}/root-certificate-policy3-runs.json`;
      const known = (await readReceipt(receipt)) || [];
      let item = known.find((v) => v.name === t.name);
      if (!item) {
        const closed = await service.recheckKnownTheorem(t.id);
        if (closed.status !== "completed")
          throw Error("Theorem continuation did not complete");
        item = {
          name: t.name,
          id: closed.id,
          continuedFrom: closed.continuedFrom || t.id,
        };
        known.push(item);
        await writeFile(receipt, JSON.stringify(known, null, 2));
      } else if ((await store.getRun(item.id)).status !== "completed") {
        throw Error("Theorem continuation remains active or incomplete");
      }
      ready.push(item);
    } else pending.push(t);
  }
  // Missing-target recovery already scans received candidates with the final
  // policy. Replaying its immutable report is the independent confirmation;
  // repeating the identical full candidate scan adds no evidence layer.
  const checked = pending.length ? await dispatch(pending, "audit", true) : [];
  audited = auditParents.map((t) =>
    [...ready, ...checked].find((v) => v.name === t.name),
  );
  await writeFile(`${out}/policy2-runs.json`, JSON.stringify(audited, null, 2));
}
await saveResults(audited, "policy2", true);
