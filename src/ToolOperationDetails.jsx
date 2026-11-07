import { useEffect, useState, useRef } from "react";
import { request } from "./api.js";
import { timingBreakdown } from "../shared/timing-metrics.mjs";
import { ToolCallCard } from "./components/affect-ui/tool-call-card.tsx";
import { SegmentedControl } from "./components/affect-ui/segmented-control.tsx";
import { toolCallView } from "./tool-call-view.js";
import "./tool-operation-details.css";
const labels = {
  "environment.verify": "执行前内容核验",
  "environment.verify_after_use": "使用后内容复验",
  "environment.content_hash": "内容读取与哈希",
  "environment.reservation": "环境借用",
  "environment.generation_queue": "环境构建排队与处理",
  "environment.generation_build": "隔离环境构建",
  "environment.generation_clone": "环境复制",
  "native.kernel": "内核检查",
};

function OperationCard({ op, runStatus }) {
  const [open, setOpen] = useState(false);
  const view = toolCallView(op, runStatus);
  return (
    <ToolCallCard
      name={op.name}
      summary={view.summary}
      status={view.status}
      statusLabel={view.statusLabel}
      startedAt={view.startedAt}
      duration={view.duration}
      open={open}
      onOpenChange={setOpen}
      error={
        op.error
          ? `${op.error.code || "tool_failure"}：${op.error.message || "工具未提供错误说明。"}`
          : undefined
      }
      result={open && op.resultSummary != null ? op.resultSummary : undefined}
    >
      <dl className="operation-identity">
        <dt>操作引用</dt>
        <dd>
          <code>{op.refs?.id || op.id}</code>
        </dd>
        <dt>完整 ID</dt>
        <dd>
          <code>{op.id}</code>
        </dd>
      </dl>
      {op.error?.fieldErrors?.map((e, i) => (
        <p className="operation-field-error" key={i}>
          {e.field}：{e.message}
        </p>
      ))}
      {op.error?.navigation?.guidance && <p>{op.error.navigation.guidance}</p>}
      {op.nativeTimings?.length > 0 && (
        <section className="operation-timings" aria-label="原生阶段耗时">
          <h4>阶段记录</h4>
          <p>包含子步骤与自身耗时分别列出；重叠时间不能相加为总耗时。</p>
          <ul>
            {timingBreakdown(op.nativeTimings).map((s) => (
              <li key={s.id}>
                <strong>{labels[s.name] || s.name}</strong>
                <span>
                  含子步骤 {(s.elapsedMs / 1000).toFixed(2)} 秒 · 自身{" "}
                  {(s.exclusiveMs / 1000).toFixed(2)} 秒
                </span>
                {s.attributes?.bytes ? (
                  <span>
                    读取 {s.attributes.bytes} 字节 / {s.attributes.files} 文件
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="operation-sources">
        {op.inputArtifact && (
          <a
            href={`/api/artifacts/${op.inputArtifact}`}
            target="_blank"
            rel="noreferrer"
          >
            原始调用参数
          </a>
        )}
        {op.artifactId ? (
          <a
            href={`/api/artifacts/${op.artifactId}`}
            target="_blank"
            rel="noreferrer"
          >
            原始操作与证据
          </a>
        ) : (
          <p>未列出独立结果制品；请按操作 ID 查阅完整记录。</p>
        )}
      </div>
    </ToolCallCard>
  );
}

export function OperationDetails({ run, task }) {
  const [page, setPage] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [opened, setOpened] = useState(false),
    [filter, setFilter] = useState("all");
  const pending = useRef(null),
    identity = useRef(`${run.id}/${task.id}`);
  identity.current = `${run.id}/${task.id}`;
  useEffect(() => {
    pending.current?.abort();
    setPage(null);
    setError("");
    setOpened(false);
    setLoading(false);
    setFilter("all");
    return () => pending.current?.abort();
  }, [run.id, task.id]);
  const load = async (before = null) => {
    pending.current?.abort();
    const control = new AbortController(),
      key = identity.current;
    pending.current = control;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ actor: task.id, limit: "25" });
      if (before !== null) {
        params.set("before", String(before));
        params.set("bound", String(page.bound));
      }
      const next = await request(
        `/api/reviews/${run.id}/operations?${params}`,
        undefined,
        control.signal,
      );
      if (key === identity.current && !control.signal.aborted) {
        setPage(next);
        setOpened(true);
      }
    } catch (e) {
      if (!control.signal.aborted && key === identity.current)
        setError(e.message);
    } finally {
      if (pending.current === control) setLoading(false);
    }
  };
  const operations = opened
    ? page?.items || []
    : (run.operations || []).filter((o) => o.actorId === task.id).slice(-8);
  const visible =
    filter === "all"
      ? operations
      : operations.filter(
          (o) => toolCallView(o, run.status).category === filter,
        );
  return (
    <section className="lemma-operation-log" aria-label="工具调用详情">
      <div className="operation-log-heading">
        <h4>工具记录</h4>
        <span>
          {opened ? "当前历史页" : "最近记录"} · {operations.length} 条
        </span>
      </div>
      <SegmentedControl
        aria-label="筛选当前工具记录"
        value={filter}
        onChange={setFilter}
        variant="underline"
        size="sm"
        options={[
          { value: "all", label: "全部" },
          { value: "unfinished", label: "未完成" },
          { value: "issues", label: "异常或取消" },
          { value: "returned", label: "已返回" },
        ]}
      />
      <p className="operation-filter-scope">
        筛选仅作用于此处记录；工具返回与数学目标完成分别记录。
      </p>
      <div className="operation-history-actions">
        <button
          className="button secondary"
          disabled={loading}
          onClick={() => load()}
        >
          查看完整操作历史
        </button>
        {opened && page.nextBefore !== null && (
          <button
            className="button secondary"
            disabled={loading}
            onClick={() => load(page.nextBefore)}
          >
            更早的操作
          </button>
        )}
      </div>
      {loading && <p role="status">正在读取操作记录…</p>}
      {opened && (
        <p className="operation-filter-scope">
          当前显示 {operations.length} 条；历史边界 {page.bound}，状态截至版本{" "}
          {page.revision}。新操作不挤动当前分页。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="operation-cards">
        {visible.map((op) => (
          <OperationCard
            key={`${run.id}/${task.id}/${op.id}`}
            op={op}
            runStatus={run.status}
          />
        ))}
      </div>
      {!visible.length && (
        <p className="operation-empty" role="status">
          {operations.length
            ? "此处没有符合筛选条件的操作。"
            : "此处尚无工具记录。"}
        </p>
      )}
    </section>
  );
}
