import { TeamTaskCard } from "./TeamTaskCard.jsx";
import { SegmentedControl } from "./components/affect-ui/segmented-control.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  Handle,
  Position,
  useNodesInitialized,
  useReactFlow,
  useOnViewportChange,
  useStore,
} from "@xyflow/react";
import dagre from "dagre";
import { request } from "./api.js";
import { selectTeamCertificate } from "../shared/team-evidence.mjs";
import "@xyflow/react/dist/style.css";
import "./team-workflow.css";
const roles = {
  main: "主线 Agent",
  task: "任务 Agent",
  acceptance: "验收 Agent",
};
const states = {
  queued: "等待资源",
  running: "进行中",
  waiting: "等待协作",
  submitted: "正在验收",
  completed: "任务已交付",
  unresolved: "未能确认",
  failed: "执行异常",
  cancelled: "已停止",
  pausing: "正在暂停",
  paused: "已暂停",
  resuming: "正在恢复",
};
function ObjectiveDetails({ goals = [], run, onLocate }) {
  const [filter, setFilter] = useState("all");
  const visibleGoals = goals.filter(
    (g) => filter === "all" || (filter === "done" ? g.resolved : !g.resolved),
  );
  return goals.length ? (
    <div className="team-objectives">
      {goals.length > 1 && (
        <SegmentedControl
          aria-label="筛选核查目标"
          value={filter}
          onChange={setFilter}
          variant="underline"
          size="sm"
          options={[
            { value: "all", label: "全部" },
            { value: "open", label: "待完成" },
            { value: "done", label: "已完成" },
          ]}
        />
      )}
      {!visibleGoals.length && <p>暂无符合条件的目标。</p>}
      {visibleGoals.map((g) => (
        <details key={g.id}>
          <summary>
            {g.title}
            <small>
              {g.resolved
                ? g.status === "refuted"
                  ? "已证伪"
                  : "已完成"
                : ["proved", "covered"].includes(g.status)
                  ? "前提尚未完成"
                  : "待完成"}
            </small>
          </summary>
          <p>{g.description}</p>
          {g.assessment && <p>{g.assessment.explanation}</p>}
          {g.dependencies.length > 0 && (
            <p>
              依赖：
              {g.dependencies
                .map(
                  (id) => run.objectives.find((x) => x.id === id)?.title || id,
                )
                .join("、")}
            </p>
          )}
          {g.sourceSpans.slice(0, 1).map((s, i) => (
            <button
              className="source-locate"
              key={i}
              onClick={() => onLocate?.(s.pageIndex, s.quote)}
            >
              查看原文
            </button>
          ))}
          {g.targetId && <CheckLinks run={run} targetId={g.targetId} />}
        </details>
      ))}
    </div>
  ) : null;
}
function TeamNode({ data }) {
  return (
    <button
      className={`team-node ${data.task.status}`}
      onClick={() => data.select(data.task.id)}
    >
      <Handle type="target" position={Position.Top} />
      <small>
        {roles[data.task.role]} · {states[data.task.status]}
      </small>
      <strong>{data.task.title}</strong>
      <Handle type="source" position={Position.Bottom} />
    </button>
  );
}
const types = { team: TeamNode };
const readableError = (message) =>
  /Selected model is at capacity/.test(message || "")
    ? "模型服务当前容量已满，本轮已停止；已收到的结果仍然保留。"
    : message === "Cancelled"
      ? "本轮中断后，该任务已停止。"
      : message;
function TeamViewport({ signature, userMoved, selected }) {
  const ready = useNodesInitialized();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const flow = useReactFlow();
  const [zoom, setZoom] = useState(1);
  useOnViewportChange({ onChange: (v) => setZoom(v.zoom) });
  useEffect(() => {
    if (ready && selected) {
      userMoved.current = true;
      void flow.fitView({
        nodes: [{ id: selected }],
        padding: 0.2,
        maxZoom: 1,
      });
    }
  }, [ready, selected, flow, userMoved]);
  useEffect(() => {
    if (ready && !userMoved.current)
      void flow.fitView({ padding: 0.15, maxZoom: 1 });
  }, [ready, signature, width, height, flow, userMoved]);
  return (
    <div className="team-zoom">
      <button
        onClick={() => {
          userMoved.current = true;
          void flow.zoomTo(1);
        }}
        title="恢复 100%"
      >
        {Math.round(zoom * 100)}%
      </button>
    </div>
  );
}
function CheckLinks({ run, targetId }) {
  const check = selectTeamCertificate(run, targetId);
  if (!check) return null;
  return (
    <p className="team-check">
      <a
        href={`/api/artifacts/${check.artifactId}`}
        target="_blank"
        rel="noreferrer"
      >
        {check.status === "verified"
          ? check.mode === "counterexample"
            ? "Lean：该命题的否定已通过"
            : "Lean：该精确命题已通过"
          : "查看 Lean 检查结果"}
      </a>
      <small>
        {check.independentlyAccepted ? "已完成独立验收" : "尚未完成独立验收"}
      </small>
    </p>
  );
}
export function TeamWorkflow({
  run,
  onRevealResults,
  onReveal,
  onEvidence,
  onLocate,
  ...props
}) {
  const [selected, setSelected] = useState(null),
    [error, setError] = useState(""),
    [actionPending, setActionPending] = useState(false),
    [expanded, setExpanded] = useState(false);
  const act = async (name, body = {}) => {
    if (actionPending) return;
    setActionPending(true);
    setError("");
    try {
      await request(`/api/reviews/${run.id}/${name}`, body);
    } catch (e) {
      setError(e.message);
    } finally {
      setActionPending(false);
    }
  };
  const [taskHistory, setTaskHistory] = useState(null),
    [taskLoading, setTaskLoading] = useState(false);
  const taskRequest = useRef(0);
  useEffect(() => {
    taskRequest.current++;
    setTaskHistory(null);
    setTaskLoading(false);
  }, [run.id]);
  const taskPage = taskHistory || { ...run.taskPage, items: run.tasks };
  const visibleTasks = taskPage.items;
  const earlierTasks = async () => {
    const requestId = ++taskRequest.current;
    setTaskLoading(true);
    setError("");
    try {
      const page = await request(
        `/api/reviews/${run.id}/tasks?bound=${taskPage.bound}&before=${taskPage.nextBefore}&limit=60`,
      );
      if (requestId === taskRequest.current) {
        setTaskHistory(page);
        setSelected(null);
        userMoved.current = false;
      }
    } catch (e) {
      if (requestId === taskRequest.current) setError(e.message);
    } finally {
      if (requestId === taskRequest.current) setTaskLoading(false);
    }
  };
  const userMoved = useRef(false);
  const [dimensions, setDimensions] = useState({});
  useEffect(() => {
    userMoved.current = false;
    setSelected(null);
    setDimensions({});
  }, [run.id]);
  const graph = useMemo(() => {
    const latest = new Map();
    for (const t of visibleTasks)
      if (t.role === "acceptance") latest.set(t.parentId, t.id);
    const tasks = visibleTasks.filter(
      (t) => t.role !== "acceptance" || latest.get(t.parentId) === t.id,
    );
    const ids = new Set(tasks.map((t) => t.id));
    const g = new dagre.graphlib.Graph()
      .setGraph({ rankdir: "TB", nodesep: 28, ranksep: 45 })
      .setDefaultEdgeLabel(() => ({}));
    for (const t of tasks)
      g.setNode(t.id, dimensions[t.id] || { width: 235, height: 85 });
    const edges = [];
    for (const t of tasks)
      for (const p of new Set(
        [t.parentId, ...t.dependsOn].filter((p) => p && ids.has(p)),
      )) {
        g.setEdge(p, t.id);
        edges.push({
          id: `${p}-${t.id}`,
          source: p,
          target: t.id,
          animated: t.status === "running",
        });
      }
    dagre.layout(g);
    return {
      nodes: tasks.map((t) => ({
        id: t.id,
        type: "team",
        position: {
          x: g.node(t.id).x - g.node(t.id).width / 2,
          y: g.node(t.id).y - g.node(t.id).height / 2,
        },
        measured: dimensions[t.id],
        data: { task: t, select: setSelected },
      })),
      edges,
    };
  }, [visibleTasks, dimensions]);
  const task = visibleTasks.find((t) => t.id === selected);
  const ready =
    !!run.root && !["running", "pausing", "resuming"].includes(run.status);
  const reveal = onRevealResults || onReveal || props.onShowResults;
  return (
    <section
      className={`team-workflow${expanded ? " expanded" : ""}`}
      aria-label="协作评审"
      onKeyDown={(e) => {
        if (e.key === "Escape") setExpanded(false);
      }}
    >
      <div className="team-heading">
        <strong>
          {run.status === "running"
            ? run.progressReports?.some((p) => p.acceptanceArtifact)
              ? "已有阶段成果，正在继续核查"
              : "团队正在核查"
            : run.status === "pausing"
              ? "正在暂停"
              : run.status === "paused"
                ? "评审已暂停"
                : run.status === "resuming"
                  ? "正在接续"
                  : run.status === "cancelled"
                    ? "评审已停止"
                    : "本轮评审已结束"}
        </strong>
        <button
          className="team-expand"
          onClick={() => {
            userMoved.current = false;
            setExpanded(!expanded);
          }}
        >
          {expanded ? "收起流程图" : "展开流程图"}
        </button>
      </div>
      {run.pause?.error && <p role="alert">暂停尚未完成：{run.pause.error}</p>}
      {run.objectives?.length > 0 && (
        <details className="team-goal-overview">
          <summary>核查目标</summary>
          <ObjectiveDetails
            run={run}
            onLocate={onLocate}
            goals={run.objectives}
          />
        </details>
      )}
      {(taskPage.total || run.tasks.length) > 60 && (
        <div className="team-task-pages">
          {taskPage.nextBefore !== null && (
            <button disabled={taskLoading} onClick={earlierTasks}>
              更早的任务
            </button>
          )}
          {taskHistory && (
            <button
              onClick={() => {
                taskRequest.current++;
                setTaskHistory(null);
                setSelected(null);
                userMoved.current = false;
              }}
            >
              最新任务
            </button>
          )}
        </div>
      )}
      <select
        aria-label="选择任务查看详情"
        className="team-task-picker"
        value={selected || ""}
        onChange={(event) => setSelected(event.target.value || null)}
      >
        <option value="">选择任务查看详情</option>
        {graph.nodes.map(({ data: { task: t } }) => (
          <option key={t.id} value={t.id}>
            {roles[t.role]} · {t.title} · {states[t.status]}
          </option>
        ))}
      </select>
      <div
        className="team-graph"
        onWheelCapture={() => {
          userMoved.current = true;
        }}
        onPointerDownCapture={(event) => {
          if (event.target.classList.contains("react-flow__pane"))
            userMoved.current = true;
        }}
      >
        <ReactFlow
          key={run.id}
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={types}
          onlyRenderVisibleElements
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          onNodesChange={(changes) =>
            setDimensions((previous) => {
              let next = previous;
              for (const c of changes)
                if (
                  c.type === "dimensions" &&
                  c.dimensions &&
                  (previous[c.id]?.width !== c.dimensions.width ||
                    previous[c.id]?.height !== c.dimensions.height)
                ) {
                  if (next === previous) next = { ...previous };
                  next[c.id] = c.dimensions;
                }
              return next;
            })
          }
          minZoom={0.08}
          maxZoom={2.5}
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_, n) => setSelected(n.id)}
        >
          <Background />
          <div
            onPointerDownCapture={() => {
              userMoved.current = true;
            }}
          >
            <Controls showInteractive={false} />
          </div>
          <TeamViewport
            selected={selected}
            signature={`${graph.nodes.map((n) => `${n.id}:${n.position.x}:${n.position.y}:${n.measured?.height}`).join()}:${expanded}`}
            userMoved={userMoved}
          />
        </ReactFlow>
      </div>
      {task && (
        <section className="team-detail" aria-label="任务详情">
          <button
            className="team-close"
            onClick={() => setSelected(null)}
            aria-label="关闭任务详情"
          >
            ×
          </button>
          <TeamTaskCard
            task={task}
            runStatus={run.status}
            roleLabel={roles[task.role]}
            statusLabel={states[task.status]}
          />
          {task.dependsOn?.length > 0 && (
            <p>
              依赖任务：
              {task.dependsOn
                .map(
                  (id) =>
                    run.tasks.find((item) => item.id === id)?.title ||
                    "更早的任务",
                )
                .join("、")}
            </p>
          )}
          {(run.proofReuses || [])
            .filter((r) => r.actorId === task.id)
            .map((r) => (
              <p key={r.artifactId}>
                <a
                  href={`/api/artifacts/${r.artifactId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看依据
                </a>
              </p>
            ))}
          {run.proofIndexStatus && run.proofIndexStatus !== "ready" && (
            <p role="status">
              {run.proofIndexStatus === "building"
                ? "正在读取依据…"
                : "暂时无法读取依据。"}
            </p>
          )}
          <ObjectiveDetails
            run={run}
            onLocate={onLocate}
            goals={run.objectives?.filter(
              (g) => task.objectiveIds?.includes(g.id) || g.ownerId === task.id,
            )}
          />
          {run.submissions
            .filter((s) => s.taskId === task.id || s.id === task.submissionId)
            .slice(-1)
            .map((s) => (
              <div key={s.id}>
                {s.limitations.map((l, i) => (
                  <p key={i}>{l}</p>
                ))}
                <a
                  href={`/api/artifacts/${s.artifact}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看提交依据
                </a>
                {s.acceptanceArtifact && (
                  <a
                    href={`/api/artifacts/${s.acceptanceArtifact}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看验收依据
                  </a>
                )}
              </div>
            ))}
          {run.targets
            .filter((t) => t.taskId === task.id)
            .map((t) => (
              <div key={t.id}>
                <button
                  className="source-locate"
                  onClick={() =>
                    onLocate?.(t.contract.pageIndex, t.contract.quote)
                  }
                >
                  定位原文：{t.label}
                </button>
                <CheckLinks run={run} targetId={t.id} />
              </div>
            ))}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="team-actions">
        {!run.readOnly && run.status === "running" && (
          <button
            className="button secondary"
            disabled={actionPending}
            onClick={() => act("pause")}
          >
            暂停评审
          </button>
        )}
        {run.status === "pausing" && (
          <p role="status">正在停止执行并保存检查点，尚未全部归零。</p>
        )}
        {!run.readOnly && run.status === "paused" && (
          <button
            className="button secondary"
            disabled={actionPending}
            onClick={() => act("resume", { expectedRoot: run.root })}
          >
            从检查点继续
          </button>
        )}
        {ready && (
          <button className="button primary" onClick={reveal}>
            查看评审结果
          </button>
        )}
      </div>
    </section>
  );
}
export function TeamSummary({ run, onDetails, onLocate }) {
  const submitted = run.submissions.filter(
    (s) => s.status !== "pending" && !s.final && !s.superseded,
  );
  return (
    <section className="result-summary">
      <h2>{run.conclusion?.headline || "部分评审结果"}</h2>
      <p>
        {readableError(run.conclusion?.summary) || "本轮尚未形成最终汇总。"}
      </p>
      {run.proofIndexStatus && run.proofIndexStatus !== "ready" && (
        <p role="status">
          {run.proofIndexStatus === "building"
            ? "正在加载核验依据，已显示的结果可能尚不完整。"
            : "暂时无法读取依据。"}
        </p>
      )}
      {run.targets
        .filter(
          (t) =>
            !t.supersededBy &&
            !submitted.some((s) => s.targetIds.includes(t.id)) &&
            run.machineChecks?.some(
              (c) => c.targetId === t.id && c.status === "verified",
            ),
        )
        .map((t) => (
          <section key={t.id}>
            <h3>{t.label}</h3>
            <p>{t.contract.statement}</p>
            <CheckLinks run={run} targetId={t.id} />
            <button
              className="source-locate"
              onClick={() => onLocate?.(t.contract.pageIndex, t.contract.quote)}
            >
              查看原文
            </button>
          </section>
        ))}
      {submitted.map((s) => (
        <section key={s.id}>
          <h3>{run.tasks.find((t) => t.id === s.taskId)?.title}</h3>
          <p>{s.summary}</p>
          <p>
            {s.status === "pass"
              ? "独立验收通过"
              : s.status === "rework"
                ? "需要返工"
                : "尚未确认"}
            {["theorem", "lemma"].includes(s.resultKind) && s.status === "pass"
              ? " · 精确形式命题通过 Lean"
              : s.resultKind === "counterexample" && s.status === "pass"
                ? " · 精确形式命题的否定通过 Lean"
                : s.resultKind === "author_route" && s.status === "pass"
                  ? " · 路线对应关系为 Agent 复核意见"
                  : ""}
          </p>
          {s.targetIds.map((id) => {
            const t = run.targets.find((t) => t.id === id);
            return (
              t && (
                <button
                  key={id}
                  className="source-locate"
                  onClick={() =>
                    onLocate?.(t.contract.pageIndex, t.contract.quote)
                  }
                >
                  查看原文：{t.label}
                </button>
              )
            );
          })}
          <a
            href={`/api/artifacts/${s.acceptanceArtifact || s.artifact}`}
            target="_blank"
            rel="noreferrer"
          >
            查看依据
          </a>
        </section>
      ))}
      <details>
        <summary>覆盖范围与未完成内容</summary>
        <ObjectiveDetails
          run={run}
          onLocate={onLocate}
          goals={run.objectives}
        />
        {run.stopDecision && (
          <p>停止原因：{run.stopDecision.independentExplanation}</p>
        )}
        {run.conclusion?.limitations?.map((s, i) => (
          <p key={i}>{s}</p>
        ))}
      </details>
      <button className="button secondary" onClick={onDetails}>
        回看协作路径
      </button>
      <a className="source-locate" href={`/api/reviews/${run.id}/bundle`}>
        导出本轮证据
      </a>
    </section>
  );
}
