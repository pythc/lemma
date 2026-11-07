import { REVIEW_RUNTIME, CONTEXT_RUNTIME } from "./runtime-limits.mjs";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  Annotation,
  StateGraph,
  START,
  END,
  Send,
  Command,
  interrupt,
} from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { extractInWorker } from "./pipeline.mjs";
import { callModel } from "./model.mjs";
import { isHash, sha256 } from "./evidence.mjs";
import { libraryProfile } from "../shared/library-profiles.mjs";
import { ADAPTIVE_ENGINE, ACTIONS } from "../shared/adaptive.mjs";
import {
  ADAPTIVE_LIMITS,
  readingChunks,
  validateReading,
  validateDecision,
  validateInspection,
  READ_PROMPT,
  PLAN_PROMPT,
  INSPECT_PROMPTS,
  INSPECT_FORMAT,
} from "./adaptive-schema.mjs";

const frontier = (tasks) =>
  tasks.filter((t) => !tasks.some((other) => other.parents?.includes(t.id)));
const now = () => new Date().toISOString();
const finished = (r) =>
  !["running", "preparing", "awaiting_confirmation"].includes(r.status);
const State = Annotation.Root({
  runId: Annotation(),
  round: Annotation(),
  route: Annotation(),
  batch: Annotation(),
  taskId: Annotation(),
});

/** Durable orchestration. The graph decides when to run a capability; evidence
 * and task instances are the public audit trail, not the graph's static topology. */
export class AdaptiveReview {
  constructor({
    store,
    pipeline,
    getConfig,
    model = callModel,
    extract = extractInWorker,
    limits = {},
    testFixture = false,
  }) {
    Object.assign(this, { store, pipeline, getConfig, model, extract });
    this.testFixture = testFixture;
    this.limits = { ...ADAPTIVE_LIMITS, ...limits };
    this.active = new Map();
    this.runs = new Map();
    this.saves = new Map();
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
    this.serial = Promise.resolve();
    this.starting = false;
  }
  get busy() {
    return this.active.size > 0 || this.starting;
  }
  async init() {
    await this.store.init();
    this.saver = SqliteSaver.fromConnString(
      path.join(this.store.root, "adaptive-checkpoints.sqlite"),
    );
    this.graph = new StateGraph(State)
      .addNode("read", (s) => this.read(s))
      .addNode("decide", (s) => this.decide(s))
      .addNode("act", (s) => this.act(s))
      .addNode("wait", (s) => this.wait(s))
      .addNode("conclude", (s) => this.conclude(s))
      .addEdge(START, "read")
      .addEdge("read", "decide")
      .addConditionalEdges("decide", (s) =>
        s.route === "act"
          ? s.batch.map((taskId) => new Send("act", { ...s, taskId }))
          : s.route,
      )
      .addEdge("act", "decide")
      .addEdge("wait", "decide")
      .addEdge("conclude", END)
      .compile({ checkpointer: this.saver });
    for (const name of await readdir(path.join(this.store.root, "runs"))) {
      if (!name.endsWith(".json")) continue;
      const r = await this.store.getRun(name.slice(0, -5));
      if (r.engine !== ADAPTIVE_ENGINE) continue;
      this.runs.set(r.id, r);
      if (["preparing", "running", "pausing"].includes(r.status)) {
        r.status = "interrupted";
        r.error =
          "服务停止，中断的外部调用结果尚不确定。点击重试会重新请求该步骤，已完成步骤会复用。";
        r.tasks
          .filter((t) => t.status === "running")
          .forEach((t) => {
            t.status = "interrupted";
            t.endedAt = now();
          });
        await this.save(r, "interrupted");
      }
      if (r.status === "awaiting_confirmation") {
        for (const t of r.tasks.filter((t) => t.childRunId && !t.childFinal)) {
          const child = await this.store.getRun(t.childRunId);
          if (child.status !== "interrupted") continue;
          r.status = "interrupted";
          r.error =
            "子任务因服务停止而中断，外部调用结果尚不确定。请查看该步骤，再决定是否继续评审。";
          t.childStatus = child.status;
          await this.save(r, "child_interrupted", t.id);
          break;
        }
      }
    }
    this.watcher = setInterval(() => {
      void this.continueChildren();
    }, 1000);
    this.watcher.unref();
  }
  async close() {
    clearInterval(this.watcher);
    for (const c of this.active.values()) c.abort();
    await Promise.allSettled([...(this.jobs || [])]);
    if (this.saver?.db.open) this.saver.db.close();
  }
  async load(id) {
    if (!this.runs.has(id)) this.runs.set(id, await this.store.getRun(id));
    return this.runs.get(id);
  }
  async save(run, type, taskId = null) {
    // Serialize snapshots as parallel Send branches finish. A newer state can
    // never be replaced by a late write from a prior branch.
    const previous = this.saves.get(run.id) || Promise.resolve();
    const write = previous
      .catch(() => {})
      .then(async () => {
        run.revision = (run.revision || 0) + 1;
        run.updatedAt = now();
        const event = {
          seq: run.revision,
          type,
          taskId,
          status: run.status,
          at: run.updatedAt,
        };
        run.events.push(event);
        await this.store.saveRun(JSON.parse(JSON.stringify(run)));
        this.events.emit(run.id, event);
      });
    this.saves.set(run.id, write);
    await write;
  }
  async start(input) {
    if (this.busy || this.pipeline.active.size || this.pipeline.reserved)
      throw new Error("本机已有评审在执行，请等待或暂停后再开始。");
    this.starting = true;
    try {
      if (
        !input ||
        !isHash(input.paperSha256) ||
        typeof input.pdfBase64 !== "string" ||
        input.pdfBase64.length > 36 * 1024 * 1024 ||
        sha256(Buffer.from(input.pdfBase64, "base64")) !== input.paperSha256
      )
        throw new Error("论文文件与摘要不一致。");
      if (!(await this.getConfig()))
        throw new Error("请先配置模型接口再开始自主评审。");
      if (
        input.reviewIntent !== undefined &&
        (typeof input.reviewIntent !== "string" ||
          !input.reviewIntent.trim() ||
          input.reviewIntent.length > 3000)
      )
        throw Error("核验重点须为 1 至 3000 字符的文字说明。");
      const profile =
        this.orchestrationVersion === 2
          ? null
          : libraryProfile(input.libraryProfile);
      const uploadArtifact = await this.store.put("adaptive_upload", {
        pdfBase64: input.pdfBase64,
        paperSha256: input.paperSha256,
      });
      const r = {
        id: randomUUID(),
        engine: ADAPTIVE_ENGINE,
        mode: "model",
        reviewIntent: input.reviewIntent || null,
        ...(this.orchestrationVersion === 2
          ? { semanticPolicy: this.autonomousSemantics ? "agent" : "manual" }
          : {}),
        testFixture: this.testFixture,
        paperSha256: input.paperSha256,
        pageIndex: 0,
        libraryProfile: profile?.id || null,
        ...(this.orchestrationVersion === 2
          ? {
              orchestrationVersion: 2,
              profilePreference: input.libraryProfile || null,
            }
          : {}),
        createdAt: now(),
        status: "preparing",
        tasks: [],
        events: [],
        revision: 0,
        claims: [],
        findings: [],
        limits: this.limits,
        uploadArtifact,
        sourceArtifact: null,
        conclusion: null,
        root: null,
        waitReason: null,
        pauseRequested: false,
        error: null,
      };
      this.runs.set(r.id, r);
      await this.save(r, "created");
      this.launch(r, { runId: r.id, round: 0 });
      return JSON.parse(JSON.stringify(r));
    } finally {
      this.starting = false;
    }
  }
  launch(r, input) {
    const controller = new AbortController();
    this.active.set(r.id, controller);
    this.jobs ||= new Set();
    const job = this.graph
      .invoke(input, {
        configurable: { thread_id: r.id },
        recursionLimit: REVIEW_RUNTIME.recursionLimit,
      })
      .catch(async (e) => {
        r.status = controller.signal.aborted ? "cancelled" : "blocked";
        r.error = e.message || "执行失败，尚未形成数学结论。";
        await this.save(r, r.status);
      })
      .finally(() => {
        this.active.delete(r.id);
        this.jobs.delete(job);
      });
    this.jobs.add(job);
  }
  async task(r, spec, action) {
    let t = [...r.tasks].reverse().find((t) => t.key === spec.key);
    if (t?.status === "succeeded")
      return { task: t, value: (await this.store.get(t.output)).payload.value };
    if (!t || ["blocked", "interrupted", "cancelled"].includes(t.status)) {
      const prior = t;
      t = {
        ...spec,
        id: randomUUID(),
        status: "queued",
        output: null,
        attempt: (prior?.attempt || 0) + 1,
        parents: [
          ...new Set([...(spec.parents || []), ...(prior ? [prior.id] : [])]),
        ],
        inputs: [
          ...new Set([
            ...(spec.inputs || []),
            ...(prior?.output ? [prior.output] : []),
          ]),
        ],
        ...(prior?.childRunId ? { childRunId: prior.childRunId } : {}),
        createdAt: now(),
      };
      r.tasks.push(t);
      await this.save(r, "scheduled", t.id);
    }
    const work = async () => {
      const signal = this.active.get(r.id)?.signal;
      if (signal?.aborted) throw new Error("评审已停止。");
      t.status = "running";
      t.startedAt = now();
      await this.save(r, "started", t.id);
      try {
        const result = await action(t, signal);
        t.output = await this.store.put(`adaptive:${t.kind}`, result, t.inputs);
        t.summary =
          result.value?.summary ||
          result.value?.reason ||
          result.value?.headline ||
          "产物已保存。";
        t.anchors = result.value?.anchors || t.anchors || [];
        if (t.kind === "decide")
          t.title =
            result.value.mode === "finish"
              ? "决定结束本轮检查"
              : `安排 ${result.value.actions.length} 项后续检查`;
        t.status = "succeeded";
        return { task: t, value: result.value };
      } catch (e) {
        t.status = signal?.aborted ? "cancelled" : "blocked";
        t.error = e.message || "执行器未返回错误信息。";
        t.output = await this.store.put(
          `adaptive:${t.kind}:error`,
          {
            error: t.error,
            ...(e.modelRecord ? { model: e.modelRecord } : {}),
          },
          t.inputs,
        );
        throw e;
      } finally {
        t.endedAt = now();
        await this.save(r, t.status, t.id);
      }
    };
    // The configured local gateway has one execution lane. Send branches are
    // genuinely scheduled independently, but queued is not shown as running.
    const job = this.serial.then(work);
    this.serial = job.catch(() => {});
    return job;
  }
  async ask(r, role, system, input, signal) {
    const result = await this.model(await this.getConfig(), {
      role,
      system,
      input,
      signal,
      maxTokens: 8000,
    });
    const t = r.tasks.find((t) => t.status === "running" && t.role === role);
    const responseArtifact = await this.store.put(
      "adaptive_model_response",
      { model: result.record, parsed: result.parsed },
      t?.inputs || [],
    );
    if (t) {
      t.inputs.push(responseArtifact);
      await this.save(r, "model_returned", t.id);
    }
    return result;
  }
  async read(s) {
    const r = await this.load(s.runId);
    const parsed = await this.task(
      r,
      {
        key: "import",
        kind: "import",
        role: "PDF",
        title: "固定论文与提取原文",
        agent: "论文解析器",
        reason: "固定上传版本，提取可引用的全文。",
        inputs: [r.uploadArtifact],
      },
      async (t, signal) => {
        const upload = (await this.store.get(r.uploadArtifact)).payload;
        const source = await this.extract(upload.pdfBase64, null, signal);
        if (source.paperSha256 !== r.paperSha256)
          throw new Error("解析结果与上传论文身份不一致。");
        return { value: source };
      },
    );
    const source = parsed.value;
    r.sourceArtifact = parsed.task.output;
    r.pageCount = source.pageCount;
    r.unreadPages = source.pages
      .filter((p) => !p.text.trim())
      .map((p) => p.index);
    const chunks = readingChunks(source, this.limits.chunkCharacters);
    if (!chunks.length)
      throw new Error("论文没有可读取文本，请提供文本层或 OCR 结果。");
    if (chunks.length > this.limits.maxReadCalls)
      throw new Error("全文超出本次阅读预算；没有把未读部分当成已读。");
    for (let i = 0; i < chunks.length; i++) {
      const previous = i
        ? [...r.tasks]
            .reverse()
            .find((t) => t.key === `read:${i - 1}` && t.status === "succeeded")
        : null;
      const result = await this.task(
        r,
        {
          key: `read:${i}`,
          kind: "read",
          role: "A_READ",
          title: `阅读第 ${chunks[i][0].pageIndex + 1}–${chunks[i].at(-1).pageIndex + 1} 页`,
          agent: "原文理解 Agent",
          reason: "理解全文结构，提取带原文位置的主要命题。",
          parents: [previous?.id || parsed.task.id],
          inputs: [
            r.sourceArtifact,
            ...(previous?.output ? [previous.output] : []),
          ],
        },
        async (t, signal) => {
          const output = await this.ask(
            r,
            "A_READ",
            READ_PROMPT,
            { pages: chunks[i], precedingSummary: previous?.summary || null },
            signal,
          );
          return {
            value: validateReading(output.parsed, chunks[i], source),
            model: output.record,
          };
        },
      );
      const byId = new Map(r.claims.map((c) => [c.id, c]));
      result.value.claims.forEach((c) => {
        if (!byId.has(c.id))
          byId.set(c.id, { ...c, discoveredBy: result.task.id });
      });
      r.claims = [...byId.values()];
      if (r.claims.length > this.limits.maxClaims)
        throw new Error("命题数超过本次预算，请拆分论文；已读取结果保留。");
      await this.save(r, "claims", result.task.id);
    }
    r.status = "running";
    await this.save(r, "read_completed");
    return { round: s.round || 0 };
  }
  async syncChildren(r) {
    for (const t of r.tasks.filter((t) => t.childRunId && !t.childFinal)) {
      const child = await this.store.getRun(t.childRunId);
      const changed = t.childStatus !== child.status;
      t.childStatus = child.status;
      if (!finished(child)) {
        if (changed) await this.save(r, "child_progress", t.id);
        continue;
      }
      if (this.pipeline.active.has(child.id)) continue;
      t.childFinal = true;
      const refs = [
        ...new Set(
          [t.output, child.root, ...child.tasks.map((v) => v.output)].filter(
            Boolean,
          ),
        ),
      ];
      const snapshot = {
        id: child.id,
        status: child.status,
        error: child.error || null,
        conclusion: child.conclusion || null,
        contract: child.contract || null,
        approval: child.approval || null,
        originalProofRoute: child.originalProofRoute || null,
        tasks: child.tasks,
      };
      t.childArtifact = await this.store.put(
        "adaptive_child_result",
        snapshot,
        refs,
      );
      t.summary =
        child.conclusion?.headline || child.error || "该命题核验已结束。";
      const claim = r.claims.find((c) => c.id === t.claimId);
      if (claim) {
        claim.formalResult = snapshot;
        claim.formalArtifact = t.childArtifact;
      }
      await this.save(r, "child_completed", t.id);
    }
  }
  async decide(s) {
    const r = await this.load(s.runId);
    await this.syncChildren(r);
    const pending = r.tasks.filter((t) => t.childRunId && !t.childFinal);
    if (pending.length || r.pauseRequested) {
      r.waitReason = pending.length
        ? "确认形式化命题或等待核验完成"
        : "用户暂停";
      return { route: "wait" };
    }
    const count = r.tasks.filter((t) => ACTIONS[t.kind]).length;
    if (
      count >= this.limits.maxActions ||
      s.round >= this.limits.maxDecisions
    ) {
      r.stopReason = "达到本次评审预算，保留尚未解决的问题。";
      await this.save(r, "budget_reached");
      return { route: "conclude" };
    }
    const parents = r.tasks.filter(
      (t) => t.status === "succeeded" && t.kind !== "decide",
    );
    const result = await this.task(
      r,
      {
        key: `decide:${s.round}`,
        kind: "decide",
        role: "A_COORDINATOR",
        title: "根据当前证据决定下一步",
        agent: "协调 Agent",
        reason: "结合已读取原文与返回的产物，决定追查、补全或结束。",
        parents: frontier(parents).map((t) => t.id),
        inputs: [
          ...new Set(
            parents.flatMap((t) => [t.output, t.childArtifact]).filter(Boolean),
          ),
        ],
      },
      async (t, signal) => {
        const output = await this.ask(
          r,
          "A_COORDINATOR",
          PLAN_PROMPT,
          {
            claims: r.claims.map(({ formalResult, ...c }) => ({
              ...c,
              formalResult: formalResult
                ? {
                    id: formalResult.id,
                    status: formalResult.status,
                    conclusion: formalResult.conclusion,
                    error: formalResult.error,
                  }
                : null,
            })),
            tasks: parents.map((t) => ({
              id: t.id,
              kind: t.kind,
              claimId: t.claimId || null,
              title: t.title,
              summary: t.summary,
              childStatus: t.childStatus || null,
            })),
            findings: r.findings,
            remainingActions: this.limits.maxActions - count,
          },
          signal,
        );
        return {
          value: validateDecision(output.parsed, r),
          model: output.record,
        };
      },
    );
    if (result.value.mode === "finish") {
      r.stopReason = result.value.reason;
      return { route: "conclude" };
    }
    const actions = result.value.actions.slice(
      0,
      this.limits.maxActions - count,
    );
    const batch = [];
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i],
        key = `act:${result.task.id}:${i}`;
      let task = r.tasks.find((t) => t.key === key);
      if (!task) {
        const claim = r.claims.find((c) => c.id === action.claimId);
        task = {
          ...action,
          ...ACTIONS[action.kind],
          id: randomUUID(),
          key,
          status: "queued",
          attempt: 1,
          parents: [...new Set([result.task.id, ...action.basedOn])],
          inputs: [
            result.task.output,
            ...action.basedOn.map(
              (id) => r.tasks.find((t) => t.id === id).output,
            ),
          ],
          anchors: [claim.anchor],
          output: null,
          createdAt: now(),
        };
        r.tasks.push(task);
        await this.save(r, "scheduled", task.id);
      }
      batch.push(task.id);
    }
    return { route: "act", batch, round: (s.round || 0) + 1 };
  }
  async act(s) {
    const r = await this.load(s.runId),
      scheduled = r.tasks.find((t) => t.id === s.taskId);
    const claim = r.claims.find((c) => c.id === scheduled.claimId);
    const source = (await this.store.get(r.sourceArtifact)).payload.value;
    const result = await this.task(r, scheduled, async (t, signal) => {
      if (t.kind === "formalize" || t.kind === "recover_domain") {
        let child;
        if (t.childRunId) {
          try {
            child = await this.store.getRun(t.childRunId);
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
        }
        if (!child) {
          t.childRunId ||= randomUUID();
          await this.save(r, "child_reserved", t.id);
          const internal = {
            runId: t.childRunId,
            parentReviewId: r.id,
            parentTaskId: t.id,
          };
          if (t.kind === "recover_domain") {
            const prior = [...r.tasks]
              .reverse()
              .find(
                (v) => v.id !== t.id && v.claimId === claim.id && v.childRunId,
              );
            child = await this.pipeline.recoverDomain(
              prior.childRunId,
              { mode: "model", queries: [] },
              internal,
            );
          } else {
            const upload = (await this.store.get(r.uploadArtifact)).payload;
            child = await this.pipeline.reserve(() =>
              this.pipeline.startReserved(
                {
                  ...upload,
                  pageIndex: claim.anchor.pageIndex,
                  focusQuote: claim.anchor.quote,
                  mode: "model",
                  libraryProfile: r.libraryProfile,
                },
                internal,
              ),
            );
          }
          t.childRunId = child.id;
          await this.save(r, "child_started", t.id);
        }
        // Do not release the single gateway lane while the child is preparing.
        while (this.pipeline.active.has(child.id)) {
          if (signal?.aborted) {
            await this.pipeline.cancel(child.id).catch(() => {});
            throw new Error("子任务已请求停止。");
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        child = await this.store.getRun(child.id);
        t.childStatus = child.status;
        return {
          value: {
            summary:
              child.status === "awaiting_confirmation"
                ? "翻译与语义复核已返回，请核对命题后继续机器核验。"
                : child.error ||
                  child.conclusion?.headline ||
                  "形式化任务已返回。",
            childRunId: child.id,
            status: child.status,
            anchors: [claim.anchor],
          },
        };
      }
      // Provide all extracted text if within the input budget; otherwise declare
      // the exact surrounding pages. Never silently claim the omitted text read.
      const textBudget = CONTEXT_RUNTIME.characters;
      const ordered = [...source.pages].sort(
        (a, b) =>
          Math.abs(a.index - claim.anchor.pageIndex) -
          Math.abs(b.index - claim.anchor.pageIndex),
      );
      const pages = [];
      let size = 0;
      for (const p of ordered) {
        if (size + p.text.length <= textBudget) {
          pages.push({ pageIndex: p.index, text: p.text });
          size += p.text.length;
        }
      }
      pages.sort((a, b) => a.pageIndex - b.pageIndex);
      const output = await this.ask(
        r,
        ACTIONS[t.kind].role,
        INSPECT_PROMPTS[t.kind] + INSPECT_FORMAT,
        {
          claim: {
            id: claim.id,
            label: claim.label,
            statement: claim.statement,
            anchor: claim.anchor,
            concern: claim.concern,
          },
          question: t.question,
          pages,
          omittedPages: source.pages
            .filter((p) => !pages.some((v) => v.pageIndex === p.index))
            .map((p) => p.index),
          precedingFindings: r.findings,
        },
        signal,
      );
      const value = validateInspection(
        output.parsed,
        {
          ...source,
          pages: source.pages.filter((p) =>
            pages.some((v) => v.pageIndex === p.index),
          ),
        },
        claim,
      );
      return { value, model: output.record };
    });
    if (
      INSPECT_PROMPTS[scheduled.kind] &&
      !r.findings.some((f) => f.taskId === result.task.id)
    ) {
      r.findings.push({
        ...result.value,
        taskId: result.task.id,
        evidence: result.task.output,
      });
      claim.status = result.value.status;
      await this.save(r, "finding", result.task.id);
    }
    return {};
  }
  async wait(s) {
    const r = await this.load(s.runId);
    r.status = r.pauseRequested ? "paused" : "awaiting_confirmation";
    await this.save(r, "waiting");
    interrupt({
      reason: r.waitReason,
      children: r.tasks
        .filter((t) => t.childRunId && !t.childFinal)
        .map((t) => t.childRunId),
    });
    r.status = "running";
    r.pauseRequested = false;
    r.error = null;
    await this.save(r, "resumed");
    return {};
  }
  async conclude(s) {
    const r = await this.load(s.runId);
    await this.syncChildren(r);
    const parents = r.tasks.filter((t) => t.output);
    const result = await this.task(
      r,
      {
        key: "conclusion",
        kind: "conclude",
        role: "REPORT",
        title: "汇总本轮评审与未解决问题",
        agent: "证据汇总器",
        reason: r.stopReason,
        parents: frontier(parents).map((t) => t.id),
        inputs: [
          ...new Set(
            parents.flatMap((t) => [t.output, t.childArtifact]).filter(Boolean),
          ),
        ],
      },
      async () => ({
        value: {
          headline: "本轮评审已汇总",
          reason: r.stopReason,
          theorem: "unknown",
          scope: "paper_review_with_selected_claim_checks",
          claimCount: r.claims.length,
          inspectedCount: r.claims.filter(
            (c) => c.status !== "unreviewed" || c.formalResult,
          ).length,
          concerns: r.findings.filter((f) => f.status === "concern").length,
          unresolvedClaims: r.claims
            .filter(
              (c) => c.status === "unreviewed" || c.status === "unresolved",
            )
            .map((c) => c.id),
          limitations: [
            "AI 审阅意见需要复核；只对有独立 Lean 证据的固定命题报告机器核验结果。",
            "论文原证明尚未逐步机器形式化验证。",
            "引用核查仅覆盖提供的文本，未自动取得外部文献。",
            ...(r.unreadPages.length
              ? [
                  `第 ${r.unreadPages.map((p) => p + 1).join("、")} 页缺少可读取文本。`,
                ]
              : []),
          ],
          findings: r.findings,
          claims: r.claims,
        },
      }),
    );
    r.conclusion = result.value;
    r.root = result.task.output;
    r.status = "completed";
    r.error = null;
    await this.save(r, "completed");
    return {};
  }
  async continueChildren() {
    if (this.checking || this.busy) return;
    this.checking = true;
    try {
      for (const r of this.runs.values()) {
        if (r.status !== "awaiting_confirmation" || r.pauseRequested) continue;
        await this.syncChildren(r);
        if (
          !this.pipeline.active.size &&
          !r.tasks.some((t) => t.childRunId && !t.childFinal)
        ) {
          await this.resume(r.id);
          break;
        }
      }
    } catch {
      /* An explicit Resume remains available if storage is unavailable. */
    } finally {
      this.checking = false;
    }
  }
  async adoptChild(previousId, next) {
    if (!next.parentReviewId) return;
    const r = await this.load(next.parentReviewId);
    const t =
      r.tasks.find((t) => t.childRunId === previousId) ||
      r.tasks.find(
        (t) =>
          t.id === next.parentTaskId &&
          (t.childRunId === next.id ||
            t.previousChildRuns?.includes(previousId)),
      );
    if (
      !t ||
      ["completed", "cancelled"].includes(r.status) ||
      next.continuedFrom !== previousId ||
      next.paperSha256 !== r.paperSha256 ||
      next.parentTaskId !== t.id
    )
      throw Error("继续核验未对应当前论文及任务的版本链，未接入父评审。");
    if (t.childRunId === next.id) return;
    if (t.childRunId !== previousId) {
      const current = await this.store.getRun(t.childRunId);
      if (
        ["preparing", "running", "awaiting_confirmation"].includes(
          current.status,
        )
      )
        throw Error("已有更新的子核验正在执行，不能被旧版本的继续操作覆盖。");
    }
    t.previousChildRuns = [
      ...new Set([...(t.previousChildRuns || []), previousId, t.childRunId]),
    ];
    t.childRunId = next.id;
    t.childFinal = false;
    t.childStatus = next.status;
    await this.save(r, "child_continued", t.id);
  }
  async skipChild(id, taskId) {
    return this.pipeline.reserve(() => this.skipChildReserved(id, taskId));
  }
  async skipChildReserved(id, taskId) {
    const r = await this.load(id),
      t = r.tasks.find((t) => t.id === taskId);
    if (this.busy || !t?.childRunId || t.childFinal)
      throw new Error("当前没有可跳过的待确认任务。");
    const child = await this.store.getRun(t.childRunId);
    if (child.status !== "awaiting_confirmation")
      throw new Error("只能跳过尚未确认的形式化任务。");
    child.status = "cancelled";
    child.error = "用户选择跳过本次形式化，未解决项保留。";
    await this.store.saveRun(child);
    await this.save(r, "human_skipped_child", t.id);
    await this.syncChildren(r);
    return r;
  }
  async pause(id) {
    const r = await this.load(id);
    if (!this.active.has(id)) throw new Error("评审当前没有运行。");
    r.pauseRequested = true;
    await this.save(r, "pause_requested");
    return {
      id,
      pauseRequested: true,
      message: "当前批次完成后暂停，已完成产物会保留。",
    };
  }
  async resume(id) {
    if (this.busy || this.pipeline.active.size || this.pipeline.reserved)
      throw new Error("当前步骤仍在执行，请稍后继续。");
    this.starting = true;
    try {
      return await this.resumeReserved(id);
    } finally {
      this.starting = false;
    }
  }
  async resumeReserved(id) {
    const r = await this.load(id);
    if (
      !["paused", "awaiting_confirmation", "blocked", "interrupted"].includes(
        r.status,
      )
    )
      throw new Error("此评审不能恢复。");
    await this.syncChildren(r);
    if (r.tasks.some((t) => t.childRunId && !t.childFinal))
      throw new Error("请先完成命题确认与核验，或结束该子任务。");
    const state = await this.graph.getState({
      configurable: { thread_id: id },
    });
    const interrupted = state.tasks?.some((t) => t.interrupts?.length);
    r.error = null;
    r.status = "running";
    r.pauseRequested = false;
    await this.save(r, "resume_requested");
    this.launch(
      r,
      interrupted
        ? new Command({ resume: true })
        : state.values?.runId
          ? null
          : { runId: id, round: 0 },
    );
    return r;
  }
  async cancel(id) {
    const r = await this.load(id);
    if (this.active.has(id)) {
      this.active.get(id).abort();
      return { id, cancellationRequested: true };
    }
    if (r.status === "completed") throw new Error("已完成评审不能取消。");
    for (const t of r.tasks.filter((t) => t.childRunId && !t.childFinal)) {
      if (this.pipeline.active.has(t.childRunId))
        await this.pipeline.cancel(t.childRunId);
      else {
        const child = await this.store.getRun(t.childRunId);
        if (child.status === "awaiting_confirmation") {
          child.status = "cancelled";
          child.error = "用户停止了本轮评审。";
          await this.store.saveRun(child);
        }
      }
    }
    r.status = "cancelled";
    await this.save(r, "cancelled");
    return r;
  }
}
