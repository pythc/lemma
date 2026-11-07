import { randomUUID } from "node:crypto";
import { OriginalProofEngine, replayOriginalProof } from "./original-proof.mjs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { executionContext } from "./execution-context.mjs";
import { candidatesFromSourceSteps } from "./source-candidates.mjs";
import { evidenceArtifacts } from "./evidence-io.mjs";
import { kernelAccepted } from "./proof-decomposition.mjs";
import { digest } from "./evidence.mjs";
import { rebindTheoremText } from "./source-theorem.mjs";
import { checkProof } from "./lean.mjs";
import { policyRequestUnknown } from "./source-policy.mjs";
import { freshProofSession, assertProofSession } from "./proof-autonomy.mjs";

export function inheritedHarnessTasks(previous) {
  if (!previous) return [];
  const tools = (previous.tasks || []).filter((t) => t.role === "HARNESS_TOOL"),
    parents = new Set(tools.flatMap((t) => t.parents || []));
  return [
    ...new Map(
      [
        ...(previous.inheritedHarnessTasks || []),
        ...(previous.tasks || [])
          .filter((t) => t.role === "HARNESS_TOOL" || parents.has(t.id))
          .map((t) => ({
            ...t,
            originRunId: previous.id,
            originRoot: previous.root,
            historical: true,
          })),
      ].map((t) => [t.id, t]),
    ).values(),
  ];
}

export function inheritedUnknownPolicyTasks(previous) {
  return (previous?.tasks || [])
    .filter(
      (t) =>
        t.role === "R06_POLICY_AUDIT" &&
        (t.externalOutcome === "unknown" ||
          (t.modelStartedAt &&
            !t.output &&
            ["interrupted", "cancelled", "blocked"].includes(t.status))),
    )
    .map((t) => ({
      id: t.id,
      inputs: t.inputs || [],
      originRunId: previous.id,
      modelStartedAt: t.modelStartedAt || null,
      externalOutcome: "unknown",
    }));
}

export class OriginalProofService {
  constructor({ store, getConfig, model, checker, limits }) {
    Object.assign(this, { store, getConfig, model, checker, limits });
    this.active = new Map();
  }
  async receivedTheoremCandidate(rootRun) {
    const files = await readdir(path.join(this.store.root, "runs"));
    const ids = [
      rootRun.id,
      ...files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)),
    ];
    for (const id of new Set(ids)) {
      const prior = id === rootRun.id ? rootRun : await this.store.getRun(id);
      if (
        !prior.proofArtifact ||
        !prior.contract ||
        prior.paperSha256 !== rootRun.paperSha256 ||
        prior.contract.sourceArtifact !== rootRun.contract.sourceArtifact ||
        prior.contract.leanTarget !== rootRun.contract.leanTarget ||
        !kernelAccepted(prior.check, prior.contract)
      )
        continue;
      try {
        const proof = await this.store.get(prior.proofArtifact);
        const candidate = await rebindTheoremText(
          this.store,
          rootRun,
          prior,
          proof,
        );
        if (candidate) return candidate;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    return null;
  }
  async recheckKnownTheorem(id) {
    const base = await this.store.getRun(id);
    if (base.engine !== "original-proof-v1" || base.status !== "completed")
      throw Error(
        "Theorem-only continuation requires a completed source report",
      );
    const old = await this.store.get(base.root),
      p = old.payload;
    if (
      old.kind !== "original_proof_report" ||
      ![3, 4].includes(p.proofPolicyVersion) ||
      p.sourceAlignmentPolicyVersion !== 3 ||
      digest(p.contract) !== digest(base.contract)
    )
      throw Error("Source report scope or policy changed");
    if (
      p.independentTheorem?.status === "verified" ||
      p.assembly.status === "verified"
    )
      return base;
    const candidate = await this.receivedTheoremCandidate(base);
    if (!candidate) return base;
    const run = {
      ...base,
      id: randomUUID(),
      continuedFrom: base.id,
      status: "running",
      certificateOnly: true,
      verificationOnly: false,
      goalRecoveryOnly: false,
      createdAt: new Date().toISOString(),
      endedAt: null,
      root: null,
      error: null,
      tasks: [],
    };
    const task = {
      id: randomUUID(),
      role: "R06_THEOREM",
      type: "original-proof",
      title: "复查已有主命题证明",
      status: "running",
      inputs: [base.root, ...candidate.inputs],
      startedAt: new Date().toISOString(),
      output: null,
    };
    run.tasks.push(task);
    await this.store.saveRun(run);
    try {
      const check = await (this.checker || checkProof)(
        candidate.contract,
        candidate.proof,
        { dependencyAudit: true },
      );
      const value = {
        scope: "exact_target_only_not_original_route",
        contract: candidate.contract,
        proof: candidate.proof,
        check,
        status: kernelAccepted(check, candidate.contract)
          ? "verified"
          : "unverified",
        rootTargetHash: base.contract.targetHash,
        originTargetHash: candidate.originTargetHash,
      };
      const artifact = await this.store.put(
        "original:R06_THEOREM",
        value,
        task.inputs,
      );
      task.status = "succeeded";
      task.output = artifact;
      task.endedAt = new Date().toISOString();
      const report = {
        ...p,
        strategy: "received_report_theorem_check",
        independentTheorem: { ...value, artifact },
        theoremCheckArtifacts: [...(p.theoremCheckArtifacts || []), artifact],
        theoremContinuation: {
          fromRoot: base.root,
          rootTargetHash: base.contract.targetHash,
        },
        endedAt: new Date().toISOString(),
      };
      run.root = await this.store.put("original_proof_report", report, [
        ...old.inputs,
        base.root,
        artifact,
      ]);
      run.originalProofRoute = { ...report, root: run.root };
      run.check = check;
      run.conclusion = {
        ...base.conclusion,
        theorem: value.status === "verified" ? "formalized_proved" : "unknown",
      };
      run.status = "completed";
    } catch (e) {
      task.status = "failed";
      task.error = e.message;
      run.status = "blocked";
      run.error = e.message;
      run.root = await this.store.put(
        "original_proof_interrupted",
        { runId: run.id, error: e.message },
        task.inputs,
      );
    }
    run.endedAt = new Date().toISOString();
    await this.store.saveRun(run);
    return run;
  }
  async init() {
    for (const file of await readdir(path.join(this.store.root, "runs"))) {
      if (!file.endsWith(".json")) continue;
      const r = await this.store.getRun(file.slice(0, -5));
      if (r.engine === "original-proof-v1" && r.status === "running") {
        r.status = "interrupted";
        r.error = "服务中断；保留已完成步骤，未自动重发结果未知的请求。";
        for (const t of r.tasks)
          if (["running", "queued"].includes(t.status)) {
            t.status = "interrupted";
            t.externalOutcome = t.modelStartedAt
              ? "unknown"
              : "not_sent_or_local_tool_only";
          }
        await this.store.saveRun(r);
      }
    }
  }
  async start({
    reviewRunId,
    continuedFrom = null,
    verificationOnly = false,
    goalRecoveryOnly = false,
    replayUnknown = false,
  }) {
    const parent = await this.store.getRun(reviewRunId);
    if (!parent.contract || !parent.context || !parent.sourceArtifact)
      throw Error("需要已固定的论文原文与形式目标");
    let previous = null;
    if (continuedFrom) {
      previous = await this.store.getRun(continuedFrom);
      if (previous.id === reviewRunId) {
        // A completed pipeline review embeds the same Agent-generated source
        // route. Its immutable receipt, target and session must all agree.
        const route = previous.originalProofRoute;
        if (
          !["completed", "blocked", "interrupted", "cancelled"].includes(
            previous.status,
          ) ||
          !route?.graph ||
          !route.graphArtifact ||
          !route.root ||
          route.sourceArtifact !== parent.sourceArtifact ||
          route.targetHash !== parent.contract.targetHash ||
          digest(route.contract) !== digest(parent.contract) ||
          !parent.autonomy
        )
          throw Error("Invalid embedded source-proof continuation");
        assertProofSession(parent.autonomy, { resume: route });
        const saved = await this.store.get(route.root);
        if (
          saved.kind !== "original_proof_report" ||
          saved.payload.sourceArtifact !== parent.sourceArtifact ||
          digest(saved.payload.contract) !== digest(parent.contract) ||
          saved.payload.autonomy?.sessionId !== parent.autonomy.sessionId ||
          saved.payload.graphArtifact !== route.graphArtifact ||
          digest(saved.payload.graph) !== digest(route.graph)
        )
          throw Error("Embedded source-proof checkpoint identity changed");
      } else if (
        previous.engine !== "original-proof-v1" ||
        previous.reviewRunId !== reviewRunId ||
        previous.status === "running"
      )
        throw Error("Invalid original-proof continuation");
    }
    if (
      (verificationOnly || goalRecoveryOnly) &&
      (!previous?.originalProofRoute?.graph ||
        !previous?.originalProofRoute?.review)
    )
      throw Error("固定候选重查需要已有的原证明图与语义复核记录");
    if (verificationOnly && goalRecoveryOnly)
      throw Error("固定候选重查与目标补全不能同时启用");
    const config = await this.getConfig();
    if (!config) throw Error("模型尚未配置");
    if ([...this.active.values()].some((x) => x.reviewRunId === reviewRunId))
      throw Error("该证明路线正在核验");
    const r = {
      id: randomUUID(),
      engine: "original-proof-v1",
      reviewRunId,
      paperSha256: parent.paperSha256,
      contract: parent.contract,
      continuedFrom,
      continuedFromEmbedded: continuedFrom === reviewRunId,
      verificationOnly: verificationOnly === true,
      goalRecoveryOnly: goalRecoveryOnly === true,
      replayUnknown: replayUnknown === true,
      sourceArtifact: parent.sourceArtifact,
      contractArtifact: parent.contractArtifact,
      contextArtifact: parent.contextArtifact,
      pageIndex: parent.contract.pageIndex,
      status: "running",
      createdAt: new Date().toISOString(),
      tasks: [],
      originalProofRoute: null,
      autonomy: previous
        ? previous.originalProofRoute?.autonomy || previous.autonomy || null
        : freshProofSession(),
      inheritedHarnessTasks: inheritedHarnessTasks(previous),
      root: null,
    };
    const controller = new AbortController();
    controller.reviewRunId = reviewRunId;
    this.active.set(r.id, controller);
    await this.store.saveRun(r);
    void this.execute(r, parent, config, controller, previous).finally(() =>
      this.active.delete(r.id),
    );
    return r;
  }
  async execute(r, parent, config, controller, previous = null) {
    try {
      const engine = new OriginalProofEngine({
        store: this.store,
        model: this.model,
        checker: this.checker,
        limits: this.limits,
        onProgress: async (route) => {
          r.originalProofRoute = route;
          await this.store.saveRun(r);
        },
      });
      const task = async (role, title, inputs, action) => {
        const t = {
          id: randomUUID(),
          role,
          title,
          type: "original-proof",
          inputs,
          status: "running",
          output: null,
          startedAt: new Date().toISOString(),
        };
        r.tasks.push(t);
        await this.store.saveRun(r);
        try {
          const value = await executionContext.run(
            {
              run: r,
              task: t,
              onModelQueued: async () => {
                t.status = "queued";
                t.queuedAt = new Date().toISOString();
                await this.store.saveRun(r);
              },
              onModelStarted: async () => {
                t.status = "running";
                t.modelStartedAt = new Date().toISOString();
                await this.store.saveRun(r);
              },
              onToolQueued: async () => {
                t.status = "queued";
                await this.store.saveRun(r);
              },
              onToolStarted: async () => {
                t.status = "running";
                await this.store.saveRun(r);
              },
            },
            action,
          );
          t.output = await this.store.put(`original:${role}`, value, [
            ...inputs,
            ...(value.model?.harnessRoot ? [value.model.harnessRoot] : []),
          ]);
          t.status = "succeeded";
          t.endedAt = new Date().toISOString();
          await this.store.saveRun(r);
          return { value, artifact: t.output };
        } catch (e) {
          if (
            role === "R06_POLICY_AUDIT" &&
            policyRequestUnknown(e.modelRecord)
          )
            t.externalOutcome = "unknown";
          t.error = e.message;
          t.status = "blocked";
          t.endedAt = new Date().toISOString();
          t.output = await this.store.put(
            "original:task_failure",
            { error: e.message, model: e.modelRecord || null },
            [...inputs, ...(e.harnessRoot ? [e.harnessRoot] : [])],
          );
          await this.store.saveRun(r);
          throw e;
        }
      };
      const candidateCache = [
        ...(previous?.originalProofRoute?.candidateCache || []),
      ];
      if (previous)
        for (const t of previous.tasks.filter(
          (t) => t.output && ["R06_STEP", "R06_REPAIR"].includes(t.role),
        )) {
          const a = await this.store.get(t.output),
            v = a.payload;
          const name = t.title.match(/(?:^|：)([A-Z][A-Za-z0-9_]*) ·/)?.[1];
          if (name && v.check && v.value?.proof) {
            const step = previous.originalProofRoute?.graph?.steps.find(
              (s) => s.name === name,
            );
            if (!step) continue;
            const { obligationContract } =
              await import("./proof-decomposition.mjs");
            const derived =
              v.contract ||
              obligationContract(
                parent.contract,
                name,
                step.target,
                step.dependsOn.map((n) =>
                  previous.originalProofRoute.graph.steps.find(
                    (s) => s.name === n,
                  ),
                ),
              );
            if (derived.targetHash === v.check.targetHash)
              candidateCache.unshift({
                name,
                ...v,
                anchors: step.anchors,
                contract: derived,
                artifact: t.output,
              });
          }
        }
      const priorNotes = new Map();
      if (previous?.root) {
        for await (const a of evidenceArtifacts(this.store, previous.root))
          if (
            a.kind === "original:step_result" &&
            a.payload.contract?.sourceArtifact === parent.sourceArtifact
          )
            candidateCache.push(
              ...candidatesFromSourceSteps([{ ...a.payload, artifact: a.id }]),
            );
          else if (
            a.kind === "original:local_candidate" &&
            a.payload.contract?.sourceArtifact === parent.sourceArtifact &&
            a.payload.value?.proof
          ) {
            let graph;
            for (const id of a.inputs) {
              const candidate = (await this.store.get(id)).payload.graph;
              if (candidate?.steps?.some((s) => s.name === a.payload.name)) {
                graph = candidate;
                break;
              }
            }
            const step = graph?.steps.find((s) => s.name === a.payload.name);
            if (step)
              candidateCache.push({
                name: a.payload.name,
                contract: a.payload.contract,
                value: a.payload.value,
                anchors: step.anchors,
                artifact: a.id,
                check: { status: "pending" },
              });
          }
      }
      if (previous?.originalProofRoute?.graphArtifact)
        for (const t of previous.tasks.filter(
          (t) =>
            t.role === "R06_DIAGNOSE" &&
            t.output &&
            t.inputs?.includes(previous.originalProofRoute.graphArtifact),
        )) {
          const a = await this.store.get(t.output),
            v = a.payload.value;
          const name = t.title.match(/(?:^|：)([A-Z][A-Za-z0-9_]*) ·/)?.[1];
          const step = previous.originalProofRoute.graph.steps.find(
            (s) => s.name === name,
          );
          if (v?.kind === "translation" && step?.target)
            priorNotes.set(name, {
              name,
              target: step.target,
              diagnosticArtifact: t.output,
              kind: v.kind,
              targetChangeRequired: v.targetChangeRequired === true,
              explanation: String(v.explanation || "").slice(0, 8000),
            });
        }
      const sourceFeedback = [...priorNotes.values()].slice(0, 64);
      const sourceFeedbackArtifact = sourceFeedback.length
        ? await this.store.put(
            "original:prior_diagnostics",
            {
              graphArtifact: previous.originalProofRoute.graphArtifact,
              notes: sourceFeedback,
            },
            [previous.root, ...sourceFeedback.map((n) => n.diagnosticArtifact)],
          )
        : null;
      const theoremCandidate = r.autonomy
        ? null
        : await this.receivedTheoremCandidate(parent);
      r.originalProofRoute = await engine.review({
        ...parent,
        config,
        autonomy: r.autonomy,
        signal: controller.signal,
        task,
        replayUnknown: r.replayUnknown,
        verificationOnly: r.verificationOnly,
        goalRecoveryOnly: r.goalRecoveryOnly,
        theoremCandidate,
        sourceFeedback,
        sourceFeedbackArtifact,
        resume: previous
          ? {
              ...previous.originalProofRoute,
              autonomy:
                previous.originalProofRoute?.autonomy ||
                previous.autonomy ||
                null,
              root: previous.root,
              candidateCache,
              unknownPolicyTasks: inheritedUnknownPolicyTasks(previous),
            }
          : null,
      });
      r.conclusion = {
        headline: r.originalProofRoute.summary.headline,
        originalProof: r.originalProofRoute.summary.status,
        theorem:
          r.originalProofRoute.assembly.status === "verified" ||
          r.originalProofRoute.independentTheorem?.status === "verified"
            ? "formalized_proved"
            : "unknown",
        wholePaperVerified: false,
      };
      r.check =
        r.originalProofRoute.independentTheorem?.status === "verified"
          ? r.originalProofRoute.independentTheorem.check
          : r.originalProofRoute.assembly.check || null;
      r.root = r.originalProofRoute.root;
      r.status = controller.signal.aborted ? "cancelled" : "completed";
    } catch (e) {
      r.status = controller.signal.aborted ? "cancelled" : "blocked";
      r.error = e.message;
      r.root = await this.store.put(
        "original_proof_interrupted",
        {
          runId: r.id,
          paperSha256: r.paperSha256,
          error: e.message,
          model: e.modelRecord || null,
          partial: r.originalProofRoute,
        },
        [
          r.sourceArtifact,
          r.contractArtifact,
          ...r.tasks.map((t) => t.output).filter(Boolean),
          ...(r.originalProofRoute?.receivedArtifacts || []),
          ...(r.originalProofRoute?.candidateCache || []).map(
            (c) => c.artifact,
          ),
        ],
      );
    }
    r.endedAt = new Date().toISOString();
    await this.store.saveRun(r);
  }
  async cancel(id) {
    const r = await this.store.getRun(id);
    if (r.engine !== "original-proof-v1") throw Error("Invalid route run");
    this.active.get(id)?.abort();
    return r;
  }
  async list(paperSha256) {
    const items = [];
    for (const f of await readdir(path.join(this.store.root, "runs"))) {
      if (!f.endsWith(".json")) continue;
      const r = await this.store.getRun(f.slice(0, -5));
      if (r.engine === "original-proof-v1" && r.paperSha256 === paperSha256)
        items.push(r);
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async replay(id) {
    const r = await this.store.getRun(id);
    return replayOriginalProof(
      await this.store.bundle(r.root),
      r.root,
      this.checker,
    );
  }
}
