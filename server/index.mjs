import { readerTaskPage } from "./team/work-summary.mjs";
import { OriginalProofEngine } from "./original-proof.mjs";
import { MathematicalTools } from "./tools/mathematics.mjs";
import { TeamRuntime } from "./team/runtime.mjs";
import { TeamResources } from "./resources/team-resources.mjs";
import { TeamPublicViews } from "./team/public-view.mjs";
import { CodexCliAdapter } from "./adapters/codex-cli.mjs";
import { OriginalProofService } from "./original-proof-service.mjs";
import {
  NETWORK_RUNTIME,
  PROOF_RUNTIME,
  REVIEW_RUNTIME,
  DOMAIN_RUNTIME,
  MODEL_RUNTIME,
  LEAN_RUNTIME,
} from "./runtime-limits.mjs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { EvidenceStore, isId, isHash, sha256 } from "./evidence.mjs";
import { sendEvidence } from "./evidence-io.mjs";
import { ReviewPipeline } from "./pipeline.mjs";
import { leanStatus } from "./lean.mjs";
import { environmentCatalog } from "./lean-environments.mjs";
import { modelConfig, callModel } from "./model.mjs";
import {
  enrichMathematicalSource,
  documentParserEnabled,
} from "./math-extraction.mjs";
import { reviewModelTransport } from "./review-transport.mjs";
import { profileStatuses } from "./libraries.mjs";
import { PaperLedger } from "./paper-ledger.mjs";
import { AutonomousReview as AdaptiveReview } from "./autonomous.mjs";
import { CsReview, refuseMathReplay } from "./cs-review.mjs";
import { modelPool, leanPool } from "./resource-pool.mjs";
import { ReaderAssistant } from "./reader-assistant.mjs";
import { ProvingEngine } from "./proving-engine.mjs";
import { proverCapabilities } from "./prover-session.mjs";
import { specialistStatus } from "./specialist-model.mjs";
import {
  DeepProofHarness,
  harnessModelAdapter,
  replayHarness,
} from "./deep-harness.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
async function evaluationSummary() {
  try {
    const report = JSON.parse(
      await readFile(
        path.join(root, "evidence/capability-evaluation-summary.json"),
        "utf8",
      ),
    );
    const fingerprints = Object.entries(report.implementation);
    if (
      !fingerprints.length ||
      fingerprints.some(
        ([name]) => !/^(server|shared|fixtures)\/[A-Za-z0-9_.-]+$/.test(name),
      )
    )
      throw new Error("Invalid evaluation manifest");
    const matches = await Promise.all(
      fingerprints.map(
        async ([file, hash]) =>
          sha256(await readFile(path.join(root, file))) === hash,
      ),
    );
    return {
      ...report.summary,
      available: true,
      recordedAt: report.recordedAt,
      currentImplementation: matches.every(Boolean),
    };
  } catch {
    return { available: false };
  }
}
async function bodyOf(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new Error("请求必须为 JSON。");
  const chunks = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 38 * 1024 * 1024) throw new Error("请求超过本机处理预算。");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function createApp({
  dataRoot = process.env.LEMMA_DATA_ROOT || path.join(root, ".runtime"),
  configProvider = () => modelConfig(root),
  semanticConfigProvider,
  documentExtractor = async (paper, pageIndex, options) =>
    enrichMathematicalSource(paper, pageIndex, {
      ...options,
      docling: await documentParserEnabled(root),
    }),
  checker,
  model,
  // Instrumenting the wire must not select the parsed-model test seam below.
  transportModel = callModel,
  adaptiveOptions = {},
  provingOptions = {},
  originalProofOptions = {},
  teamOptions = {},
  readOnly = false,
  origins = ["http://127.0.0.1:4178", "http://localhost:4178"],
} = {}) {
  const store = new EvidenceStore(dataRoot);
  await store.init();
  const teamViews = new TeamPublicViews((id) => store.get(id));
  let adaptive;
  const transportOptions = {
    model: model || transportModel,
    getReview: (id) => adaptive.load(id),
    saveReview: (...args) => adaptive.save(...args),
    store,
  };
  const childModel = reviewModelTransport(transportOptions);
  const provingEnabled =
    provingOptions.enabled ?? process.env.LEMMA_PROVER_SEARCH !== "0";
  const harness = new DeepProofHarness({ store, model: childModel, checker });
  const managedModel = model
    ? childModel
    : harnessModelAdapter({ store, model: childModel, checker, harness });
  const pipeline = new ReviewPipeline({
    store,
    getConfig: configProvider,
    getSemanticConfig:
      semanticConfigProvider ||
      (async () =>
        (await modelConfig(root, process.env, "LEMMA_SEMANTIC_MODEL")) ||
        (await configProvider())),
    documentExtractor,
    checker,
    model: managedModel,
    concurrent: true,
    prover: provingEnabled
      ? new ProvingEngine({
          checker,
          model: reviewModelTransport({
            ...transportOptions,
          }),
          ...provingOptions,
        })
      : null,
    provingBudget: provingOptions.budget || {},
    reserveProverModel: async (owner) => {
      if (!owner?.parentReviewId) return;
      const parent = await adaptive.load(owner.parentReviewId);
      if (parent.infrastructureFailure)
        throw Error("模型连接异常，未预留新的证明请求。");
      if (
        ["cancelled", "completed", "blocked"].includes(parent.status) ||
        (parent.modelCalls || 0) >= parent.limits.maxModelCalls
      )
        throw Error("父评审模型预算已耗尽。");
      // Actual transport reservation is shared with every SDK iteration.
    },
  });
  if (originalProofOptions.enabled !== false)
    pipeline.originalProofEngine = new OriginalProofEngine({
      store,
      model: managedModel,
      checker,
      limits: originalProofOptions.limits,
    });
  if (!readOnly) await pipeline.init();
  const originalProofs = new OriginalProofService({
    store,
    limits: originalProofOptions.limits,
    getConfig: configProvider,
    model: managedModel,
    checker,
  });
  if (!readOnly) await originalProofs.init();
  adaptive = new AdaptiveReview({
    store,
    pipeline,
    getConfig: configProvider,
    model: managedModel,
    transportBudgetManaged: true,
    ...adaptiveOptions,
  });
  if (!readOnly) await adaptive.init();
  const csReview = new CsReview({
    store,
    checker,
    getConfig: configProvider,
    model: callModel,
  });
  const ledger = new PaperLedger({ store, pipeline });
  if (!readOnly) await ledger.init();
  const reader = new ReaderAssistant({
    store,
    getConfig: configProvider,
    model,
    isBusy: () => false,
  });
  if (!readOnly) await reader.init();
  const team = new TeamRuntime({
    store,
    mathTools: new MathematicalTools({ store }),
    executor: teamOptions.executor || new CodexCliAdapter(),
    resources: teamOptions.resources || new TeamResources(),
    ...teamOptions,
  });
  if (!readOnly) await team.init();
  const server = http.createServer(async (req, res) => {
    const send = (code, data, download) => {
      res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(download
          ? { "Content-Disposition": `attachment; filename="${download}"` }
          : {}),
      });
      res.end(JSON.stringify(data));
    };
    try {
      if (readOnly && !["GET", "HEAD"].includes(req.method))
        return send(403, {
          error:
            "Archived reader is read-only; no execution or recovery is permitted",
        });
      const host = req.headers.host || "";
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host))
        return send(403, { error: "只接受本机请求。" });
      if (req.headers.origin && !origins.includes(req.headers.origin))
        return send(403, { error: "请求来源不受支持。" });
      if (req.headers["sec-fetch-site"] === "cross-site")
        return send(403, { error: "不接受跨站请求。" });
      const url = new URL(req.url, `http://${host}`),
        parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "api") return send(404, { error: "入口不存在。" });
      if (req.method === "GET" && url.pathname === "/api/lean/environments")
        return send(200, {
          defaultEnvironment: "lean-4.35.0",
          environments: await environmentCatalog(),
        });
      if (req.method === "POST" && url.pathname === "/api/harness") {
        const b = await bodyOf(req);
        if (
          typeof b.goal !== "string" ||
          !b.goal.trim() ||
          b.goal.length > 1000000
        )
          throw Error("Invalid harness task");
        return send(
          202,
          await harness.start({
            config: await configProvider(),
            goal: b.goal,
            contract: b.contract,
            inputs: b.inputs || [],
          }),
        );
      }
      if (parts[1] === "harness" && isId(parts[2])) {
        const r = await store.getRun(parts[2]);
        if (r.engine !== "deepagents-v1") throw Error("Invalid harness run");
        if (req.method === "GET" && parts[3] === "bundle")
          return await sendEvidence(res, store, r.root, {
            format: "json",
            fileName: `lemma-harness-${r.id}`,
          });
        if (req.method === "POST" && parts[3] === "replay")
          return send(200, await replayHarness(store, r.id, { checker }));
        if (req.method === "GET") return send(200, r);
        if (req.method === "POST" && parts[3] === "cancel") {
          harness.cancel(r.id);
          return send(202, { id: r.id, status: "cancelling" });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/reader/chats")
        return send(202, await reader.start(await bodyOf(req)));
      if (parts[1] === "reader" && parts[2] === "chats" && isId(parts[3])) {
        if (req.method === "GET" && parts.length === 4)
          return send(200, await reader.get(parts[3]));
        if (
          req.method === "POST" &&
          parts.length === 5 &&
          parts[4] === "cancel"
        )
          return send(200, await reader.cancel(parts[3]));
      }
      if (req.method === "POST" && url.pathname === "/api/original-proofs")
        return send(202, await originalProofs.start(await bodyOf(req)));
      if (req.method === "GET" && url.pathname === "/api/original-proofs") {
        const paper = url.searchParams.get("paperSha256");
        if (!isHash(paper)) throw Error("Invalid paper identity");
        return send(200, { items: await originalProofs.list(paper) });
      }
      if (parts[1] === "original-proofs" && isId(parts[2])) {
        const id = parts[2],
          r = await store.getRun(id);
        if (r.engine !== "original-proof-v1")
          throw Error("Invalid original proof run");
        if (req.method === "GET" && parts.length === 3) return send(200, r);
        if (req.method === "GET" && parts[3] === "bundle")
          return await sendEvidence(res, store, r.root, {
            format:
              url.searchParams.get("format") === "ndjson" ? "ndjson" : "json",
            fileName: `lemma-original-proof-${id}`,
          });
        if (req.method === "POST" && parts[3] === "cancel")
          return send(200, await originalProofs.cancel(id));
        if (req.method === "POST" && parts[3] === "replay")
          return send(200, await originalProofs.replay(id));
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        const [config, lean] = await Promise.all([
          configProvider(),
          leanStatus(),
        ]);
        return send(200, {
          service: "lemma-review-v1",
          harness: {
            name: "Deep Agents JS",
            version: "1.15.1",
            enabled: !model,
            transport: "application-tool-calling-adapter",
            execution: "macOS-seatbelt-offline-workspace",
            toolStages: [
              "source_scope",
              "translation",
              "dependency_recovery",
              "finite_experiments",
              "proof",
            ],
          },
          model: {
            configured: !!config,
            name: config?.model || null,
            reasoningEffort: config?.reasoningEffort || null,
            timeoutMs: config?.timeoutMs || null,
            maxOutputTokens: config?.maxOutputTokens || null,
            maxResponseBytes: config?.maxResponseBytes || null,
            resources: modelPool(config).snapshot(),
          },
          runtimeLimits: {
            proof: { ...PROOF_RUNTIME, ...pipeline.provingBudget },
            review: adaptive.limits,
            domain: DOMAIN_RUNTIME,
            model: {
              timeoutCeilingMs: MODEL_RUNTIME.timeoutMs,
              outputCeilingTokens: MODEL_RUNTIME.outputTokens,
            },
            lean: LEAN_RUNTIME,
            appliesTo: "new_runs_existing_run_evidence_unchanged",
          },
          lean,
          libraryProfiles: await profileStatuses(lean.ready),
          scope: "adaptive_paper_review_with_selected_claim_checks",
          originalProofVerification:
            "source_mapped_local_lean_checks_with_dependency_audit",
          capabilities: {
            version: "0.10.0",
            adaptiveReview: {
              engine: "langgraph-v1",
              persisted: true,
              eventStream: true,
              orchestrationVersion: 2,
              automaticEnvironment: true,
              completePropositionScopes: adaptive.sourceScopes,
              unchangedFailureStop: true,
              branchRecovery: true,
              independentWorkers: true,
              leanResources: leanPool.snapshot(),
            },
            readerAssistant: true,
            focusedReview: true,
            domainRecovery: true,
            translationReview: true,
            crossPageContext: true,
            boundedProofRepair: true,
            provingSearch: {
              ...(await proverCapabilities()),
              enabled: provingEnabled,
            },
            specialistProver: await specialistStatus(),
            evaluation: await evaluationSummary(),
          },
        });
      }
      if (req.method === "POST" && url.pathname === "/api/cs-candidates")
        return send(200, await csReview.proposeCandidates(await bodyOf(req)));
      if (req.method === "POST" && url.pathname === "/api/reviews") {
        const input = await bodyOf(req);
        if (input.orchestration === "team")
          return send(202, await team.start(input));
        if (input.track === "cs" || input.orchestration === "cs")
          return send(202, await csReview.start(input));
        if (input.track && input.track !== "math")
          throw new Error("论文类型无效。");
        if (adaptive.busy)
          return send(409, { error: "自主评审正在执行，请等待或暂停。" });
        return send(
          202,
          input.orchestration === "adaptive"
            ? await adaptive.start(input)
            : await pipeline.start(input),
        );
      }
      if (req.method === "GET" && url.pathname === "/api/reviews")
        return send(200, await store.listRuns(url.searchParams.get("paper")));
      if (parts[1] === "papers" && isHash(parts[2]) && parts[3] === "ledger") {
        const paper = parts[2];
        if (req.method === "GET" && parts.length === 4)
          return send(200, await ledger.get(paper));
        if (req.method === "POST" && parts.length === 4)
          return send(200, await ledger.mutate(paper, await bodyOf(req)));
        if (
          req.method === "POST" &&
          parts.length === 5 &&
          parts[4] === "create"
        )
          return send(201, await ledger.create(paper, await bodyOf(req)));
        if (
          req.method === "GET" &&
          parts.length === 5 &&
          parts[4] === "bundle"
        ) {
          const bundle = await ledger.bundle(paper);
          return send(
            200,
            bundle,
            `lemma-paper-${paper.slice(0, 12)}-${bundle.root.slice(0, 12)}.json`,
          );
        }
        if (
          req.method === "POST" &&
          parts.length === 5 &&
          parts[4] === "replay"
        )
          return send(200, await ledger.replay(paper));
      }
      if (parts[1] === "reviews" && isId(parts[2])) {
        const id = parts[2];
        if (
          parts.length === 4 &&
          parts[3] === "events" &&
          req.method === "GET"
        ) {
          const run = await store.getRun(id);
          if (run.engine === "team-v1") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store",
              Connection: "keep-alive",
            });
            const emit = (e) =>
              res.write(
                `id: ${e.seq}\nevent: review\ndata: ${JSON.stringify(e)}\n\n`,
              );
            team.events.on(id, emit);
            emit({ seq: run.revision, type: "snapshot" });
            const timer = setInterval(
              () => res.write(": heartbeat\n\n"),
              15000,
            );
            req.on("close", () => {
              clearInterval(timer);
              team.events.off(id, emit);
            });
            return;
          }
          if (run.engine !== "langgraph-v1")
            return send(400, { error: "此记录不支持实时事件流。" });
          const raw =
            req.headers["last-event-id"] ||
            url.searchParams.get("after") ||
            "0";
          let cursor = Number(raw);
          if (!Number.isSafeInteger(cursor) || cursor < 0)
            return send(400, { error: "事件游标无效。" });
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          const emit = (event) => {
            if (event.seq > cursor) {
              cursor = event.seq;
              res.write(
                `id: ${event.seq}\nevent: review\ndata: ${JSON.stringify(event)}\n\n`,
              );
            }
          };
          // Register before rereading so an event cannot fall between replay and subscription.
          const pending = [];
          let replaying = true;
          const listener = (event) =>
            replaying ? pending.push(event) : emit(event);
          adaptive.events.on(id, listener);
          try {
            const current = await store.getRun(id);
            current.events.forEach(emit);
            replaying = false;
            pending.forEach(emit);
          } catch {
            adaptive.events.off(id, listener);
            res.end();
            return;
          }
          const heartbeat = setInterval(
            () => res.write(": heartbeat\n\n"),
            15000,
          );
          req.on("close", () => {
            clearInterval(heartbeat);
            adaptive.events.off(id, listener);
          });
          return;
        }
        if (
          req.method === "POST" &&
          parts.length === 4 &&
          parts[3] === "skip-child"
        ) {
          const run = await store.getRun(id);
          if (run.engine !== "langgraph-v1")
            return send(400, { error: "此记录不支持跳过子任务。" });
          return send(
            202,
            await adaptive.skipChild(id, (await bodyOf(req)).taskId),
          );
        }
        if (
          req.method === "POST" &&
          parts.length === 4 &&
          ["pause", "resume"].includes(parts[3])
        ) {
          const run = await store.getRun(id);
          if (run.engine === "team-v1") {
            const b = await bodyOf(req);
            if (parts[3] === "pause") {
              const current = team.runs.get(id);
              if (
                !current ||
                !["running", "pausing", "paused"].includes(current.status)
              )
                throw Error("Review is not pausable in this process");
              const draining = team.pause(id, {
                reason: b.reason || "User paused from reader",
              });
              void draining.catch(async (error) => {
                await team
                  .edit(id, (r) => {
                    r.pause = { ...r.pause, error: error.message };
                  })
                  .catch(() => {});
              });
              return send(202, {
                id,
                status: current.status,
                pause: current.pause || null,
              });
            }
            return send(
              202,
              await team.resume(id, {
                expectedRoot: b.expectedRoot,
                authorization: "Explicit user resume from reader",
              }),
            );
          }
          if (run.engine !== "langgraph-v1")
            return send(400, { error: "此记录不支持暂停或恢复。" });
          return send(202, await adaptive[parts[3]](id));
        }
        if (req.method === "GET" && parts.length === 3) {
          const view = await teamViews.read(await store.getRun(id));
          view.readOnly = readOnly;
          try {
            view.delivery = JSON.parse(
              await readFile(
                path.join(store.root, "deliveries", id + ".json"),
                "utf8",
              ),
            );
          } catch (e) {
            if (e.code !== "ENOENT")
              view.delivery = { status: "unavailable", error: e.message };
          }
          if (view.engine === "team-v1")
            view.liveResources = await team.resources.observe();
          return send(200, view);
        }
        if (req.method === "GET" && parts[3] === "tasks") {
          const run = await store.getRun(id);
          const options = Object.fromEntries(
            ["bound", "before", "limit"]
              .filter((k) => url.searchParams.has(k))
              .map((k) => [k, Number(url.searchParams.get(k))]),
          );
          return send(200, readerTaskPage(run, options));
        }
        if (req.method === "GET" && parts[3] === "operations") {
          const run = await team.load(id),
            all = run.operations || [];
          const bound = Math.min(
            all.length,
            Number(url.searchParams.get("bound") || all.length),
          );
          const before = Math.min(
            bound,
            Number(url.searchParams.get("before") || bound),
          );
          const limit = Math.min(
            100,
            Number(url.searchParams.get("limit") || 25),
          );
          if (
            ![bound, before, limit].every(Number.isSafeInteger) ||
            before < 0 ||
            bound < 0 ||
            limit < 1
          )
            throw Error("Invalid operation page cursor");
          const actor = url.searchParams.get("actor");
          let index = before,
            items = [];
          while (index > 0 && items.length < limit) {
            const op = all[--index];
            if (!actor || op.actorId === actor) {
              const { originalArguments, resolvedArguments, ...value } = op;
              items.push(value);
            }
          }
          return send(200, {
            items,
            bound,
            nextBefore: index > 0 ? index : null,
            total: all.length,
            revision: run.revision,
            scope: "stable_creation_order_current_status",
            newerCount: all.length - bound,
          });
        }
        if (req.method === "GET" && parts[3] === "source") {
          const run = await store.getRun(id);
          if (run.engine !== "team-v1") throw Error("Unsupported source entry");
          return send(200, {
            ...(await store.get(run.sourceArtifact)).payload,
            review: { id: run.id, title: run.title, createdAt: run.createdAt },
          });
        }
        if (
          req.method === "POST" &&
          parts[3] === "recover-domain" &&
          parts.length === 4
        ) {
          const child = await pipeline.recoverDomain(id, await bodyOf(req));
          await adaptive.adoptChild(id, child);
          return send(202, child);
        }
        if (req.method === "POST" && parts[3] === "approve")
          return send(202, await pipeline.approve(id, await bodyOf(req)));
        if (
          req.method === "POST" &&
          parts[3] === "adopt-continuation" &&
          parts.length === 4
        ) {
          const body = await bodyOf(req);
          if (
            !isId(body.childRunId) ||
            Object.keys(body).some((k) => k !== "childRunId")
          )
            throw Error("继续核验版本无效。");
          const child = await store.getRun(body.childRunId);
          await adaptive.adoptChild(id, child);
          return send(202, {
            adopted: true,
            childRunId: child.id,
            parentReviewId: child.parentReviewId,
          });
        }
        if (
          req.method === "POST" &&
          parts[3] === "retry-translation" &&
          parts.length === 4
        ) {
          const child = await pipeline.retryTranslation(id, {
            repairAlignment: true,
          });
          await adaptive.adoptChild(id, child);
          return send(202, child);
        }
        if (req.method === "POST" && parts[3] === "cancel") {
          const run = await store.getRun(id);
          if (run.engine === "team-v1") return send(202, await team.cancel(id));
          if (run.engine === "cs-review-v1")
            throw new Error(
              "计算机评审记录保留已收到的检查，不从数学入口取消。",
            );
          return send(
            202,
            run.engine === "langgraph-v1"
              ? await adaptive.cancel(id)
              : await pipeline.cancel(id),
          );
        }
        if (req.method === "GET" && parts[3] === "bundle") {
          const run = await store.getRun(id);
          const exportRoot = run.root || run.failureRoot;
          if (!exportRoot) throw new Error("证据尚未归档，不能导出报告。");
          return await sendEvidence(res, store, exportRoot, {
            format:
              url.searchParams.get("format") === "ndjson" ? "ndjson" : "json",
            fileName: `lemma-evidence-${id}`,
          });
        }
        if (
          req.method === "POST" &&
          parts[3] === "cs-replay" &&
          parts.length === 4
        )
          return send(200, await csReview.replay(id, await bodyOf(req)));
        if (req.method === "POST" && parts[3] === "replay") {
          if (pipeline.active.size)
            throw new Error("请等待当前评审结束后再复现。");
          const run = await store.getRun(id);
          refuseMathReplay(run.engine);
          if (run.engine === "team-v1") return send(200, await team.replay(id));
          if (run.engine === "langgraph-v1")
            throw new Error(
              "请在对应命题的核验记录中复现 Lean 产物；全文评审包用于追溯。 ",
            );
          if (!run.root) throw new Error("此任务没有可复现的检查产物。");
          return send(
            200,
            await pipeline.replay(await store.bundle(run.root), run.root),
          );
        }
      }
      if (
        req.method === "GET" &&
        parts[1] === "artifacts" &&
        isHash(parts[2]) &&
        parts.length === 3
      ) {
        const artifact = await store.get(parts[2]);
        if (url.searchParams.get("view") !== "summary")
          return send(200, artifact);
        const preview = JSON.parse(
          JSON.stringify(artifact.payload, (key, value) =>
            key === "pdfBase64"
              ? "[原始 PDF 字节包含在完整复现包中]"
              : typeof value === "string" && value.length > 4000
                ? value.slice(0, 4000) + "…"
                : value,
          ),
        );
        return send(200, {
          id: artifact.id,
          kind: artifact.kind,
          inputs: artifact.inputs,
          preview,
          notice: "此为摘要预览；完整产物及摘要验证见导出的复现包。",
        });
      }
      return send(404, { error: "入口不存在。" });
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(error.code === "ENOENT" ? 404 : 400, {
        error: error.code === "ENOENT" ? "本机未找到这条记录。" : error.message,
      });
    }
  });
  server.requestTimeout = NETWORK_RUNTIME.requestTimeoutMs;
  server.once("close", () => {
    void adaptive.close();
    void harness.close();
    void team.close();
  });
  return { server, pipeline, adaptive, store, ledger, reader, harness, team };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await createApp();
  const { server } = app;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.team.close();
    await app.adaptive.close();
    await app.harness.close();
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  server.listen(4179, "127.0.0.1", () =>
    console.log("Lemma review API: http://127.0.0.1:4179"),
  );
}
