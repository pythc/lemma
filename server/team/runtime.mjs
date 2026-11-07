import { RunProjection } from "./run-projection.mjs";
import { resumeContext } from "./resume-context.mjs";
import { proofReceiptSummary } from "./public-view.mjs";
import { selectEvidence } from "./evidence-view.mjs";
import http from "node:http";
import { TeamOperations, operationSettled } from "./operations.mjs";
import { boardView, readBoardObject } from "./board.mjs";
import { resolveSourceSpans } from "./source-spans.mjs";
import { randomUUID, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { extractPaper } from "../pdf.mjs";
import { digest, sha256 } from "../evidence.mjs";
import { TEAM_TOOLS, validateToolCall } from "./tool-catalog.mjs";
import { teamPrompt } from "./prompts.mjs";
import { validateAcceptance } from "./acceptance.mjs";
import {
  resolveArguments,
  registerRunObjects,
  registerArtifactReferences,
  registerReference,
  referenceProjection,
  resolveReference,
} from "./references.mjs";
import { errorView } from "./tool-errors.mjs";
import { validateCheckpoint } from "./checkpoint.mjs";
import {
  newObjective,
  getObjective,
  checkObjectiveGraph,
  requiredObjectives,
  unresolvedObjectives,
  invalidateObjectives,
  validateStopProposal,
  validateObjectiveDecisions,
} from "./objectives.mjs";

const copy = (v) => JSON.parse(JSON.stringify(v));
const terminal = (s) =>
  ["completed", "unresolved", "failed", "cancelled"].includes(s);
const text = (v) => {
  if (typeof v !== "string" || !v.trim()) throw Error("Required text is empty");
  return v;
};
export class TeamRuntime {
  constructor({
    store,
    executor,
    resources,
    mathTools,
    extract = extractPaper,
  }) {
    Object.assign(this, { store, executor, resources, extract });
    if (!mathTools)
      throw Error(
        "Execution tools must be injected by the application composition root",
      );
    this.math = mathTools;
    this.runs = new Map();
    this.sessions = new Map();
    this.active = new Map();
    this.locks = new Map();
    this.actionLocks = new Map();
    this.events = new EventEmitter();
    this.operations = new TeamOperations(this);
    this.projection = new RunProjection(this.operations.journal);
    this.publicSnapshots = new Map();
    this.snapshotTimers = new Map();
    this.toolWork = new Map();
    this.pauseJobs = new Map();
    this.resumeJobs = new Map();
    this.bridge = null;
    this.endpoint = null;
  }
  async init() {
    await this.store.init();
    this.owner = await this.operations.journal.call("health");
    this.store.projectionLoader = (id) => this.projection.read(id);
    // Inspect only our own records. Never replay a pending CLI request at startup.
    for (const name of await readdir(path.join(this.store.root, "runs"))) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const r = await this.store.getRun(name.slice(0, -5));
      if (
        r.engine !== "team-v1" ||
        !["running", "pausing", "resuming"].includes(r.status) ||
        !r.ownerPid
      )
        continue;
      if ((r.protocolVersion || 1) > 7) continue; // Newer protocol archives are read-only to this implementation.
      let alive = false;
      try {
        if (r.ownerPid) {
          process.kill(r.ownerPid, 0);
          alive = true;
        }
      } catch {}
      if (r.protocolVersion >= 7) alive = r.owner?.epoch === this.owner.epoch;
      if (alive) continue;
      if (r.protocolVersion >= 7)
        r.operations = await this.operations.journal.call("reconcile", {
          runId: r.id,
          operations: r.operations || [],
        });
      for (const op of r.operations || [])
        if (!operationSettled(op.status)) {
          op.status = "unknown";
          op.reason = "Original process exited; never replayed";
        }
      r.status = "interrupted";
      r.revision++;
      r.updatedAt = new Date().toISOString();
      for (const t of r.turns || [])
        if (t.status === "running") t.status = "unknown";
      for (const t of r.tasks)
        if (!terminal(t.status)) {
          t.status = "unresolved";
          t.error = "原执行进程已退出；未自动重发结果未知的请求。";
        }
      r.conclusion = {
        headline: "上次评审已中断",
        summary: "保留已收到的结果；未恢复或重发执行中的请求。",
        wholePaperVerified: false,
      };
      this.runs.set(r.id, r);
      await this.seal(r.id);
    }
    this.bridge = http.createServer(async (req, res) => {
      const send = (status, data) => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const session = this.sessions.get(
        req.headers.authorization?.replace(/^Bearer /, ""),
      );
      if (!session)
        return send(403, { error: "Invalid or expired actor session" });
      try {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 4 * 1024 * 1024) throw Error("Tool payload too large");
          chunks.push(c);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        if (req.method !== "POST") return send(405, { error: "POST required" });
        if (req.url === "/tools") return send(200, TEAM_TOOLS);
        if (req.url === "/operations/start")
          return send(202, await this.operations.start(session, body));
        if (req.url === "/operations/get")
          return send(
            200,
            await this.operations.get(
              session.runId,
              /^[a-f0-9-]{36}$/.test(body.operationId || "")
                ? body.operationId
                : resolveReference(
                    this.runs.get(session.runId),
                    body.operationId,
                    "operation",
                  ),
            ),
          );
        if (req.url !== "/call") return send(404, { error: "Unknown route" });
        const work = this.call(
          session.runId,
          session.actorId,
          body.name,
          body.arguments || {},
          session.signal,
        );
        session.pending.add(work);
        try {
          return send(200, await work);
        } finally {
          session.pending.delete(work);
        }
      } catch (e) {
        send(400, {
          ...errorView(e),
          error: e.message,
        });
      }
    });
    await new Promise((resolve) => this.bridge.listen(0, "127.0.0.1", resolve));
    this.bridge.unref();
    this.endpoint = `http://127.0.0.1:${this.bridge.address().port}`;
  }
  async edit(id, fn, { checkpoint = false, skipIfUnchanged = false } = {}) {
    const prior = this.locks.get(id) || Promise.resolve();
    const work = prior
      .catch(() => {})
      .then(async () => {
        const run = this.runs.get(id);
        if (!run) throw Error("Review not active in this process");
        const value = await fn(run);
        if (skipIfUnchanged && value === false) return value;
        if (run.protocolVersion >= 6) registerRunObjects(run);
        run.revision++;
        run.updatedAt = new Date().toISOString();
        if (run.protocolVersion >= 7) {
          await this.projection.save(run);
          const snapshot = this.publicSnapshots.get(id);
          if (
            checkpoint ||
            !snapshot ||
            snapshot.status !== run.status ||
            run.root ||
            Date.now() - snapshot.at >= 1000
          ) {
            clearTimeout(this.snapshotTimers.get(id));
            this.snapshotTimers.delete(id);
            await this.store.saveRun(copy(run));
            this.publicSnapshots.set(id, {
              status: run.status,
              at: Date.now(),
            });
          } else if (!this.snapshotTimers.has(id)) {
            const timer = setTimeout(
              () => {
                this.snapshotTimers.delete(id);
                void this.edit(id, () => {}, { checkpoint: true }).catch(
                  (e) => {
                    this.snapshotError = e.message;
                  },
                );
              },
              Math.max(1, 1000 - (Date.now() - snapshot.at)),
            );
            timer.unref();
            this.snapshotTimers.set(id, timer);
          }
        } else await this.store.saveRun(copy(run));
        this.events.emit(id, { seq: run.revision, type: "team_changed" });
        return value;
      });
    this.locks.set(id, work);
    try {
      return await work;
    } finally {
      if (this.locks.get(id) === work) this.locks.delete(id);
    }
  }
  task(role, title, goal, criteria, parentId = null, dependsOn = []) {
    return {
      id: randomUUID(),
      role,
      title,
      goal,
      criteria,
      parentId,
      dependsOn,
      status: "queued",
      version: 1,
      notes: [],
      artifacts: [],
      waitingFor: [],
      feedback: [],
      createdAt: new Date().toISOString(),
    };
  }
  async start(input) {
    const source = await this.extract(input.pdfBase64);
    const sourceArtifact = await this.store.put("paper_source", source);
    const run = {
      id: randomUUID(),
      ownerPid: process.pid,
      owner: this.owner || (await this.operations.journal.call("health")),
      engine: "team-v1",
      protocolVersion: 7,
      executionIndex: [],
      proofReceiptIndex: [],
      operations: [],
      paperSha256: source.paperSha256,
      title: input.title || "论文评审",
      intent:
        input.reviewIntent ||
        input.intent ||
        "独立评审这篇论文的主要结论及作者证明，尽可能通过 Lean 核验；如实保留未完成内容。",
      sourceArtifact,
      pageCount: source.pageCount,
      status: "running",
      revision: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: {
        provider: "codex-cli",
        model: "gpt-6-sol",
        reasoningEffort: "high",
      },
      tasks: [],
      messages: [],
      targets: [],
      submissions: [],
      objectives: [],
      progressReports: [],
      receipts: [],
      events: [],
      turns: [],
      conclusion: null,
      root: null,
      resourcePolicy: copy(this.resources.policy),
      account: {
        turns: 0,
        startedAt: Date.now(),
        policy: "active-v1",
        pausedMs: 0,
      },
    };
    if (input.quote || input.focusQuote)
      run.intent += `\n用户选择的局部范围：第 ${input.pageIndex + 1} 页，${input.quote || input.focusQuote}`;
    registerReference(run, "artifact", sourceArtifact);
    run.tasks.push(
      this.task(
        "main",
        "阅读论文并组织评审",
        run.intent,
        "持续推进原文主要结论与原证明的核验。报告质量与证明完成分别验收；未完成目标需要继续工作或独立审查的停止依据。",
      ),
    );
    const main = run.tasks[0];
    const scope = newObjective(
      { title: "论文核验范围", description: run.intent, kind: "scope" },
      main.id,
    );
    run.objectives.push(scope);
    main.objectiveIds = [scope.id];
    this.runs.set(run.id, run);
    this.active.set(run.id, {
      source,
      controller: new AbortController(),
      jobs: new Map(),
    });
    await this.edit(run.id, () => {});
    this.pump(run.id);
    return copy(run);
  }
  async load(id) {
    return copy(this.runs.get(id) || (await this.store.getRun(id)));
  }
  async resume(id, options = {}) {
    if (this.resumeJobs.has(id))
      throw Error("Review already active or resuming in this process");
    const job = this.resumeCheckpoint(id, options);
    this.resumeJobs.set(id, job);
    try {
      return await job;
    } finally {
      this.resumeJobs.delete(id);
    }
  }
  async resumeCheckpoint(
    id,
    { expectedRoot, authorization, pauseAuthorization = null } = {},
  ) {
    if (typeof authorization !== "string" || !authorization.trim())
      throw Error("Explicit user continuation authorization is required");
    if (this.active.has(id))
      throw Error("Review already active in this process");
    const run = await this.store.getRun(id);
    if (!pauseAuthorization) {
      try {
        pauseAuthorization = JSON.parse(
          await readFile(
            path.join(this.store.root, "pause-authorization.json"),
            "utf8",
          ),
        );
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    validateCheckpoint(run, await this.store.get(expectedRoot), expectedRoot, {
      pauseAuthorization,
    });
    const previousProtocol = run.protocolVersion;
    const previousStatus = run.status;
    const previousAccount = copy(run.account);
    for (const key of ["concurrency", "maxTurns", "maxRunMs"])
      if (run.resourcePolicy[key] !== this.resources.policy[key])
        throw Error(`Continuation must preserve the shared budget: ${key}`);
    const source = (await this.store.get(run.sourceArtifact)).payload;
    if (sha256(Buffer.from(source.pdfBase64, "base64")) !== run.paperSha256)
      throw Error("Checkpoint source bytes changed");
    let nextAccount = copy(run.account);
    if (run.account.policy === "active-v1" && run.account.pausedAt) {
      nextAccount.pausedMs =
        (run.account.pausedMs || 0) + (Date.now() - run.account.pausedAt);
      delete nextAccount.pausedAt;
    } else if (pauseAuthorization) {
      const at = Date.parse(pauseAuthorization.settledAt);
      if (!Number.isFinite(at) || at < run.account.startedAt || at > Date.now())
        throw Error("Invalid user-pause budget boundary");
      nextAccount = {
        ...run.account,
        policy: "active-v1",
        pausedMs: Date.now() - at,
        migration: {
          from: "legacy-wall-time",
          pausedAt: at,
          spentMs: at - run.account.startedAt,
          priorAccount: previousAccount,
        },
      };
    }
    await this.operations.journal.call("health");
    await this.operations.journal.call("resumeClaim", {
      runId: id,
      root: expectedRoot,
    });
    this.store.projectionLoader = (runId) => this.projection.read(runId);
    const main = run.tasks.find((t) => t.role === "main");
    const segment = {
      id: randomUUID(),
      parentRoot: expectedRoot,
      at: new Date().toISOString(),
      authorization,
      previousMainVersion: main.version,
      inheritedOperationCount: run.operations.length,
      inheritedReceiptCount: run.receipts.length,
      inheritedTurnCount: run.turns.length,
      budgetReset: false,
      unknownRequestsReissued: false,
      previousProtocol,
      executionProtocol: 7,
      previousStatus,
      previousAccount,
      userPauseProvenance: pauseAuthorization
        ? {
            root: pauseAuthorization.root,
            settledAt: pauseAuthorization.settledAt,
            requestDigest: digest(pauseAuthorization),
          }
        : null,
    };
    const receipt = await this.store.put(
      "team:resume",
      {
        runId: id,
        actorId: main.id,
        result: segment,
      },
      [expectedRoot, run.sourceArtifact],
    );
    run.continuations = [...(run.continuations || []), segment];
    run.receipts.push(receipt);
    registerArtifactReferences(run, "resume", receipt, segment);
    main.version++;
    main.status = "queued";
    main.waitingFor = [];
    main.waitingOperations = [];
    main.coordinationPending = false;
    delete main.error;
    delete main.retryAt;
    main.feedback.push({
      category: "user_authorized_continuation",
      artifact: receipt,
      explanation:
        "The user explicitly authorized continuing this logical review from its sealed public checkpoint. Read the current objectives, existing proofs and unknown outcomes. Choose new next actions; do not replay the interrupted CLI request or automatically resubmit old task transitions. Existing accepted goals retain their exact scope. The original shared budget has not been reset.",
    });
    run.account = nextAccount;
    run.protocolVersion = 7;
    run.pause = null;
    run.ownerPid = process.pid;
    run.owner = await this.operations.journal.call("health");
    run.status = "running";
    run.root = null;
    run.conclusion = null;
    this.runs.set(id, run);
    this.active.set(id, {
      source,
      controller: new AbortController(),
      jobs: new Map(),
    });
    try {
      await this.edit(id, () => {});
    } catch (error) {
      this.active.delete(id);
      this.runs.delete(id);
      throw error;
    }
    this.pump(id);
    return copy(run);
  }
  async record(runId, actorId, kind, result, inputs = []) {
    const run = this.runs.get(runId);
    const artifact = await this.store.put(
      `team:${kind}`,
      copy({ runId, actorId, result }),
      [run.sourceArtifact, ...inputs],
    );
    await this.edit(runId, (r) => {
      if (!r.receipts.includes(artifact)) r.receipts.push(artifact);
      if (r.protocolVersion >= 6)
        registerArtifactReferences(r, kind, artifact, result);
      if (
        [
          "lean_draft",
          "lean_exploration",
          "lean_draft_reuse",
          "search",
          "premise_search",
          "modules",
          "python_environment",
          "experiment",
          "tool_failure",
        ].includes(kind)
      ) {
        r.executionIndex ||= [];
        if (!r.executionIndex.some((e) => e.artifactId === artifact))
          r.executionIndex.push({
            artifactId: artifact,
            actorId,
            kind,
            at: new Date().toISOString(),
            codeSha256:
              typeof result.code === "string" ? sha256(result.code) : null,
            inputFingerprint: result.inputFingerprint || null,
            status:
              result.result?.exitCode ??
              result.exitCode ??
              (kind === "tool_failure" ? "failed" : "received"),
            environmentId: result.environmentId || null,
            originalArtifactId: result.originalArtifactId || null,
            nativeCheckExecuted:
              kind === "lean_draft_reuse"
                ? false
                : ["lean_draft", "lean_exploration"].includes(kind)
                  ? true
                  : null,
            read: {
              tool: "read_evidence",
              arguments: { artifactId: artifact },
            },
          });
      }
      const proof = proofReceiptSummary({
        id: artifact,
        kind: `team:${kind}`,
        payload: { runId, actorId, result },
      });
      if (
        proof &&
        r.proofReceiptIndex &&
        !r.proofReceiptIndex.some((p) => p.artifactId === artifact)
      )
        r.proofReceiptIndex.push(proof);
      const a = r.tasks.find((t) => t.id === actorId);
      if (!a.artifacts.includes(artifact)) a.artifacts.push(artifact);
    });
    return artifact;
  }
  async getArtifact(run, id) {
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) {
      const obj = [
        ...run.targets,
        ...run.submissions,
        ...run.tasks,
        ...(run.objectives || []),
      ].find((x) => x.id === id);
      throw Object.assign(
        Error(
          obj
            ? `This is an object ID, not an artifact ID. Use read_object with id ${id}${obj.artifact ? `; its artifactId is ${obj.artifact}` : ""}`
            : "artifactId must be the complete 64-character hash returned by a tool. Shortened IDs cannot identify evidence.",
        ),
        {
          code: "reference_invalid",
          navigation: obj
            ? { tool: "read_object", arguments: { id } }
            : {
                tool: "read_board",
                arguments: { section: "receipts" },
                candidates:
                  typeof id === "string" && /^[a-f0-9]{8,63}$/.test(id)
                    ? run.receipts
                        .filter((h) => h.startsWith(id))
                        .slice(0, 10)
                        .map((h) => ({
                          tool: "read_evidence",
                          arguments: { artifactId: h },
                        }))
                    : [],
                guidance:
                  "Candidates are navigation only. Select an exact received identity; nothing was automatically resolved or executed.",
              },
        },
      );
    }
    if (id !== run.sourceArtifact && !run.receipts.includes(id))
      throw Object.assign(
        Error(
          "Artifact not received by this review. Use read_board receipts or read_object; do not invent or shorten the ID.",
        ),
        { code: "reference_invalid" },
      );
    return this.store.get(id);
  }
  getTarget(run, id) {
    const t = run.targets.find((t) => t.id === id);
    if (!t) throw Error("Unknown target in this review");
    return t;
  }
  async call(id, actorId, name, args, signal, operationId = null) {
    const run = this.runs.get(id);
    const { _execution, ...toolArgs } = args;
    args = toolArgs;
    const schema = validateToolCall(name, args);
    const resolved = resolveArguments(run, schema, args);
    if (operationId && run.protocolVersion < 7)
      await this.edit(id, async (r) => {
        const op = r.operations.find((o) => o.id === operationId);
        const artifact = await this.store.put(
          "team:resolved_operation_input",
          {
            runId: id,
            actorId,
            result: {
              operationId,
              name,
              originalArguments: args,
              resolvedArguments: resolved,
            },
          },
          [op.inputArtifact],
        );
        if (!r.receipts.includes(artifact)) r.receipts.push(artifact);
        registerReference(r, "artifact", artifact);
        op.resolvedInputArtifact = artifact;
      });
    const value = await this.callResolved(
      id,
      actorId,
      name,
      resolved,
      signal,
      operationId,
    );
    return referenceProjection(run, value);
  }
  pendingWork(id, actorId, excludeId = null) {
    const ids = new Set(
      [...(this.toolWork.get(`${id}:${actorId}`) || [])].map(
        (x) => x.operationId,
      ),
    );
    for (const op of this.runs.get(id)?.operations || [])
      if (
        op.actorId === actorId &&
        op.id !== excludeId &&
        !operationSettled(op.status)
      )
        ids.add(op.id);
    ids.delete(excludeId);
    return [...ids].map((operationId) => ({ operationId }));
  }
  async callResolved(id, actorId, name, args, signal, operationId = null) {
    const transitions = new Set([
      "create_task",
      "message_agent",
      "save_note",
      "save_progress",
      "yield_work",
      "submit_task",
      "assess_submission",
      "finish_review",
      "register_objective",
      "revise_objective",
      "record_attempt",
    ]);
    const reads = new Set([
      "read_board",
      "read_object",
      "get_operation",
      "list_operations",
      "discover_tools",
      "read_execution_history",
      "read_resume_context",
      "find_operation",
    ]);
    const key = `${id}:${actorId}`;
    if (["submit_task", "finish_review", "assess_submission"].includes(name)) {
      const pending = this.pendingWork(id, actorId, operationId);
      if (pending.length)
        return {
          pendingOperations: pending.map((x) => x.operationId).filter(Boolean),
          status: "awaiting_operations",
          submitted: false,
          guidance:
            "Results are still being produced. Use get_operation, yield_work(operationIds), or save_progress; no submission or acceptance has occurred.",
        };
    }
    if (!transitions.has(name) && !reads.has(name)) {
      const work = { operationId };
      const set = this.toolWork.get(key) || new Set();
      this.toolWork.set(key, set);
      set.add(work);
      try {
        return await this.performCall(
          id,
          actorId,
          name,
          args,
          signal,
          operationId,
        );
      } finally {
        set.delete(work);
        if (!set.size) this.toolWork.delete(key);
      }
    }
    if (reads.has(name))
      return this.performCall(id, actorId, name, args, signal, operationId);

    if (
      ![
        "create_task",
        "message_agent",
        "save_note",
        "save_progress",
        "yield_work",
        "submit_task",
        "assess_submission",
        "finish_review",
        "register_objective",
        "revise_objective",
        "record_attempt",
      ].includes(name)
    )
      return this.performCall(id, actorId, name, args, signal, operationId);
    // Serialize transitions, not resource-consuming work. Two concurrent
    // submissions cannot both create acceptance agents for the same version.
    const prior = this.actionLocks.get(id) || Promise.resolve();
    const work = prior
      .catch(() => {})
      .then(() =>
        this.performCall(id, actorId, name, args, signal, operationId),
      );
    this.actionLocks.set(id, work);
    try {
      return await work;
    } finally {
      if (this.actionLocks.get(id) === work) this.actionLocks.delete(id);
    }
  }
  async performCall(id, actorId, name, args, signal, operationId = null) {
    signal?.throwIfAborted();
    const run = this.runs.get(id),
      actor = run?.tasks.find((t) => t.id === actorId);
    if (
      !run ||
      !actor ||
      run.status !== "running" ||
      actor.status !== "running"
    )
      throw Error(
        "Actor is not running; do not call tools after yield or submit",
      );
    const schema = TEAM_TOOLS.find((t) => t.name === name)?.inputSchema;
    if (!schema) throw Error("Unknown tool");
    validateToolCall(name, args);
    const record = (k, r, inputs) => this.record(id, actorId, k, r, inputs);
    if (name === "read_resume_context") return resumeContext(run, actor, args);
    if (name === "find_operation") {
      const rows = (run.operations || [])
        .filter(
          (o) =>
            (!args.name || o.name === args.name) &&
            o.actorId === (args.actorId || actorId) &&
            (!args.version || o.version === args.version) &&
            (!args.actionId ||
              o.actionId === args.actionId ||
              o.id === args.actionId) &&
            (!args.status || o.status === args.status),
        )
        .reverse();
      const offset = args.offset || 0,
        limit = Math.min(args.limit || 30, 100);
      return {
        total: rows.length,
        offset,
        nextOffset: offset + limit < rows.length ? offset + limit : null,
        items: rows.slice(offset, offset + limit).map((o) => ({
          id: o.id,
          name: o.name,
          status: o.status,
          version: o.version,
          artifactId: o.artifactId || null,
          read: { tool: "get_operation", arguments: { operationId: o.id } },
        })),
      };
    }
    if (name === "read_execution_history") {
      const all = (run.executionIndex || []).filter(
        (e) =>
          (!args.kind || e.kind === args.kind) &&
          (!args.codeSha256 || e.codeSha256 === args.codeSha256),
      );
      const offset = args.offset || 0,
        limit = Math.min(args.limit || 20, 100);
      return {
        entries: all.slice(offset, offset + limit),
        total: all.length,
        nextOffset: offset + limit < all.length ? offset + limit : null,
        scope: "public_same_run_execution_facts_not_proof_acceptance",
      };
    }
    if (name === "read_board")
      return {
        ...boardView(run, actor, args),
        resources: await this.resources.observe(),
      };
    if (name === "read_object") {
      if (/^[a-f0-9]{64}$/.test(args.id))
        return selectEvidence(await this.getArtifact(run, args.id), args);
      return readBoardObject(run, args);
    }
    if (name === "get_operation")
      return this.operations.get(id, args.operationId);
    if (name === "list_operations")
      return boardView(run, actor, { ...args, section: "operations" });
    if (name === "register_objective" || name === "revise_objective") {
      if (actor.role === "acceptance")
        throw Error(
          "Acceptance assesses objective versions; execution Agents revise them",
        );
      const source = this.active.get(id).source;
      if (args.sourceSpans)
        args = {
          ...args,
          sourceSpans: resolveSourceSpans(
            source,
            await Promise.all(
              (args.sourceSpans || []).map(async (span) => {
                if (!span.selectionId) return span;
                const e = await this.getArtifact(run, span.selectionId);
                if (
                  e.kind !== "team:source_selection" ||
                  e.payload.result.paperSha256 !== run.paperSha256
                )
                  throw Error("selectionId must belong to this paper");
                return e.payload.result;
              }),
            ),
          ),
        };
      if (args.targetId) this.getTarget(run, args.targetId);
      const previous =
        name === "revise_objective"
          ? getObjective(run, args.objectiveId)
          : null;
      if (previous && !args.reason?.trim())
        throw Error(
          "Explain the objective revision; old versions and evidence remain archived",
        );
      const next = previous
        ? {
            ...copy(previous),
            ...Object.fromEntries(
              Object.entries(args).filter(([k]) =>
                [
                  "title",
                  "description",
                  "sourceSpans",
                  "dependencies",
                  "targetId",
                  "required",
                ].includes(k),
              ),
            ),
            version: previous.version + 1,
            status: "open",
            evidenceIds: [],
          }
        : newObjective(args, actorId, args.parentId || null);
      text(next.title);
      text(next.description);
      if (previous?.id === run.objectives[0].id && next.required === false)
        throw Error(
          "The user scope remains required; revise its source-grounded dependencies instead",
        );
      if (next.parentId) getObjective(run, next.parentId);
      if (next.kind !== "scope" && !next.sourceSpans.length)
        throw Error(
          "Record the source context of this mathematical objective; auxiliary lemmas may cite context rather than invent a verbatim statement",
        );
      checkObjectiveGraph(run, next);
      const artifact = await record("objective", {
        ...next,
        reason: args.reason || null,
      });
      await this.edit(id, (r) => {
        if (previous) {
          next.history = [
            ...previous.history,
            { ...copy(previous), history: undefined },
          ];
          r.objectives[r.objectives.findIndex((g) => g.id === next.id)] = next;
          invalidateObjectives(r, [next.id], args.reason);
        } else r.objectives.push(next);
        next.artifact = artifact;
        actor.objectiveIds = [
          ...new Set([...(actor.objectiveIds || []), next.id]),
        ];
      });
      return copy(next);
    }
    if (name === "record_attempt") {
      const goal = getObjective(run, args.objectiveId);
      for (const ref of args.artifactIds) await this.getArtifact(run, ref);
      const prior = goal.attempts.find(
        (x) =>
          x.fingerprint ===
          digest({
            targetId: goal.targetId,
            version: goal.version,
            approach: args.approach,
            artifactIds: args.artifactIds,
          }),
      );
      const attempt = {
        version: goal.version,
        actorId,
        approach: text(args.approach),
        result: text(args.result),
        nextAction: text(args.nextAction),
        artifactIds: args.artifactIds,
        fingerprint: digest({
          targetId: goal.targetId,
          version: goal.version,
          approach: args.approach,
          artifactIds: args.artifactIds,
        }),
      };
      attempt.artifact = await record("attempt", attempt, args.artifactIds);
      await this.edit(id, () => goal.attempts.push(attempt));
      return {
        saved: true,
        artifactId: attempt.artifact,
        repeatedUnchangedAttempt: !!prior,
        guidance: prior
          ? "This repeats unchanged evidence; choose a changed approach or explain an evidence-backed stopping proposal"
          : "Progress retained; next action remains yours to choose",
      };
    }
    if (name === "save_progress") {
      for (const ref of args.artifactIds || [])
        await this.getArtifact(run, ref);
      const artifactId = await record(
        "progress",
        {
          summary: text(args.summary),
          nextAction: args.nextAction || null,
          artifactIds: args.artifactIds || [],
        },
        args.artifactIds || [],
      );
      await this.edit(id, (r) =>
        r.progressReports.push({
          actorId,
          version: actor.version,
          summary: args.summary,
          artifact: artifactId,
          accepted: false,
          at: new Date().toISOString(),
        }),
      );
      return {
        saved: true,
        artifactId,
        status: actor.status,
        acceptanceCreated: false,
      };
    }
    if (name === "save_note") {
      await this.edit(id, () => actor.notes.push(text(args.text)));
      return { saved: true };
    }
    if (name === "message_agent") {
      if (args.to !== "all" && !run.tasks.some((t) => t.id === args.to))
        throw Error("Unknown peer");
      await this.edit(id, (r) => {
        r.messages.push({
          id: randomUUID(),
          from: actorId,
          to: args.to,
          message: text(args.message),
          at: new Date().toISOString(),
        });
        for (const t of r.tasks)
          if (
            t.status === "waiting" &&
            (args.to === "all" || args.to === t.id)
          ) {
            t.status = "queued";
            t.waitingFor = [];
          }
      });
      this.pump(id);
      return { sent: true };
    }
    if (name === "create_task") {
      if (actor.role === "acceptance")
        throw Error(
          "Acceptance returns concrete issues; execution agents create the follow-up work",
        );
      const deps = args.dependsOn || [];
      if (
        !Array.isArray(deps) ||
        deps.some((d) => !run.tasks.some((t) => t.id === d))
      )
        throw Error("Unknown dependency");
      const key = digest({
        goal: text(args.goal),
        criteria: text(args.criteria),
        dependsOn: deps,
      });
      const duplicate = run.tasks.find(
        (t) => t.key === key && !terminal(t.status),
      );
      if (duplicate) return { taskId: duplicate.id, existing: true };
      if (
        run.tasks.some(
          (t) =>
            t.key === key &&
            run.turns.some(
              (turn) => turn.actorId === t.id && turn.status === "unknown",
            ),
        )
      )
        throw Error(
          "This task has an unknown external outcome; preserve it instead of silently reissuing it. Independent tasks may continue.",
        );
      const t = this.task(
        "task",
        text(args.title),
        args.goal,
        args.criteria,
        actorId,
        deps,
      );
      for (const g of args.objectiveIds || []) getObjective(run, g);
      t.objectiveIds = args.objectiveIds || [];
      t.key = key;
      await this.edit(id, (r) => r.tasks.push(t));
      this.pump(id);
      return { taskId: t.id, status: t.status };
    }
    if (name === "yield_work") {
      const taskIds = args.taskIds || [],
        operationIds = args.operationIds || [];
      if (
        (!taskIds.length && !operationIds.length) ||
        taskIds.some(
          (d) => d === actorId || !run.tasks.some((t) => t.id === d),
        ) ||
        operationIds.some((d) => !run.operations?.some((o) => o.id === d))
      )
        throw Error("Wait for existing other tasks or received operations");
      const reaches = (node, wanted, seen = new Set()) => {
        if (node === wanted) return true;
        if (seen.has(node)) return false;
        seen.add(node);
        const t = run.tasks.find((t) => t.id === node);
        return [...(t?.waitingFor || []), ...(t?.dependsOn || [])].some((d) =>
          reaches(d, wanted, seen),
        );
      };
      if (taskIds.some((d) => reaches(d, actorId)))
        throw Error(
          "Circular wait; revise task dependencies or continue independent work",
        );
      await this.edit(id, () => {
        actor.status = "waiting";
        actor.waitingFor = taskIds;
        actor.waitingOperations = operationIds;
      });
      return {
        yielded: true,
        instruction: "End turn now; resource slot will be released.",
      };
    }
    if (name === "submit_task" || name === "finish_review") {
      const pending = this.pendingWork(id, actorId, operationId);
      if (pending.length)
        return {
          submitted: false,
          status: "awaiting_operations",
          pendingOperations: pending.map((x) => x.operationId).filter(Boolean),
          guidance:
            "Retrieve existing operations or save_progress; no submission was made.",
        };
      if (
        actor.role === "acceptance" ||
        (name === "finish_review" && actor.role !== "main")
      )
        throw Error("Role cannot submit this deliverable");
      if (
        name === "finish_review" &&
        (run.tasks.some((t) => t.id !== actorId && !terminal(t.status)) ||
          [...this.toolWork.keys()].some((key) => key.startsWith(id + ":")))
      )
        throw Error("Other tasks still active; wait for their outcomes");
      const ids = args.artifactIds || [];
      for (const a of ids) await this.getArtifact(run, a);
      for (const t of args.targetIds || []) this.getTarget(run, t);
      const objectiveIds =
        name === "finish_review"
          ? requiredObjectives(run).map((g) => g.id)
          : args.objectiveIds || actor.objectiveIds || [];
      for (const g of objectiveIds) getObjective(run, g);
      if (name === "finish_review")
        await validateStopProposal(run, args.stopProposal, (h) =>
          this.getArtifact(run, h),
        );
      const submission = {
        id: randomUUID(),
        taskId: actorId,
        version: actor.version,
        summary: text(args.summary),
        resultKind: args.resultKind || "report",
        artifactIds: ids,
        targetIds: args.targetIds || [],
        limitations: args.limitations || [],
        final: name === "finish_review",
        afterAcceptance: args.afterAcceptance || "complete",
        objectiveIds,
        objectiveVersions: Object.fromEntries(
          objectiveIds.map((g) => [g, getObjective(run, g).version]),
        ),
        stopProposal: name === "finish_review" ? copy(args.stopProposal) : null,
        status: "pending",
      };
      submission.artifact = await record("submission", submission, ids);
      const check = this.task(
        "acceptance",
        `验收：${actor.title}`,
        actor.goal,
        actor.criteria,
        actorId,
      );
      check.submissionId = submission.id;
      await this.edit(id, (r) => {
        if (this.pendingWork(id, actorId, operationId).length)
          throw Error(
            "Tool work began during submission; retrieve its outcome before submitting. No task transition committed.",
          );
        r.submissions.push(submission);
        r.tasks.push(check);
        actor.submissionId = submission.id;
        actor.status = "submitted";
      });
      this.pump(id);
      return { submissionId: submission.id, acceptanceTaskId: check.id };
    }
    if (name === "assess_submission") {
      if (actor.role !== "acceptance")
        throw Error("Only an independent acceptance actor may assess");
      if (!["pass", "rework", "unresolved"].includes(args.verdict))
        throw Error("Invalid verdict");
      const s = run.submissions.find((s) => s.id === actor.submissionId),
        owner = run.tasks.find((t) => t.id === s.taskId);
      if (s.status !== "pending" || owner.version !== s.version)
        throw Error("Stale submission");
      const replayIds = args.replayIds || [];
      await validateAcceptance({
        run,
        actor,
        submission: s,
        decision: args,
        getArtifact: (h) => this.getArtifact(run, h),
        getTarget: (h) => this.getTarget(run, h),
      });
      const updates = await validateObjectiveDecisions({
        run,
        submission: s,
        decision: args,
        actor,
        getArtifact: (h) => this.getArtifact(run, h),
        getTarget: (h) => this.getTarget(run, h),
      });
      if (
        args.verdict !== "pass" &&
        updates.some((u) => u.outcome !== "continue")
      )
        throw Error("Unaccepted submissions cannot complete objectives");
      const candidate = copy(run);
      for (const u of updates) {
        const g = getObjective(candidate, u.objectiveId);
        g.status = u.outcome === "continue" ? "open" : u.outcome;
        g.scopeDisposition = u.scopeDisposition || null;
      }
      if (s.final && args.stopVerdict === "stop") {
        if (args.verdict !== "pass" || !args.stopExplanation?.trim())
          throw Error("Stopping requires independent acceptance and a reason");
        await validateStopProposal(candidate, s.stopProposal, (h) =>
          this.getArtifact(run, h),
        );
        if (
          s.stopProposal.reason === "goals_resolved" &&
          unresolvedObjectives(candidate).length
        )
          throw Error(
            "Unresolved objectives remain; a report cannot close them",
          );
        const reviewed = new Set(args.reviewedObjectiveIds || []);
        if (requiredObjectives(run).some((g) => !reviewed.has(g.id)))
          throw Error(
            "The stopping assessment must account for every required objective",
          );
      }
      const receipt = await record(
        "acceptance",
        {
          submissionId: s.id,
          version: s.version,
          ...args,
          authority: "independent_agent_not_kernel_semantic_equivalence",
        },
        [s.artifact, ...replayIds],
      );
      await this.edit(id, (r) => {
        if (this.pendingWork(id, actorId, operationId).length)
          throw Error(
            "Tool work began during acceptance; retrieve its outcome before assessing. No acceptance committed.",
          );
        for (const u of updates)
          if (getObjective(r, u.objectiveId).version !== u.version)
            throw Error(
              "Objective changed during assessment; review the current version",
            );
        for (const u of updates)
          if (
            ["proved", "refuted"].includes(u.outcome) &&
            this.getTarget(r, getObjective(r, u.objectiveId).targetId)
              .supersededBy
          )
            throw Error("Target changed during assessment");
        s.status = args.verdict;
        s.acceptanceArtifact = receipt;
        s.replayIds = replayIds;
        s.objectiveDecisions = updates;
        s.stopVerdict = args.stopVerdict || "continue";
        for (const u of updates) {
          const g = getObjective(r, u.objectiveId);
          g.status = u.outcome === "continue" ? "open" : u.outcome;
          g.scopeDisposition = u.scopeDisposition || null;
          g.evidenceIds = u.evidenceIds || [];
          g.assessment = {
            explanation: u.explanation,
            sourceAssessment: u.sourceAssessment || null,
            artifact: receipt,
          };
        }
        actor.status = "completed";
        owner.feedback.push({
          version: s.version,
          verdict: args.verdict,
          explanation: args.explanation,
          issues: args.issues,
          artifact: receipt,
        });
        const continueOwner =
          args.verdict === "rework" ||
          (s.final && args.stopVerdict !== "stop") ||
          (args.verdict === "pass" && s.afterAcceptance === "continue");
        if (continueOwner) {
          owner.version++;
          owner.status = "queued";
        } else {
          owner.status = args.verdict === "pass" ? "completed" : "unresolved";
          const coordinator =
            r.tasks.find(
              (t) => t.id === owner.parentId && t.role !== "acceptance",
            ) || r.tasks.find((t) => t.role === "main");
          if (coordinator && coordinator.id !== owner.id) {
            r.messages.push({
              id: randomUUID(),
              from: actor.id,
              to: coordinator.id,
              message: `Task ${owner.id} deliverable ${s.id} assessed ${args.verdict}. Open objectives remain visible; choose whether to decompose, reassign, change strategy, or continue. No automatic repeat was scheduled.`,
              at: new Date().toISOString(),
            });
            if (terminal(coordinator.status)) {
              coordinator.version++;
              coordinator.status = "queued";
              coordinator.waitingFor = [];
              coordinator.waitingOperations = [];
            }
          }
        }
        if (args.verdict === "pass")
          r.progressReports.push({
            submissionId: s.id,
            summary: s.summary,
            limitations: s.limitations,
            acceptanceArtifact: receipt,
            at: new Date().toISOString(),
          });
        if (s.final && args.verdict === "pass" && args.stopVerdict === "stop") {
          owner.status = "completed";
          r.status =
            s.stopProposal.reason === "goals_resolved"
              ? "completed"
              : "incomplete";
          r.stopDecision = {
            ...s.stopProposal,
            independentExplanation: args.stopExplanation,
            acceptanceArtifact: receipt,
          };
          r.conclusion = {
            headline: "本轮评审已汇总",
            summary: s.summary,
            limitations: s.limitations,
            wholePaperVerified: false,
            formalObjectivesResolved: unresolvedObjectives(r).length === 0,
            stopReason: s.stopProposal.reason,
            acceptanceArtifact: receipt,
          };
        }
      });
      this.pump(id);
      return { recorded: true, verdict: args.verdict, artifactId: receipt };
    }
    const originVersion = actor.version;
    const expectedObjectiveVersion = args.objectiveId
      ? getObjective(run, args.objectiveId).version
      : null;
    try {
      return await this.math.run(name, args, {
        run,
        actor: { ...actor, version: originVersion },
        source: this.active.get(id).source,
        signal,
        record,
        getArtifact: (h) => this.getArtifact(run, h),
        getTarget: (h) => this.getTarget(run, h),
        addTarget: (t) =>
          this.edit(id, (r) => {
            t.taskVersion = originVersion;
            const goal = t.objectiveId ? getObjective(r, t.objectiveId) : null;
            const previous = t.replaces ? this.getTarget(r, t.replaces) : null;
            const current =
              r.status === "running" &&
              actor.version === originVersion &&
              (!goal || goal.version === expectedObjectiveVersion) &&
              !previous?.supersededBy;
            t.bindingStatus = current ? "current" : "unbound_version_changed";
            // Preserve received work even if its conversation/version ended.
            // Late results never overwrite a newer goal, target or acceptance.
            r.targets.push(t);
            if (!current) return;
            if (t.replaces) {
              const previous = this.getTarget(r, t.replaces);
              previous.supersededBy = t.id;
              for (const s of r.submissions)
                if (s.targetIds.includes(t.replaces)) s.superseded = true;
              invalidateObjectives(
                r,
                (r.objectives || [])
                  .filter((g) => g.targetId === t.replaces)
                  .map((g) => g.id),
                "Formal target superseded; bind and review the new target version",
              );
            }
            if (t.objectiveId) {
              const goal = getObjective(r, t.objectiveId);
              goal.history.push({ ...copy(goal), history: undefined });
              goal.version++;
              goal.targetId = t.id;
              invalidateObjectives(
                r,
                [goal.id],
                "New formal target bound; independent assessment required",
              );
            }
          }),
      });
    } catch (e) {
      await record("tool_failure", { name, args, error: e.message });
      throw e;
    }
  }
  notifyCoordinator(run, actor, artifact, message) {
    const main = run.tasks.find((t) => t.role === "main");
    if (!main) return;
    run.messages.push({
      id: randomUUID(),
      from: actor.id,
      to: main.id,
      message,
      artifact,
      at: new Date().toISOString(),
    });
    main.coordinationPending = true;
    main.feedback.push({
      category: "coordination_needed",
      explanation: message,
      artifact,
    });
  }
  pump(id) {
    const run = this.runs.get(id),
      active = this.active.get(id);
    if (!active || run.status !== "running") return;
    const main = run.tasks.find((t) => t.role === "main");
    if (
      main?.coordinationPending &&
      !active.jobs.has(main.id) &&
      ["completed", "unresolved", "waiting"].includes(main.status) &&
      !(run.operations || []).some(
        (o) => o.actorId === main.id && !operationSettled(o.status),
      )
    ) {
      main.version++;
      main.status = "queued";
      main.waitingFor = [];
      main.waitingOperations = [];
      main.coordinationPending = false;
    }
    if (
      main &&
      terminal(main.status) &&
      !active.jobs.has(main.id) &&
      !run.tasks.some((t) => t.id !== main.id && !terminal(t.status))
    ) {
      main.version++;
      main.status = "queued";
      main.feedback.push({
        explanation:
          "The task queue is empty, but this is not a stopping decision. Reconcile remaining objectives, create further work or submit an evidence-backed stop proposal.",
      });
    }
    for (const t of run.tasks) {
      if (
        t.status === "waiting" &&
        (t.waitingOperations || []).every((op) =>
          operationSettled(run.operations?.find((o) => o.id === op)?.status),
        ) &&
        t.waitingFor.every((id) =>
          terminal(run.tasks.find((x) => x.id === id)?.status),
        )
      ) {
        t.status = "queued";
        t.waitingFor = [];
        t.waitingOperations = [];
      }
      if (
        t.status !== "queued" ||
        active.jobs.has(t.id) ||
        !t.dependsOn.every((id) =>
          terminal(run.tasks.find((x) => x.id === id)?.status),
        )
      )
        continue;
      // Admission is delegated. Runtime never chooses capacity or phase quotas.
      const job = this.execute(id, t.id).finally(async () => {
        active.jobs.delete(t.id);
        this.pump(id);
        if (run.status !== "running" && !active.jobs.size) await this.seal(id);
      });
      active.jobs.set(t.id, job);
    }
  }
  async execute(id, actorId) {
    const run = this.runs.get(id),
      active = this.active.get(id),
      actor = run.tasks.find((t) => t.id === actorId);
    const token = randomBytes(32).toString("hex");
    let session;
    try {
      await this.resources.execute(
        run.account,
        async (executionSignal) => {
          if (run.status !== "running") return;
          await this.edit(id, () => {
            actor.status = "running";
            actor.coordinationPending = false;
            delete actor.retryAt;
            actor.startedAt = new Date().toISOString();
          });
          const turn = {
            id: randomUUID(),
            actorId,
            version: actor.version,
            startedAt: new Date().toISOString(),
            status: "running",
          };
          await this.edit(id, (r) => r.turns.push(turn));
          session = {
            runId: id,
            actorId,
            signal: executionSignal,
            pending: new Set(),
          };
          this.sessions.set(token, session);
          const result = await this.executor.run({
            prompt: teamPrompt(run, actor),
            endpoint: this.endpoint,
            token,
            signal: executionSignal,
            onEvent: async (e) => {
              if (e.type === "message")
                await this.edit(id, () => {
                  actor.publicMessage = e.text;
                });
            },
          });
          await Promise.allSettled([...session.pending]);
          const receipt = await this.record(id, actorId, "cli_turn", {
            ...turn,
            status: "received",
            model: result.model,
            reasoningEffort: result.reasoningEffort,
            usage: result.usage || null,
            publicResult: result.text || "",
          });
          await this.edit(id, (r) => {
            turn.status = "received";
            turn.artifact = receipt;
            turn.endedAt = new Date().toISOString();
            if (actor.status === "running" && r.status === "running") {
              actor.status = "queued";
              actor.feedback.push({
                explanation:
                  "Your known completed CLI turn ended without an explicit work transition. Public response retained; read the board and continue, submit progress, or make an evidence-backed stopping proposal. No unknown request is replayed.",
              });
            }
          });
          if (run.status === "interrupted") active.controller.abort();
        },
        { signal: active.controller.signal, notBefore: actor.retryAt || 0 },
      );
    } catch (e) {
      if (session) await Promise.allSettled([...session.pending]);
      const failedTurn = run.turns.findLast(
        (t) => t.actorId === actorId && t.status === "running",
      );
      const restartCapacity =
        e.code === "codex_capacity" &&
        run.status === "running" &&
        !active.controller.signal.aborted;
      const failureReceipt = await this.record(id, actorId, "cli_turn", {
        id: failedTurn?.id || null,
        status: failedTurn ? "unknown" : "not_sent",
        startedAt: failedTurn?.startedAt || null,
        endedAt: new Date().toISOString(),
        error: e.message,
        receivedFinalResult: null,
        restartAuthorization: restartCapacity
          ? "user_explicit_capacity_restart_20261029"
          : null,
      });
      if (restartCapacity) {
        await this.edit(id, () => {
          if (failedTurn) {
            failedTurn.status = "unknown";
            failedTurn.error = e.message;
            failedTurn.artifact = failureReceipt;
            failedTurn.endedAt = new Date().toISOString();
            failedTurn.recovery = "authorized_capacity_restart";
          }
          // A committed submit/yield/accept transition must not be replayed.
          // Only an unfinished actor gets a fresh CLI session and current board.
          if (actor.status === "running") {
            actor.capacityRestarts = (actor.capacityRestarts || 0) + 1;
            actor.retryAt =
              Date.now() +
              this.resources.capacityRetryDelay(actor.capacityRestarts);
            actor.status = "queued";
            actor.publicMessage =
              "模型当前容量已满，正在重新启动会话；本轮已收到的证据保留。";
            actor.feedback.push({
              category: "capacity_restart",
              explanation:
                "The user authorized a fresh CLI session after the explicit model-capacity rejection. Read the current board and your received artifacts before continuing. Do not recreate submitted work or treat the missing final response as received.",
              artifact: failureReceipt,
            });
          }
        });
        return;
      }
      await this.edit(id, (r) => {
        if (!terminal(actor.status) && actor.status !== "submitted") {
          actor.status = active.controller.signal.aborted
            ? "cancelled"
            : "failed";
          actor.error = e.message;
        }
        if (actor.role === "acceptance" && r.status === "running") {
          const s = r.submissions.find((s) => s.id === actor.submissionId);
          if (s?.status === "pending") {
            s.status = "unresolved";
            const owner = r.tasks.find((t) => t.id === s.taskId);
            owner.status = "unresolved";
            owner.feedback.push({
              explanation: "验收执行异常，未形成通过结论。",
              error: e.message,
            });
            this.notifyCoordinator(
              r,
              actor,
              failureReceipt,
              `Acceptance ${actor.id} for submission ${s.id} ended without a received decision. The submission remains unresolved, not rejected or passed. Inspect saved evidence and choose new independent work or a new reviewable submission; do not replay the unknown request. Error: ${e.message}`,
            );
          }
        }
        if (actor.role === "task" && r.status === "running")
          this.notifyCoordinator(
            r,
            actor,
            failureReceipt,
            `Task ${actor.id} ended with an unresolved execution outcome. Received artifacts remain available. Choose independent next work; do not replay the unknown request. Error: ${e.message}`,
          );
        const turn = r.turns.findLast(
          (t) => t.actorId === actorId && t.status === "running",
        );
        if (turn) {
          turn.status = "unknown";
          turn.error = e.message;
          turn.artifact = failureReceipt;
          turn.endedAt = new Date().toISOString();
        }
        if (
          r.status === "running" &&
          (e.code === "team_budget_exhausted" || actor.role === "main")
        ) {
          r.status = "interrupted";
          r.conclusion = {
            headline: "评审未完成",
            summary: e.message,
            wholePaperVerified: false,
          };
          active.controller.abort();
        }
      });
    } finally {
      this.sessions.delete(token);
    }
  }
  async seal(id) {
    const run = this.runs.get(id);
    if (run.status === "pausing") return;
    if ((run.operations || []).some((op) => this.operations.jobs.has(op.id)))
      return;
    if (run.status !== "running" && !this.active.get(id)?.jobs.size)
      for (const t of run.tasks)
        if (!terminal(t.status))
          t.status = run.status === "cancelled" ? "cancelled" : "unresolved";
    const journalRoot =
      run.protocolVersion >= 7 ? await this.operations.sealJournal(id) : null;
    const summary = await this.store.put(
      "team:report",
      copy({
        runId: id,
        status: run.status,
        ...(run.protocolVersion >= 7
          ? {
              protocolVersion: run.protocolVersion,
              account: run.account,
              pause: run.pause || null,
              journalRoot,
              journalThrough: run.journalThrough || 0,
            }
          : {}),
        continuations: run.continuations || [],
        model: run.model,
        conclusion: run.conclusion,
        tasks: run.tasks,
        targets: run.targets,
        objectives: run.objectives,
        progressReports: run.progressReports,
        operations: run.operations || [],
        stopDecision: run.stopDecision || null,
        submissions: run.submissions,
        turns: run.turns,
        resourcePolicy: run.resourcePolicy,
      }),
      [
        run.sourceArtifact,
        ...run.receipts,
        ...(journalRoot ? [journalRoot] : []),
      ],
    );
    await this.edit(id, (r) => {
      r.root = summary;
    });
  }
  async pause(id, { reason = "User requested pause" } = {}) {
    if (this.pauseJobs.has(id)) return this.pauseJobs.get(id);
    const current = this.runs.get(id);
    if (current?.status === "paused") return this.load(id);
    if (current?.status !== "running")
      throw Error("Only a running review can be paused");
    const active = this.active.get(id);
    if (!active) throw Error("Review has no live owner in this process");
    text(reason);
    // Close admission immediately, before disk writes or draining. Existing
    // admitted work still has to settle before this becomes a paused checkpoint.
    current.status = "pausing";
    current.pause = {
      reason,
      requestedAt: new Date().toISOString(),
      quiescedAt: null,
    };
    active.controller.abort(
      Error("User paused this review; unknown outcomes are preserved"),
    );
    const work = (async () => {
      await this.edit(id, () => {});
      await Promise.allSettled([...active.jobs.values()]);
      await Promise.allSettled(
        (this.runs.get(id).operations || [])
          .map((o) => this.operations.jobs.get(o.id))
          .filter(Boolean),
      );
      await this.math.pauseRun?.(id);
      await this.edit(id, (r) => {
        const now = Date.now();
        r.status = "paused";
        r.pause.quiescedAt = new Date(now).toISOString();
        r.account.pausedAt = now;
        for (const t of r.tasks)
          if (!terminal(t.status)) t.status = "unresolved";
        r.conclusion = {
          headline: "评审已暂停",
          summary: "执行已排空，已收到的证据与未知结果保留；恢复须明确发起。",
          wholePaperVerified: false,
        };
      });
      await this.seal(id);
      this.active.delete(id);
      return this.load(id);
    })();
    this.pauseJobs.set(id, work);
    try {
      return await work;
    } finally {
      this.pauseJobs.delete(id);
    }
  }
  async cancel(id) {
    const active = this.active.get(id);
    if (!active) throw Error("This run is not active");
    await this.edit(id, (r) => {
      r.status = "cancelled";
    });
    active.controller.abort();
    await Promise.allSettled([...active.jobs.values()]);
    await Promise.allSettled(
      (this.runs.get(id).operations || [])
        .map((op) => this.operations.jobs.get(op.id))
        .filter(Boolean),
    );
    await this.edit(id, (r) => {
      for (const t of r.tasks) if (!terminal(t.status)) t.status = "cancelled";
      r.conclusion = {
        headline: "评审已停止",
        summary: "保留已收到的产物与未完成任务。",
        wholePaperVerified: false,
      };
    });
    await this.math.pauseRun?.(id);
    await this.seal(id);
    return this.load(id);
  }
  async replay(id, { onResult } = {}) {
    const run = await this.load(id),
      results = [],
      seen = new Set();
    const replayReceipt = async (hash) => {
      if (seen.has(hash)) return;
      seen.add(hash);
      const e = await this.getArtifact(run, hash);
      if (e.payload.runId !== run.id)
        throw Error("Replay requires this run's native Lean receipt");
      if (e.kind === "team:lean_reuse") {
        const reused = {
          previous: hash,
          nativeCheckExecuted: false,
          scope: "reuse_receipt",
          originalProofReceipt: e.payload.result.originalProofReceipt,
        };
        results.push(reused);
        await onResult?.(reused);
        const original = await this.getArtifact(
          run,
          reused.originalProofReceipt,
        );
        if (original.kind !== "team:lean")
          throw Error("Reuse must reference an original native Lean receipt");
        await replayReceipt(reused.originalProofReceipt);
        return;
      }
      if (e.kind !== "team:lean")
        throw Error("Replay requires this run's native Lean receipt");
      const p = e.payload.result;
      const result = await this.math.checker(p.contract, p.proof, {
        mode: p.mode,
        dependencyAudit: true,
      });
      const artifact = await this.store.put(
        "team:replay",
        { runId: id, previous: hash, result },
        [hash],
      );
      results.push({
        previous: hash,
        artifact,
        status: result.status,
        targetHash: result.targetHash,
        nativeCheckExecuted: true,
      });
      await onResult?.(results.at(-1));
    };
    for (const s of run.submissions.filter((s) => s.status === "pass"))
      for (const hash of s.replayIds || []) await replayReceipt(hash);
    return { runId: id, scope: "exact_formal_targets_only", results };
  }
  async close() {
    await Promise.all([...this.pauseJobs.values()]);
    for (const timer of this.snapshotTimers.values()) clearTimeout(timer);
    this.snapshotTimers.clear();
    for (const [id, a] of this.active)
      if (this.runs.get(id).status === "running") await this.cancel(id);
    await Promise.all([...this.locks.values()].map((p) => p.catch(() => {})));
    if (this.bridge) await new Promise((resolve) => this.bridge.close(resolve));
    await this.math.close?.();
    this.store.projectionLoader = null;
    await this.operations.close();
  }
}
