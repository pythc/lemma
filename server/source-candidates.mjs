import { readdir } from "node:fs/promises";
import path from "node:path";
import { digest, isHash } from "./evidence.mjs";
import { evidenceArtifacts } from "./evidence-io.mjs";
import { obligationContract, kernelAccepted } from "./proof-decomposition.mjs";
import { sameContractMathematics } from "./contract-imports.mjs";
import { sameSourcePassage } from "./source-goal-recovery.mjs";

// A proof bank contains received text and provenance, never an acceptance
// shortcut. Every candidate selected here must be checked against its new goal.
export function candidatesFromSourceSteps(steps = []) {
  return steps
    .filter((s) => s.proof && s.contract && s.check?.status === "verified")
    .map((s) => ({
      name: s.name,
      contract: s.contract,
      anchors: s.anchors || [],
      artifact: s.artifact,
      value: {
        mode: s.check.mode,
        proof: s.proof,
        route: s.claimedRoute || s.route || "independent",
        explanation: s.explanation || "既有候选，等待重新编译",
      },
      check: s.check,
    }));
}
export function sourceCandidateBank(candidates = []) {
  const bank = new Map();
  for (const c of candidates) {
    if (
      !c.contract ||
      !c.value?.proof ||
      !isHash(c.artifact) ||
      !["proof", "counterexample"].includes(c.value.mode)
    )
      continue;
    const value = {
      name: c.name,
      contract: c.contract,
      anchors: c.anchors || [],
      artifact: c.artifact,
      value: c.value,
      check: {
        status: c.check?.status || "pending",
        mode: c.value.mode,
        targetHash: c.contract.targetHash,
        failureKind: c.check?.failureKind || null,
        stdout: String(c.check?.stdout || "")
          .split("\n")
          .filter((l) => !l.startsWith("LEMMA_DEPENDENCIES:"))
          .join("\n")
          .slice(0, 30000),
        stderr: String(c.check?.stderr || "").slice(0, 10000),
        axioms: c.check?.axioms || [],
      },
      originTargetHash: c.originTargetHash || c.contract.targetHash,
      priorVerified: c.priorVerified === true || c.check?.status === "verified",
    };
    const key = digest({
      name: value.name,
      target: value.contract.targetHash,
      proof: value.value.proof,
      mode: value.value.mode,
      anchors: value.anchors,
    });
    if (!bank.has(key) || value.check.status === "verified")
      bank.set(key, value);
  }
  return [...bank.values()];
}
export function candidatesForSourceStep(candidates, step, local) {
  return sourceCandidateBank(candidates)
    .filter(
      (c) =>
        c.contract.sourceArtifact === local.sourceArtifact &&
        ((c.name === step.name && c.contract.leanTarget === local.leanTarget) ||
          sameSourcePassage(c.anchors, step.anchors)),
    )
    .map((c) =>
      c.contract.leanTarget === local.leanTarget
        ? c
        : {
            ...c,
            contract: local,
            originTargetHash: c.contract.targetHash,
            check: {
              status: "pending",
              mode: c.value.mode,
              targetHash: local.targetHash,
            },
          },
    )
    .sort((a, b) => rank(b) - rank(a));
}
function rank(c) {
  return c.check.status === "verified"
    ? 3
    : c.priorVerified
      ? 2
      : c.check.status === "pending"
        ? 1
        : 0;
}

// Read only completed execution receipts whose owning review has this exact
// Agent/source/target identity. This also repairs reachability of historical
// workers whose valid intermediate result was omitted from an old source root.
async function receivedWorkerRoots(store, contract, autonomy) {
  const owners = new Set(),
    workers = [];
  const files = (await readdir(path.join(store.root, "runs"))).filter((f) =>
    /^[a-f0-9-]{36}\.json$/.test(f),
  );
  for (const f of files) {
    const r = await store.getRun(f.slice(0, -5));
    if (r.engine === "deepagents-v1") workers.push(r);
    else if (
      ["completed", "blocked", "interrupted", "cancelled"].includes(r.status) &&
      r.autonomy?.sessionId === autonomy.sessionId &&
      r.autonomy.policy === autonomy.policy &&
      r.contract?.sourceArtifact === contract.sourceArtifact &&
      r.contract.targetHash === contract.targetHash
    ) {
      const root = r.originalProofRoute?.root || r.root;
      if (!root) continue;
      const receipt = await store.get(root);
      const identity =
        receipt.kind === "original_proof_report"
          ? receipt.payload
          : receipt.kind === "original_proof_interrupted" &&
              receipt.payload.runId === r.id
            ? receipt.payload.partial
            : null;
      if (
        identity?.autonomy?.sessionId === autonomy.sessionId &&
        identity.targetHash === contract.targetHash &&
        (receipt.payload.sourceArtifact === contract.sourceArtifact ||
          receipt.inputs.includes(contract.sourceArtifact))
      )
        owners.add(r.id);
    }
  }
  const roots = [];
  for (const w of workers) {
    if (
      !owners.has(w.parentReviewId) ||
      !w.root ||
      !["completed", "blocked", "interrupted", "cancelled"].includes(
        w.status,
      ) ||
      w.contract?.sourceArtifact !== contract.sourceArtifact ||
      w.contract?.proofObligation?.rootTargetHash !== contract.targetHash
    )
      continue;
    const a = await store.get(w.root);
    if (
      !["harness:report", "harness:interrupted"].includes(a.kind) ||
      a.payload.runId !== w.id ||
      a.payload.unknownExternalOutcome
    )
      continue;
    // Execution metadata is not enough: the immutable receipt must also keep its
    // own local contract, or the native-memory records below must establish it.
    if (a.payload.contract && digest(a.payload.contract) !== digest(w.contract))
      continue;
    roots.push(a.id);
  }
  return roots;
}

// Recover received native-checked text, not its old route acceptance. A worker
// can finish check_lean and then exhaust its model budget before its final JSON.
// Such terms must remain candidates across a source-policy/import repair.
export async function recoverReceivedSourceCandidates({
  store,
  root,
  contract,
  graph,
  autonomy,
}) {
  if (!root || !graph || !autonomy) return { candidates: [], artifact: null };
  const origin = await store.get(root);
  let owner = origin;
  if (origin.kind === "autonomous_source_checkpoint_origin") {
    owner = await store.get(origin.payload.sourceRoot);
    if (
      origin.payload.sourceReportSha256 !== digest(owner.payload) ||
      origin.payload.autonomy?.sessionId !== autonomy.sessionId
    )
      throw Error("Received-candidate checkpoint origin changed");
  }
  const saved =
    owner.kind === "original_proof_report"
      ? owner.payload
      : owner.kind === "original_proof_interrupted"
        ? owner.payload.partial
        : null;
  const sourceMatches =
    owner.kind === "original_proof_report"
      ? saved?.sourceArtifact === contract.sourceArtifact
      : owner.kind === "original_proof_interrupted" &&
        owner.inputs.includes(contract.sourceArtifact) &&
        owner.payload.paperSha256 === contract.paperSha256;
  if (
    !saved ||
    saved.autonomy?.sessionId !== autonomy.sessionId ||
    !sourceMatches
  )
    throw Error(
      "Received-candidate owner is not the current Agent/source session",
    );
  // Root target changes need independent source-goal recovery; do not reinterpret
  // old memory merely because its displayed target text happens to look alike.
  if (
    saved.targetHash !== contract.targetHash ||
    digest(saved.graph) !== digest(graph)
  )
    return { candidates: [], artifact: null };
  const expected = new Map(
    graph.steps
      .filter(
        (s) =>
          s.target &&
          s.dependsOn.every(
            (n) => graph.steps.find((d) => d.name === n)?.target,
          ),
      )
      .map((s) => [
        s.name,
        {
          step: s,
          contract: obligationContract(
            contract,
            s.name,
            s.target,
            s.dependsOn.map((n) => graph.steps.find((d) => d.name === n)),
          ),
        },
      ]),
  );
  const received = [];
  const rejected = [];
  const workerRoots = await receivedWorkerRoots(store, contract, autonomy);
  const seenArtifacts = new Set(),
    usedRoots = new Set();
  for (const receivedRoot of [root, ...workerRoots])
    for await (const a of evidenceArtifacts(store, receivedRoot)) {
      if (seenArtifacts.has(a.id)) continue;
      seenArtifacts.add(a.id);
      const p = a.payload;
      if (
        a.kind !== "proof:memory" ||
        p.branch?.autonomySession !== autonomy.sessionId ||
        p.contract?.sourceArtifact !== contract.sourceArtifact ||
        p.contract?.proofObligation?.rootTargetHash !== contract.targetHash ||
        !kernelAccepted(p.check, p.contract) ||
        p.check.targetHash !== p.contract.targetHash ||
        !["proof", "counterexample"].includes(p.mode) ||
        typeof p.proof !== "string" ||
        !p.proof.trim() ||
        p.proof.length > 1000000
      )
        continue;
      const local = expected.get(p.contract.proofObligation.name);
      if (!local || p.contract.leanTarget !== local.contract.leanTarget)
        continue;
      try {
        if (!sameContractMathematics(local.contract, p.contract)) {
          rejected.push({
            artifact: a.id,
            reason: "mathematical_metadata_or_definition_changed",
          });
          continue;
        }
      } catch (error) {
        rejected.push({
          artifact: a.id,
          reason: String(error.message).slice(0, 300),
        });
        continue;
      }
      usedRoots.add(receivedRoot);
      received.push({
        name: local.step.name,
        contract: p.contract,
        anchors: local.step.anchors,
        artifact: a.id,
        value: {
          mode: p.mode,
          proof: p.proof,
          route: "completion",
          explanation:
            "同一 Agent 会话中已收到的工具候选；旧策略及环境的接受状态不继承，重新编译并复核路线",
        },
        check: p.check,
      });
    }
  const counts = new Map();
  const candidates = sourceCandidateBank(received)
    .sort((a, b) => a.value.proof.length - b.value.proof.length)
    .filter((c) => {
      const n = counts.get(c.name) || 0;
      counts.set(c.name, n + 1);
      return n < 8;
    })
    .slice(0, 256);
  if (!candidates.length && !rejected.length)
    return { candidates: [], artifact: null };
  const artifact = await store.put(
    "original:received_candidate_recovery",
    {
      sourceArtifact: contract.sourceArtifact,
      targetHash: contract.targetHash,
      autonomy,
      ownerRoot: root,
      recoveredWorkerRoots: [...usedRoots].filter((r) => r !== root),
      rejected,
      candidates: candidates.map((c) => ({
        name: c.name,
        artifact: c.artifact,
        targetHash: c.contract.targetHash,
      })),
      scope:
        "same_session_received_text_only_new_native_and_route_checks_required",
    },
    [
      root,
      ...usedRoots,
      ...new Set([
        ...candidates.map((c) => c.artifact),
        ...rejected.map((c) => c.artifact),
      ]),
    ],
  );
  return { candidates, artifact };
}
