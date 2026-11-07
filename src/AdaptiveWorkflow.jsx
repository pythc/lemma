import { reviewOutcome } from "../shared/review-outcome.mjs";
import { OriginalProofDetails } from "./OriginalProofDetails.jsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Handle, Position, MarkerType } from "@xyflow/react";
import {
  CheckCircle,
  Circle,
  ArrowClockwise,
  WarningCircle,
  PauseCircle,
  ArrowSquareOut,
  X,
  ArrowsOut,
  ArrowsIn,
  GitBranch,
  FileText,
  Minus,
  Plus,
  CornersOut,
  CaretRight,
  ArrowLeft,
} from "@phosphor-icons/react";
import {
  groupReviewTasks,
  pathTaskStatus,
  visibleParents,
  overviewDependencies,
} from "./review-path.js";
import { ACTION_STATES, isAdaptive } from "../shared/adaptive.mjs";
import { request } from "./api.js";
import {
  readingStatus,
  reviewErrorMessage,
} from "../shared/reading-status.mjs";
import "@xyflow/react/dist/style.css";
import "./adaptive-workflow.css";

const iconFor = (s) =>
  ({
    succeeded: CheckCircle,
    running: ArrowClockwise,
    blocked: WarningCircle,
    interrupted: WarningCircle,
    awaiting_confirmation: PauseCircle,
    paused: PauseCircle,
    recovering: ArrowClockwise,
    unresolved: WarningCircle,
  })[s] || Circle;
function TaskNode({ data, selected }) {
  const t = data.task,
    status = pathTaskStatus(t);
  const statusLabel =
    data.agentSemantic && status === "awaiting_confirmation"
      ? "正在复核"
      : ACTION_STATES[status] || status;
  const Icon = iconFor(status);
  return (
    <button
      style={{
        width: data.width,
        ...(data.height ? { height: data.height } : {}),
      }}
      className={`path-node ${data.group ? "path-group-node" : ""} ${status} ${selected ? "selected" : ""}`}
      onClick={() => data.select(t.id)}
      title={t.fullTitle || t.title}
      aria-label={
        data.group
          ? `${t.title}，${t.summary}，展开步骤`
          : `${t.title}，${statusLabel}，查看详情`
      }
    >
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
      <Handle type="target" id="side-in" position={Position.Left} />
      <Handle type="source" id="side-out" position={Position.Right} />
      <Handle type="source" id="fork" position={Position.Left} />
      <Handle type="target" id="join" position={Position.Right} />
      <Icon
        size={23}
        weight={status === "succeeded" ? "fill" : "regular"}
        className={status === "running" ? "spin" : ""}
      />
      <span>
        <strong>{t.title}</strong>
        <small>
          {data.group ? t.summary : `${t.agent || t.role} · ${statusLabel}`}
        </small>
      </span>
      {data.group && <CaretRight size={16} className="path-group-caret" />}
    </button>
  );
}
const nodeTypes = { task: TaskNode };
const MIN_PATH_ZOOM = 0.05;
const MAX_PATH_ZOOM = 2;

function nodeViewport(node, canvas, zoom, last = false) {
  return {
    x: canvas.clientWidth / 2 - (node.position.x + node.data.width / 2) * zoom,
    y: last
      ? canvas.clientHeight -
        24 -
        (node.position.y + (node.data.height || 78)) * zoom
      : 24 - node.position.y * zoom,
    zoom,
  };
}
export function taskGraph(
  run,
  select,
  selected,
  showRepairs = false,
  taskIds = null,
  cardWidth = 284,
) {
  const tasks = (run?.tasks || []).filter(
    (t) =>
      (!taskIds || taskIds.includes(t.id)) &&
      (showRepairs ||
        !["diagnose", "diagnose_child"].includes(t.kind) ||
        t.id === selected),
  );
  const ids = new Set(tasks.map((t) => t.id)),
    edges = [];
  for (const t of tasks)
    for (const [i, parent] of visibleParents(t, run.tasks, ids).entries()) {
      if (i > 0 && t.id !== selected) continue;
      edges.push({
        id: `${parent}:${t.id}`,
        source: parent,
        target: t.id,
        type: "smoothstep",
        sourceHandle: i ? "side-out" : "fork",
        targetHandle: i ? "join" : "side-in",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        style: {
          stroke: i ? "#a55770" : "#927782",
          strokeWidth: 1.5,
          ...(i ? { strokeDasharray: "4 4" } : {}),
        },
      });
    }
  return {
    nodes: tasks.map((t, i) => ({
      id: t.id,
      type: "task",
      position: { x: 24, y: 12 + i * 100 },
      data: {
        task: t,
        select,
        width: cardWidth,
        agentSemantic: run.semanticPolicy === "agent",
      },
      selected: t.id === selected,
      draggable: false,
    })),
    edges,
    width: cardWidth + 48,
    height: Math.max(250, tasks.length * 100 + 12),
  };
}

function overviewGraph(run, grouped, open, selected, cardWidth = 284) {
  const nodes = [],
    edges = [],
    groups = grouped.groups;
  const shared = groups.filter(
      (g) => g.kind !== "claim" && g.kind !== "report",
    ),
    claims = groups.filter((g) => g.kind === "claim"),
    report = groups.find((g) => g.kind === "report");
  let y = 12;
  const add = (g, height) => {
    nodes.push({
      id: g.id,
      type: "task",
      position: { x: 24, y },
      data: { task: g, select: open, width: cardWidth, height, group: true },
      selected: g.taskIds.includes(selected),
      draggable: false,
    });
    y += height + 12;
  };
  const link = (a, b, handles = {}) =>
    edges.push({
      id: `${a.id}:${b.id}`,
      source: a.id,
      target: b.id,
      type: "smoothstep",
      ...handles,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: { stroke: "#927782", strokeWidth: 1.5 },
    });
  for (const g of shared) add(g, 52);
  for (const g of claims) add(g, g.title.length > 26 ? 80 : 68);
  if (report) add(report, 52);
  for (const e of overviewDependencies(run, grouped)) {
    const a = groups.find((g) => g.id === e.source),
      b = groups.find((g) => g.id === e.target);
    link(
      a,
      b,
      b.kind === "claim"
        ? { sourceHandle: "fork", targetHandle: "side-in" }
        : a.kind === "claim"
          ? { sourceHandle: "side-out", targetHandle: "join" }
          : {},
    );
  }
  return { nodes, edges, width: cardWidth + 48, height: y + 12 };
}
export function AdaptiveWorkflow({
  run,
  paper,
  runs,
  onSelectRun,
  onLocate,
  onTask,
  onChild,
  onReveal,
  onNew,
  revealed,
  error: outerError,
  legacy = false,
  onConclusion,
  onRefresh,
}) {
  const detailRef = useRef(null),
    canvasRef = useRef(null),
    viewedRun = useRef(null),
    manualViewport = useRef(false);
  const [selected, setSelected] = useState(null),
    [expanded, setExpanded] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [flow, setFlow] = useState(null),
    [child, setChild] = useState(null);
  const [clock, setClock] = useState(Date.now());
  const [showRepairs, setShowRepairs] = useState(false);
  const [focusGroup, setFocusGroup] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [viewWidth, setViewWidth] = useState(0);
  const cardWidth = Math.max(200, Math.min(284, (viewWidth || 332) - 48));
  useEffect(() => {
    if (!flow || !canvasRef.current) return;
    let previousWidth = 0,
      previousHeight = 0;
    const observer = new ResizeObserver(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const width = canvas.clientWidth,
        height = canvas.clientHeight;
      if (previousWidth && manualViewport.current) {
        const viewport = flow.getViewport();
        const oldCard = Math.max(200, Math.min(284, previousWidth - 48));
        const newCard = Math.max(200, Math.min(284, width - 48));
        void flow.setViewport({
          ...viewport,
          x:
            viewport.x +
            (width - previousWidth) / 2 -
            ((newCard - oldCard) * viewport.zoom) / 2,
          y: viewport.y + (height - previousHeight) / 2,
        });
      }
      previousWidth = width;
      previousHeight = height;
      setViewWidth(width);
    });
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [flow]);
  useEffect(() => {
    if (!["running", "preparing"].includes(run.status)) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.status]);
  useEffect(() => {
    if (selected)
      detailRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
  }, [selected]);
  const grouped = useMemo(() => groupReviewTasks(run), [run]);
  const currentGroup = grouped.groups.find((g) => g.id === focusGroup);
  const selectTask = (id) => {
    setSelected(id);
    const owner = grouped.owner.get(id);
    setFocusGroup(owner && owner !== "dispatch" ? `group:${owner}` : null);
  };
  const openGroup = (id) => {
    const group = grouped.groups.find((g) => g.id === id);
    if (!group) return;
    if (group.taskIds.length === 1 && group.kind !== "claim")
      setSelected(group.taskIds[0]);
    else {
      setFocusGroup(id);
      setSelected(null);
    }
  };
  const t = run.tasks.find((t) => t.id === selected),
    graph = useMemo(
      () =>
        currentGroup
          ? taskGraph(
              run,
              selectTask,
              selected,
              showRepairs,
              currentGroup.taskIds,
              cardWidth,
            )
          : overviewGraph(run, grouped, openGroup, selected, cardWidth),
      [run, selected, showRepairs, focusGroup, cardWidth],
    );
  useEffect(() => {
    if (!flow || !canvasRef.current || !graph.nodes.length) return;
    const viewKey = `${run.id}:${focusGroup || "overview"}`;
    const newRun = viewedRun.current !== viewKey;
    if (newRun) {
      viewedRun.current = viewKey;
      manualViewport.current = false;
    }
    if (manualViewport.current || selected) return;
    void flow.setViewport(
      nodeViewport(
        graph.nodes[0],
        canvasRef.current,
        newRun ? 1 : flow.getZoom(),
        false,
      ),
    );
  }, [flow, run.id, focusGroup, graph.width, graph.height, expanded]);
  const changeZoom = (value) => {
    if (!flow) return;
    manualViewport.current = true;
    void flow.zoomTo(Math.max(MIN_PATH_ZOOM, Math.min(MAX_PATH_ZOOM, value)), {
      duration: 150,
    });
  };
  useEffect(() => {
    if (!t?.childRunId) {
      setChild(null);
      return;
    }
    let disposed = false,
      timer;
    const load = async () => {
      try {
        const value = await request(`/api/reviews/${t.childRunId}`);
        if (!disposed) {
          setChild(value);
          timer = setTimeout(load, 2000);
        }
      } catch {
        if (!disposed) timer = setTimeout(load, 5000);
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [t?.childRunId]);
  const running = run.tasks.filter((t) => t.status === "running"),
    waiting = run.tasks.filter((t) => t.childRunId && !t.childFinal);
  const queued = run.tasks.filter((t) => t.status === "queued");
  const repairing = run.tasks.filter((t) => t.status === "recovering");
  async function control(action, body = {}) {
    setBusy(true);
    setError("");
    try {
      await request(`/api/reviews/${run.id}/${action}`, body);
      onRefresh?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const reading = readingStatus(run);
  const outcome = reviewOutcome(run);
  const heading =
    outcome.headline ||
    (run.status === "completed" && reading.failed ? "评审未完成" : null) ||
    {
      completed: reading.incomplete ? "部分评审已完成" : "评审已结束",
      awaiting_confirmation:
        run.semanticPolicy === "agent"
          ? "正在自动复核与核验"
          : "等待命题确认或核验返回",
      paused: "评审已暂停",
      blocked: "这一步遇到阻碍",
      interrupted: "上次执行已中断",
      cancelled: "本轮评审已停止",
    }[run.status] ||
    running.at(-1)?.title ||
    "正在根据论文推进评审";
  return (
    <section
      className={`adaptive-workflow ${expanded ? "expanded" : ""}`}
      aria-label="自主评审路径"
    >
      <header className="path-header">
        <h2>
          <GitBranch size={20} />
          评审进度
        </h2>
        {(run.testFixture || legacy) && (
          <span>{run.testFixture ? "演示" : "历史记录"}</span>
        )}
        <button
          aria-label={expanded ? "收起评审路径" : "展开评审路径"}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ArrowsIn size={19} /> : <ArrowsOut size={19} />}
        </button>
      </header>
      <div className="path-progress" aria-live="polite">
        <h3>{heading}</h3>
        {run.orchestrationVersion === 2 &&
          ["running", "preparing"].includes(run.status) &&
          !!(running.length + queued.length + repairing.length) && (
            <p className="path-live-counts">
              {running.length} 项执行中 · {queued.length} 项排队
              {!!repairing.length && ` · ${repairing.length} 项自动修复`}
              {!!waiting.filter(
                (t) => t.childStatus === "awaiting_confirmation",
              ).length &&
                (run.semanticPolicy === "agent"
                  ? " · 正在复核翻译"
                  : " · 部分命题待确认，独立工作继续")}
            </p>
          )}
        <p>
          {outcome.interrupted
            ? outcome.message
            : run.status === "completed"
              ? reading.failed
                ? "正文阅读未完成，请稍后重试。"
                : null
              : run.status === "paused"
                ? "已保存当前位置，继续后再决定下一步。"
                : run.pauseRequested
                  ? "已请求暂停，当前批次返回后停止安排新步骤。"
                  : run.semanticPolicy === "agent"
                    ? "正在核查当前命题及其依据，完成后自动继续。"
                    : running.at(-1)?.reason ||
                      run.waitReason ||
                      "正在准备下一步检查…"}
        </p>
      </div>
      {(error || outerError || run.error) && (
        <div className="path-error" role="alert">
          <WarningCircle size={19} />
          <div>
            <span>{reviewErrorMessage(error || outerError || run.error)}</span>
            {reviewErrorMessage(error || outerError || run.error) !==
              (error || outerError || run.error) && (
              <details>
                <summary>错误详情</summary>
                <p>{error || outerError || run.error}</p>
              </details>
            )}
          </div>
        </div>
      )}
      <div className="path-actions">
        {legacy && <button onClick={onConclusion}>查看命题与核验记录</button>}
        {!legacy && ["running", "preparing"].includes(run.status) && (
          <button
            disabled={busy || run.pauseRequested}
            onClick={() => control("pause")}
          >
            {run.pauseRequested ? "等待当前批次结束" : "暂停"}
          </button>
        )}
        {!legacy &&
          !outcome.budgetExhausted &&
          ["paused", "blocked", "interrupted"].includes(run.status) && (
            <button disabled={busy} onClick={() => control("resume")}>
              {["blocked", "interrupted"].includes(run.status)
                ? "重试受阻步骤"
                : "继续评审"}
            </button>
          )}
        {["running", "preparing", "paused", "awaiting_confirmation"].includes(
          run.status,
        ) && (
          <button disabled={busy} onClick={() => control("cancel")}>
            停止本轮
          </button>
        )}

        {!legacy && run.status === "awaiting_confirmation" && (
          <button disabled={busy} onClick={() => control("resume")}>
            继续评审
          </button>
        )}
        {run.semanticPolicy !== "agent" &&
          !!waiting.length &&
          waiting.map((v) => (
            <button
              key={v.id}
              onClick={() => {
                setSelected(v.id);
                onChild(v.childRunId);
              }}
            >
              核对形式化命题
            </button>
          ))}
        {run.status === "cancelled" && (
          <button onClick={onNew}>发起新评审</button>
        )}
      </div>
      <div className="path-branch-bar">
        {currentGroup ? (
          <>
            <button
              onClick={() => {
                setFocusGroup(null);
                setSelected(null);
              }}
            >
              <ArrowLeft size={15} />
              返回总览
            </button>
            <strong title={currentGroup.fullTitle}>
              {currentGroup.fullTitle}
            </strong>
          </>
        ) : (
          <>
            <strong>评审总览</strong>
          </>
        )}
      </div>
      <div className="path-navigation">
        {currentGroup &&
          currentGroup.taskIds.some((id) =>
            ["diagnose", "diagnose_child"].includes(
              run.tasks.find((t) => t.id === id)?.kind,
            ),
          ) && (
            <button
              aria-expanded={showRepairs}
              onClick={() => setShowRepairs(!showRepairs)}
            >
              {showRepairs ? "收起修复分支" : "展开修复分支"}
            </button>
          )}
      </div>
      <div className="path-view-tools" role="group" aria-label="流程图视图控制">
        <button
          aria-label="缩小流程图"
          title="缩小流程图"
          disabled={!flow || zoom <= MIN_PATH_ZOOM + 0.001}
          onClick={() => changeZoom(flow.getZoom() / 1.25)}
        >
          <Minus size={17} />
        </button>
        <button
          className="path-zoom-value"
          aria-label={`流程图缩放 ${Math.round(zoom * 100)}%，点击恢复 100%`}
          title="恢复 100%"
          disabled={!flow}
          onClick={() => changeZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          aria-label="放大流程图"
          title="放大流程图"
          disabled={!flow || zoom >= MAX_PATH_ZOOM - 0.001}
          onClick={() => changeZoom(flow.getZoom() * 1.25)}
        >
          <Plus size={17} />
        </button>
        <button
          aria-label="显示完整流程图"
          title="显示完整流程图"
          disabled={!flow || !graph.nodes.length}
          onClick={() => {
            manualViewport.current = true;
            void flow.fitView({
              padding: 0.15,
              minZoom: MIN_PATH_ZOOM,
              maxZoom: 1,
              duration: 200,
            });
          }}
        >
          <CornersOut size={17} />
          <span>全图</span>
        </button>
      </div>
      <div
        className="path-scroll"
        style={
          expanded
            ? undefined
            : { height: Math.max(270, Math.min(530, graph.height + 52)) }
        }
      >
        <div
          className="path-canvas"
          ref={canvasRef}
          aria-label="已发生与已安排的评审步骤"
        >
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            onInit={setFlow}
            onNodeClick={(_, n) =>
              n.data.group ? openGroup(n.id) : selectTask(n.id)
            }
            minZoom={MIN_PATH_ZOOM}
            maxZoom={MAX_PATH_ZOOM}
            onMove={(_, viewport) => setZoom(viewport.zoom)}
            onMoveStart={(event) => {
              if (event) manualViewport.current = true;
            }}
            edgesFocusable={false}
            nodesConnectable={false}
            nodesDraggable={false}
            elementsSelectable
            panOnScroll={false}
            panOnDrag
            zoomOnScroll
            zoomOnDoubleClick={false}
            zoomOnPinch
            preventScrolling
          ></ReactFlow>
        </div>
      </div>
      {outcome.hasReport && (
        <div className="path-completion">
          <button className="button primary" onClick={onReveal}>
            {outcome.interrupted
              ? "查看已保存的部分结果"
              : reading.failed
                ? "查看失败详情"
                : revealed
                  ? "返回评审结果"
                  : "确定，查看结果"}
          </button>
          <button className="button outline" onClick={onNew}>
            重新评审
          </button>
        </div>
      )}
      {t ? (
        <aside className="path-detail" aria-label="步骤详情" ref={detailRef}>
          <div className="path-detail-label">
            <span>步骤详情</span>
            <button aria-label="关闭步骤详情" onClick={() => setSelected(null)}>
              <X size={18} />
            </button>
          </div>
          <h3>{t.title}</h3>
          <dl>
            <dt>目的</dt>
            <dd>{t.reason || "读取论文原文。"}</dd>
            <dt>执行者</dt>
            <dd>{t.agent || t.role}</dd>
            <dt>当前结果</dt>
            <dd>
              {reviewErrorMessage(t.error) ||
                t.summary ||
                (run.semanticPolicy === "agent" &&
                t.status === "awaiting_confirmation"
                  ? "正在复核"
                  : ACTION_STATES[t.status]) ||
                "等待结果"}
            </dd>
            {run.orchestrationVersion === 2 && (
              <>
                {(t.kind === "environment_probe" || t.childRunId) && (
                  <>
                    <dt>核验方式</dt>
                    <dd>
                      {t.kind === "environment_probe"
                        ? "数学库导入与声明探测，不是论文命题证明"
                        : t.childRunId
                          ? child?.check?.status === "verified"
                            ? "Lean 已检查该固定目标；原证明单独评估"
                            : child?.check &&
                                ("exitCode" in child.check ||
                                  child.check.parser)
                              ? "Lean 已执行，查看实际检查结果"
                              : "Lean 命题证明尚未执行"
                          : "本步骤未执行 Lean 命题证明"}
                    </dd>
                  </>
                )}
                {["running", "queued", "recovering"].includes(t.status) && (
                  <>
                    <dt>执行状态</dt>
                    <dd>
                      {ACTION_STATES[t.status]} · 已用{" "}
                      {Math.max(
                        0,
                        Math.floor(
                          (clock -
                            Date.parse(
                              t.attempts?.at(-1)?.startedAt ||
                                t.startedAt ||
                                t.createdAt,
                            )) /
                            1000,
                        ),
                      )}{" "}
                      秒
                      {t.lastActivityAt &&
                        `；最近活动 ${new Date(t.lastActivityAt).toLocaleTimeString("zh-CN")}`}
                    </dd>
                  </>
                )}
              </>
            )}
          </dl>
          {!!t.goalPreview?.length && (
            <details className="path-record">
              <summary>当前证明目标</summary>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {t.goalPreview.join("\n\n")}
              </pre>
            </details>
          )}
          {!!t.anchors?.length && (
            <div className="path-sources">
              {t.anchors.map((a, i) => (
                <button
                  key={i}
                  onClick={() =>
                    a.referenceArtifact
                      ? onTask({
                          output: a.referenceArtifact,
                          title: "外部文献与取得记录",
                        })
                      : onLocate(a.pageIndex, a.quote)
                  }
                >
                  <FileText size={16} />
                  {a.referenceId ? "外部文献 · " : ""}第 {a.pageIndex + 1} 页 ·{" "}
                  {a.quote.slice(0, 48)}
                  {a.quote.length > 48 ? "…" : ""}
                  <ArrowSquareOut size={14} />
                </button>
              ))}
            </div>
          )}
          {t.childRunId && (
            <div className="path-child">
              <button
                className="button outline"
                onClick={() => onChild(t.childRunId)}
              >
                查看命题核验
              </button>
              <OriginalProofDetails
                route={child?.originalProofRoute}
                onEvidence={onTask}
                tasks={child?.tasks}
                onLocate={onLocate}
              />
              {child?.tasks
                ?.filter((step) => !step.role.startsWith("R06_"))
                .map((step) => (
                  <button
                    key={step.id}
                    className="path-child-step"
                    onClick={() =>
                      step.output ? onTask(step) : onChild(t.childRunId)
                    }
                  >
                    {step.title}
                    <span>{ACTION_STATES[step.status] || step.status}</span>
                  </button>
                ))}
              {run.semanticPolicy !== "agent" &&
                !t.childFinal &&
                child?.status === "awaiting_confirmation" && (
                  <button
                    disabled={busy}
                    onClick={() => control("skip-child", { taskId: t.id })}
                  >
                    跳过这次形式化，保留未解决项
                  </button>
                )}
            </div>
          )}
          <details className="path-record">
            <summary>依据与来源</summary>
            {t.parents?.map((id) => {
              const p = run.tasks.find((v) => v.id === id);
              return (
                p && (
                  <button key={id} onClick={() => selectTask(id)}>
                    前置：{p.title}
                  </button>
                )
              );
            })}
            {t.output && (
              <button onClick={() => onTask(t)}>
                查看本步依据 <ArrowSquareOut size={14} />
              </button>
            )}
            {t.childArtifact && (
              <button
                onClick={() =>
                  onTask({ output: t.childArtifact, title: "命题核验结果" })
                }
              >
                查看形式化核验依据
              </button>
            )}
            {run.tasks
              .filter((d) => d.recoveryFor === t.id)
              .map((d) => (
                <button key={d.id} onClick={() => selectTask(d.id)}>
                  诊断与修复：{d.summary || d.title}
                </button>
              ))}
          </details>
        </aside>
      ) : null}
      <details className="path-history">
        <summary>历史评审</summary>
        <select
          aria-label="工作流评审记录"
          value={run.id}
          onChange={(e) => onSelectRun(e.target.value)}
        >
          {runs.map((v) => (
            <option key={v.id} value={v.id}>
              {v.engine === "original-proof-v1"
                ? "原证明核验"
                : isAdaptive(v)
                  ? "自主评审"
                  : "单条命题"}{" "}
              · {new Date(v.createdAt).toLocaleString("zh-CN")}
            </option>
          ))}
        </select>
        {run.root && (
          <a href={`/api/reviews/${run.id}/bundle?format=ndjson`} download>
            导出本轮证据包
          </a>
        )}
      </details>
    </section>
  );
}
