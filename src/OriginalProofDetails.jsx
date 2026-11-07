import "./original-proof.css";
import { ORIGINAL_STEP_LABELS } from "./original-step-labels.js";
import { reviewErrorMessage } from "../shared/reading-status.mjs";
function ToolEvidence({ tasks, parentIds, onEvidence }) {
  const tools = tasks.filter(
    (t) =>
      t.role === "HARNESS_TOOL" &&
      t.parents?.some((id) => parentIds.includes(id)),
  );
  if (!tools.length) return null;
  return (
    <details>
      <summary>相关工具依据</summary>
      <ul>
        {tools.map((t) => (
          <li key={t.id}>
            {t.output ? (
              <a
                href={`/api/artifacts/${t.output}`}
                onClick={
                  onEvidence
                    ? (e) => {
                        e.preventDefault();
                        onEvidence({ output: t.output, title: t.title });
                      }
                    : undefined
                }
              >
                {t.title}
              </a>
            ) : (
              t.title
            )}{" "}
            ·{" "}
            {{
              running: "正在执行",
              queued: "等待资源",
              succeeded: "已返回",
              failed: "遇到问题",
              cancelled: "已停止",
            }[t.status] || "未完成"}
          </li>
        ))}
      </ul>
    </details>
  );
}
export function OriginalProofDetails({
  route,
  onLocate,
  tasks = [],
  showConclusion = true,
  onEvidence,
}) {
  if (!route) return null;
  const steps =
    route.graph?.steps?.map((s) => {
      const completed = route.steps?.find((r) => r.name === s.name);
      if (completed) return { ...s, ...completed };
      const task = tasks.findLast(
        (t) =>
          t.title.includes(`${s.name} ·`) &&
          ["running", "queued"].includes(t.status),
      );
      return { ...s, status: task?.status || "pending" };
    }) ||
    route.steps ||
    [];
  return (
    <section className="original-proof" aria-label="原证明逐步核验">
      <h3>原证明核验</h3>
      <p>
        {showConclusion
          ? route.summary?.headline || "正在沿原文检查证明步骤"
          : "沿原文逐步检查，点击步骤查看当前依据"}
      </p>
      {route.error && <p role="status">{reviewErrorMessage(route.error)}</p>}
      {showConclusion && route.independentTheorem?.status === "verified" && (
        <details className="original-step passed">
          <summary>
            <span>所选命题核验</span>
            <strong>已通过 Lean</strong>
          </summary>
          <p>该证书证明所选命题。原证明路线的判断仍见下方步骤与连接结果。</p>
          <pre>{route.independentTheorem.contract.leanTarget}</pre>
          <details>
            <summary>Lean 证明</summary>
            <pre>{route.independentTheorem.proof}</pre>
          </details>
          <p>
            基础公理：{route.independentTheorem.check.axioms.join("、") || "无"}
          </p>
          <a
            href={`/api/artifacts/${route.independentTheorem.artifact}`}
            download
            onClick={
              onEvidence
                ? (e) => {
                    e.preventDefault();
                    onEvidence({
                      output: route.independentTheorem.artifact,
                      title: "所选命题的 Lean 证书",
                    });
                  }
                : undefined
            }
          >
            查看命题证据
          </a>
        </details>
      )}
      {steps.map((s) => (
        <details key={s.name} className={`original-step ${s.status}`}>
          <summary>
            <span>{s.title || s.name}</span>
            <strong>{ORIGINAL_STEP_LABELS[s.status] || "等待检查"}</strong>
          </summary>
          <p>{reviewErrorMessage(s.explanation)}</p>
          <ToolEvidence
            tasks={tasks}
            parentIds={tasks
              .filter((t) => t.title.includes(`${s.name} ·`))
              .map((t) => t.id)}
            onEvidence={onEvidence}
          />
          {s.routeAssessment?.explanation && (
            <p>路线复核：{s.routeAssessment.explanation}</p>
          )}
          {!!s.dependsOn?.length && (
            <p>
              依据：
              {s.dependsOn
                .map(
                  (n) =>
                    route.graph?.steps.find((v) => v.name === n)?.title || n,
                )
                .join("、")}
            </p>
          )}
          {s.anchors?.map((a, i) =>
            Number.isInteger(a.pageIndex) ? (
              <button
                key={i}
                className="source-locate"
                onClick={() => onLocate?.(a.pageIndex, a.quote)}
              >
                第 {a.pageIndex + 1} 页 · {a.quote.slice(0, 70)}
              </button>
            ) : (
              <p key={i}>补充材料：{a.quote}</p>
            ),
          )}
          {s.contract && (
            <details>
              <summary>形式化目标与检查依据</summary>
              {!!route.blueprint?.parts?.find((p) => p.name === s.name)
                ?.consumers.length && (
                <p>
                  本引理用于：
                  {route.blueprint.parts
                    .find((p) => p.name === s.name)
                    .consumers.map(
                      (n) =>
                        route.graph.steps.find((p) => p.name === n)?.title || n,
                    )
                    .join("、")}
                </p>
              )}
              {route.blueprint?.parts?.find((p) => p.name === s.name)
                ?.previousInterfaceChanged && (
                <p>已根据下游推导修订接口，本次重新核验。</p>
              )}
              <pre>{s.contract.leanTarget}</pre>
              {s.proof && (
                <>
                  <p>
                    {s.check?.mode === "counterexample"
                      ? "本步反例的 Lean 证明"
                      : "本步 Lean 证明"}
                  </p>
                  <pre>{s.proof}</pre>
                </>
              )}
              {!!s.check?.axioms?.length && (
                <p>使用的基础公理：{s.check.axioms.join("、")}</p>
              )}
              <p>
                Lean：
                {s.check?.status === "verified"
                  ? "该局部目标已检查"
                  : "尚无通过证据"}
                {s.status === "conditional"
                  ? "；所依赖的前序步骤尚未全部成立"
                  : ""}
              </p>
              {s.audit?.hits?.length > 0 && (
                <p>路线冲突：{s.audit.hits.join("、")}</p>
              )}
              {s.audit?.prohibitedAxioms?.length > 0 && (
                <p>证明方法限制：{s.audit.prohibitedAxioms.join("、")}</p>
              )}
            </details>
          )}
          {s.artifact && (
            <a
              href={`/api/artifacts/${s.artifact}`}
              download
              onClick={
                onEvidence
                  ? (e) => {
                      e.preventDefault();
                      onEvidence({
                        output: s.artifact,
                        title: s.title || s.name,
                      });
                    }
                  : undefined
              }
            >
              查看本步证据
            </a>
          )}
        </details>
      ))}
      {route.summary?.missingSteps?.length > 0 && (
        <details>
          <summary>尚未覆盖的推理</summary>
          <ul>
            {route.summary.missingSteps.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </details>
      )}
      {route.assembly && (
        <details
          className={`original-step ${route.assembly.status === "verified" ? "passed" : "unverified"}`}
        >
          <summary>
            <span>整条证明的连接</span>
            <strong>
              {route.assembly.status === "verified" ? "已通过" : "尚未闭合"}
            </strong>
          </summary>
          <p>
            {route.assembly.status === "verified"
              ? "局部证明已连接并通过 Lean。"
              : "不能据此认定原证明整条通过。"}
          </p>
          {route.assembly.routeAssessment?.value?.explanation && (
            <p>路线复核：{route.assembly.routeAssessment.value.explanation}</p>
          )}
          {route.assembly.reason && (
            <p>{reviewErrorMessage(route.assembly.reason)}</p>
          )}
          {!!route.assembly.audit?.missingSourceSteps?.length && (
            <p>
              当前连接未实际接入：
              {route.assembly.audit.missingSourceSteps
                .map(
                  (name) =>
                    route.graph?.steps?.find((s) => s.name === name)?.title ||
                    name,
                )
                .join("、")}
              。
            </p>
          )}
          {route.assembly.connectionProof && (
            <details>
              <summary>连接证明</summary>
              <pre>{route.assembly.connectionProof}</pre>
            </details>
          )}
          <ToolEvidence
            tasks={tasks}
            parentIds={tasks
              .filter((t) => t.role === "R06_ASSEMBLY_REPAIR")
              .slice(-1)
              .map((t) => t.id)}
            onEvidence={onEvidence}
          />
          {route.assembly.artifact && (
            <a
              href={`/api/artifacts/${route.assembly.artifact}`}
              download
              onClick={
                onEvidence
                  ? (e) => {
                      e.preventDefault();
                      onEvidence({
                        output: route.assembly.artifact,
                        title: "整条证明的连接依据",
                      });
                    }
                  : undefined
              }
            >
              查看连接依据
            </a>
          )}
        </details>
      )}
      {!!route.methodClaims?.length && (
        <details className="original-methods">
          <summary>论文的证明方法声明</summary>
          {route.methodClaims.map((m, i) => (
            <div key={i}>
              <p>{m.claim}</p>
              <p>
                {/choice|选择/i.test(m.claim) &&
                (route.steps || []).some((s) =>
                  s.check?.axioms?.includes("Classical.choice"),
                )
                  ? "当前形式化证据依赖 Classical.choice，尚未证成原文不使用选择公理的声明。"
                  : "该方法声明尚未完整核验。"}
              </p>
              <button
                className="source-locate"
                disabled={!Number.isInteger(m.anchor.pageIndex)}
                onClick={() => onLocate?.(m.anchor.pageIndex, m.anchor.quote)}
              >
                查看原文声明
              </button>
            </div>
          ))}
        </details>
      )}
      {route.root && (
        <a
          className="source-locate"
          href={`/api/artifacts/${route.root}`}
          download
          onClick={
            onEvidence
              ? (e) => {
                  e.preventDefault();
                  onEvidence({ output: route.root, title: "原证明核验依据" });
                }
              : undefined
          }
        >
          原证明核验依据
        </a>
      )}
    </section>
  );
}
