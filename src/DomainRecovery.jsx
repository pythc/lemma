import { useState } from "react";

const stages = {
  search: "寻找现有知识",
  library: "补充数学库模块",
  definitions: "形式化与复核新定义",
  lemmas: "逐项证明辅助引理",
  translation: "重新复核原命题",
  awaiting_fresh_confirmation: "等待重新确认",
  blocked: "补全受阻",
  cancelled: "已取消",
};
const artifact = (id, label) =>
  id && (
    <a
      href={`/api/artifacts/${id}?view=summary`}
      target="_blank"
      rel="noreferrer"
    >
      {label} ↗
    </a>
  );
export function DomainRecovery({
  run,
  busy,
  modelConfigured,
  onStart,
  onLocate,
}) {
  const [manual, setManual] = useState(false),
    [plan, setPlan] = useState(""),
    [queries, setQueries] = useState("");
  const r = run.domainRecovery;
  const confirmed =
    !!run.approval &&
    run.approval.targetHash === run.contract?.targetHash &&
    run.approval.semanticArtifact === run.semanticArtifact;
  const inactive = !["preparing", "running"].includes(run.status);
  const eligible = inactive && !!run.sourceArtifact && !!run.contextArtifact;
  return (
    <section className="capability-section domain-recovery">
      <h4>补全领域知识</h4>
      <p className="muted">
        检索数学库 → 补充定义 → 核验辅助引理 →
        重新复核原命题。每次补全建立新版本，需重新确认翻译。
      </p>
      {r && (
        <>
          <p role="status">
            <strong>
              {r.stage === "awaiting_fresh_confirmation" && confirmed
                ? "已重新确认，补全内容已进入证明环境"
                : stages[r.stage] || r.stage}
            </strong>{" "}
            · 模型调用 {r.modelCalls}/{r.limits.modelCalls}
          </p>
          {r.search && (
            <details>
              <summary>
                库检索 · {r.search.matches.length} 条线索
                {r.search.truncated ? "（已截断）" : ""}
              </summary>
              <p>{r.search.note}</p>
              {r.search.matches.map((m) => (
                <div key={`${m.file}:${m.line}`} className="domain-match">
                  <a href={m.url} target="_blank" rel="noreferrer">
                    {m.module}:{m.line}
                  </a>
                  <small>
                    {m.installed ? "检索时缓存已存在" : "检索时需要补充缓存"}
                  </small>
                  <pre>{m.snippet}</pre>
                </div>
              ))}
              {artifact(r.searchArtifact, "检索版本与源码摘要")}
            </details>
          )}
          {r.library && (
            <p>
              模块准备：{r.library.status === "ready" ? "已就绪" : "未完成"} ·{" "}
              {r.library.modules.length} 个模块{" "}
              {artifact(r.libraryArtifact, "获取与版本记录")}
            </p>
          )}
          {r.components.map((c) => (
            <details key={c.name} open={c.status === "blocked"}>
              <summary>
                {c.kind === "definition" ? "定义" : "辅助引理"} {c.name} ·{" "}
                {c.status === "verified"
                  ? c.kind === "definition"
                    ? confirmed
                      ? "类型已检查，已记录语义确认"
                      : "类型已检查，语义待确认"
                    : "Lean 已核验"
                  : c.status === "blocked"
                    ? "受阻"
                    : c.status === "cancelled"
                      ? "已取消"
                      : "检查中"}
              </summary>
              <p>依赖：{c.dependsOn.join("、") || "仅声明的数学库"}</p>
              {c.component && (
                <pre>
                  {c.kind === "definition"
                    ? `${c.component.type}\n:= ${c.component.value}`
                    : `${c.component.target}\n:= ${c.component.proof}`}
                </pre>
              )}
              {c.component?.meaning && <p>对应含义：{c.component.meaning}</p>}
              {c.component?.anchors?.map((a, i) =>
                a.pageIndex !== undefined ? (
                  <button
                    key={i}
                    type="button"
                    className="source-locate"
                    onClick={() => onLocate(a.pageIndex, a.quote)}
                  >
                    第 {a.pageIndex + 1} 页 · {a.quote}
                  </button>
                ) : (
                  <p key={i}>补充材料：{a.quote}</p>
                ),
              )}
              {c.fidelity && (
                <p>
                  定义复核：{c.fidelity.explanation}{" "}
                  {artifact(c.fidelityArtifact, "复核依据")}
                </p>
              )}
              {c.attempts.map((a) => (
                <div key={a.number}>
                  <p>
                    第 {a.number} 次 · {a.status}{" "}
                    {artifact(a.checkArtifact, "Lean 检查产物")}
                  </p>
                  {a.diagnostic?.message &&
                    a.status !== "verified" &&
                    a.status !== "well_typed" && (
                      <pre>{a.diagnostic.message}</pre>
                    )}
                </div>
              ))}
            </details>
          ))}
          {artifact(r.completionArtifact, "查看补全证据与依赖图")}
        </>
      )}
      {eligible && (
        <>
          <label>
            英文检索词（可选，每行一个）
            <textarea
              aria-label="领域检索词"
              rows={2}
              maxLength={800}
              value={queries}
              onChange={(e) => setQueries(e.target.value)}
              placeholder="如 ConvexOn、absolute continuity"
            />
          </label>
          <button
            type="button"
            className="button outline full"
            disabled={!!busy || !modelConfigured}
            onClick={() =>
              onStart({
                mode: "model",
                ...(queries.trim()
                  ? {
                      queries: queries
                        .split("\n")
                        .map((q) => q.trim())
                        .filter(Boolean),
                    }
                  : {}),
              })
            }
          >
            自动补全并重新复核
          </button>
          <button
            type="button"
            className="advanced-entry"
            disabled={!!busy}
            onClick={() => {
              if (!manual)
                setPlan(
                  JSON.stringify(
                    r?.plan || {
                      queries: [],
                      modules: [],
                      definitions: [],
                      lemmas: [],
                    },
                    null,
                    2,
                  ),
                );
              setManual(!manual);
            }}
          >
            {manual ? "收起人工方案" : "高级：提供模块、定义与引理方案"}
          </button>
          {manual && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onStart({ mode: "manual", planText: plan });
              }}
            >
              <p className="muted">
                使用结构化 JSON。定义含
                name、type、value、meaning、anchors、dependsOn；引理含
                name、target、proof、purpose、dependsOn。声明通过
                LemmaPaper.Name 引用。原任务未提取出命题时，还需提供
                proposal。此入口不调用模型。
              </p>
              <textarea
                aria-label="领域补全方案 JSON"
                required
                rows={12}
                maxLength={180000}
                spellCheck={false}
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
              />
              <button className="button primary full" disabled={!!busy}>
                检查补全方案，建立新版本
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
