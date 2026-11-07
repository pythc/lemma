const categories = {
  variables: "变量与类型",
  quantifiers: "量词与次序",
  domain: "定义域",
  assumptions: "前提条件",
  conclusion: "待证结论",
  definitions: "定义与引用",
};
const diagnostic = {
  verified: "检查通过",
  syntax: "语法问题",
  unknown_declaration: "找不到所用定理",
  type_or_conditions: "类型或使用条件不符",
  unsolved_goals: "仍有步骤未完成",
  proof_gap: "证明未完成",
  environment: "环境未就绪",
  resource_limit: "检查预算耗尽",
  cancelled: "已取消",
};
const stop = {
  verified: "取得可接受的证明",
  candidate_budget: "已用完候选次数",
  model_budget: "达到模型用量上限",
  time_budget: "达到任务时间上限",
  repeated_candidate: "候选与之前相同，停止重复尝试",
  repeated_failure: "连续出现相同报错",
  environment: "检查环境受阻",
  resource_limit: "检查资源不足",
  cancelled: "用户已取消",
  model_unavailable: "模型报告无法继续",
  execution_error: "执行受阻",
};

function Anchors({ items = [], onLocate }) {
  return items.map((a, i) =>
    a.pageIndex !== undefined ? (
      <button
        type="button"
        className="source-locate"
        key={i}
        onClick={() => onLocate(a.pageIndex, a.quote)}
      >
        第 {a.pageIndex + 1} 页 · {a.quote.slice(0, 90)}
        {a.quote.length > 90 ? "…" : ""}
      </button>
    ) : (
      <blockquote key={i}>补充材料：{a.quote}</blockquote>
    ),
  );
}

export function TranslationReview({ run, onLocate }) {
  const review = run.semanticReview;
  if (!review) return null;
  return (
    <section className="capability-section">
      <h4>命题翻译核对</h4>
      <p className="muted">
        逐项核对原文与形式目标。模型意见与类型检查都不能替代数学语义判断。
      </p>
      <details className="context-disclosure">
        <summary>
          已收集 {run.context?.pages.length || 0} 页相关原文 ·{" "}
          {run.context?.supplements.length || 0} 份补充材料
        </summary>
        {run.context?.pages.map((p) => (
          <div key={p.pageIndex}>
            <button
              type="button"
              className="source-locate"
              onClick={() => onLocate(p.pageIndex, p.text.slice(0, 120))}
            >
              第 {p.pageIndex + 1} 页 ·{" "}
              {p.pageIndex === run.pageIndex ? "所选命题" : "相关上下文"}
            </button>
            <p>
              {p.text.slice(0, 320)}
              {p.text.length > 320 ? "…" : ""}
            </p>
          </div>
        ))}
        {run.context?.supplements.map((s) => (
          <details key={s.id}>
            <summary>{s.name} · 用户提供，来源待核对</summary>
            <pre>{s.text}</pre>
          </details>
        ))}
        {!!run.context?.omittedPages.length && (
          <p className="review-warning">
            尚有 {run.context.omittedPages.length} 页未纳入本次模型上下文：
            {run.context.omittedPages.map((p) => p.pageIndex + 1).join("、")}。
          </p>
        )}
        <p className="muted">{run.context?.warning}</p>
      </details>
      <p>
        <strong>回译：</strong>
        {review.backTranslation}
      </p>
      {review.sourceAudit && (
        <SourceAudit
          audit={review.sourceAudit}
          probes={review.semanticProbes || []}
          onLocate={onLocate}
        />
      )}
      <div className="alignment-list">
        {Object.entries(categories).map(([key, label]) => (
          <details key={key}>
            <summary>
              {label} ·{" "}
              {review.checks.find((c) => c.category === key)?.status ===
              "aligned"
                ? "模型未发现差异"
                : run.approval
                  ? "已记录人工核对"
                  : "需核对"}
            </summary>
            {review.alignment
              .filter((a) => a.category === key)
              .map((a, i) => (
                <div key={i}>
                  <p>{a.explanation}</p>
                  {a.leanFragment && <pre>{a.leanFragment}</pre>}
                  <Anchors items={a.anchors} onLocate={onLocate} />
                </div>
              ))}
            {review.checks
              .filter((c) => c.category === key)
              .map((c) => (
                <div key={c.category}>
                  <p>{c.explanation}</p>
                  <Anchors items={c.anchors} onLocate={onLocate} />
                </div>
              ))}
            {!review.alignment.some((a) => a.category === key) && (
              <p>此项没有自动对照表，请在原文中核对。</p>
            )}
          </details>
        ))}
      </div>
      <p
        className={
          review.targetCheck?.status === "well_typed"
            ? "muted"
            : "review-warning"
        }
      >
        形式表达：{review.targetCheck?.reason || "未检查"}
      </p>
      {review.targetCheck?.status !== "well_typed" && (
        <details>
          <summary>类型检查诊断</summary>
          <pre>
            {review.targetCheck?.stdout ||
              review.targetCheck?.parser?.stdout ||
              review.targetCheck?.reason}
          </pre>
        </details>
      )}
      {!!review.issues.length && (
        <div className="translation-issues">
          <strong>
            {review.issues.length} 项{run.approval ? "核对记录" : "待核对事项"}
          </strong>
          {review.issues.map((item) => (
            <div key={item.id}>
              <p>{item.detail}</p>
              {run.approval?.resolutions?.find(
                (r) => r.issueId === item.id,
              ) && (
                <p className="resolution-record">
                  人工核对记录：
                  {
                    run.approval.resolutions.find((r) => r.issueId === item.id)
                      .reason
                  }
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SourceAudit({ audit, probes, onLocate }) {
  const boundaryNames = {
    nonempty: "非空条件",
    dimension: "维数",
    endpoint: "端点",
    equality: "等号条件",
    constant_dependency: "常数依赖",
    assumption_consistency: "前提一致性",
  };
  const labels = {
    matched: "模型未发现差异",
    concern: "存在疑点",
    unknown: "尚不明确",
    not_applicable: "此项不适用",
  };
  return (
    <details className="context-disclosure">
      <summary>
        定义、条件与原命题保持 ·{" "}
        {audit.coverage.status === "complete"
          ? "模型报告覆盖完整"
          : "材料尚不完整"}
        {audit.mathematicalConcerns?.length
          ? ` · ${audit.mathematicalConcerns.length} 项原文数学疑点`
          : ""}
      </summary>
      <p>
        这些对应关系来自有原文锚点的模型审计。修正建议和诊断证明分别保存，均不替代原命题。
      </p>
      <p>
        原命题保持：
        {
          {
            preserved: "模型判断忠实保留",
            changed: "存在改变",
            unknown: "尚不明确",
          }[audit.fidelity.status]
        }{" "}
        · {audit.fidelity.explanation}
      </p>
      <Anchors items={audit.fidelity.anchors} onLocate={onLocate} />
      {audit.bindings.map((b) => (
        <div key={b.id}>
          <p>
            <strong>{b.symbol}</strong> · 范围：第 {b.scope.start.pageIndex + 1}{" "}
            页至第 {b.scope.end.pageIndex + 1} 页
          </p>
          <Anchors items={[b.anchor]} onLocate={onLocate} />
          <p>引用位置：</p>
          <Anchors
            items={audit.uses
              .filter((u) => u.bindingId === b.id)
              .map((u) => u.anchor)}
            onLocate={onLocate}
          />
        </div>
      ))}
      {audit.quantifiers.map((q, i) => (
        <p key={q.binderId || `${q.variable}-${i}`}>
          {q.kind === "forall" ? "对所有" : "存在"} {q.variable}（绑定 {i + 1}）
          · 范围内此前变量：
          {q.dependsOn
            .map((id) => {
              const at = audit.quantifiers.findIndex((x) => x.binderId === id);
              return at < 0
                ? id
                : `${audit.quantifiers[at].variable}（绑定 ${at + 1}）`;
            })
            .join("、") || "未列出"}
          {q.leanFragment && <code>{q.leanFragment}</code>}
        </p>
      ))}
      {(audit.mathematicalConcerns || []).map((m, i) => (
        <div className="review-warning" key={`math-${i}`}>
          <p>
            <strong>原文数学疑点</strong> · {m.explanation}
          </p>
          <p>此疑点与翻译是否忠实分别记录；原命题及作者证明仍须独立核查。</p>
          <Anchors items={m.anchors} onLocate={onLocate} />
        </div>
      ))}
      {audit.boundaries.map((b) => (
        <div key={b.kind}>
          <p>
            {boundaryNames[b.kind]} · {labels[b.status]}：{b.explanation}
          </p>
          <Anchors items={b.anchors} onLocate={onLocate} />
        </div>
      ))}
      {audit.missing.map((m, i) => (
        <p className="review-warning" key={i}>
          缺失：{m.symbol} · {m.reason}
        </p>
      ))}
      {audit.corrections.map((c) => (
        <details key={c.id}>
          <summary>单独的修正建议 · 尚未采用</summary>
          <p>{c.statement}</p>
          <pre>{c.leanTarget}</pre>
          <p>{c.reason}</p>
          <p>采用后须建立新目标并重新审查。</p>
          <Anchors items={c.anchors} onLocate={onLocate} />
        </details>
      ))}
      {probes.map((p) => (
        <details key={p.artifact}>
          <summary>
            独立诊断 ·{" "}
            {p.check.status === "verified"
              ? "诊断目标通过 Lean 检查"
              : "诊断未获证明"}
          </summary>
          <p>{p.explanation}</p>
          <pre>{p.contract.leanTarget}</pre>
          <p>此结果不确认原文忠实性，也不证明原命题。</p>
        </details>
      ))}
    </details>
  );
}

export function ResolutionFields({ review }) {
  if (!review) return null;
  return review.issues.map((item) =>
    item.sourceEvidenceRequired ? (
      <p key={item.id} className="review-warning">
        {item.detail}{" "}
        请补充原文核对证据并重新建立目标；填写确认理由不能消除此项。
      </p>
    ) : (
      <label key={item.id} className="resolution-field">
        核对：{item.detail}
        <textarea
          name={`resolution_${item.id}`}
          required
          minLength={12}
          maxLength={2000}
          rows={3}
          placeholder="若确认原翻译正确，说明具体原文依据及理由；若翻译确实有误，请重新建立目标。"
        />
      </label>
    ),
  );
}

export function RepairHistory({ run }) {
  if (!run.repair && !run.knowledge) return null;
  return (
    <section className="capability-section">
      <h4>证明尝试与修复</h4>
      <p>
        {run.repair?.stopReason
          ? stop[run.repair.stopReason] || run.repair.stopReason
          : "正在处理固定命题"}
      </p>
      {run.repair?.explanation && <p>{run.repair.explanation}</p>}
      {run.repair && (
        <p className="muted">
          最多 {run.repair.budget.maxCandidates} 个候选 ·{" "}
          {run.repair.budget.maxElapsedMs / 60000} 分钟预算 · 已请求模型{" "}
          {run.repair.modelCalls} 次。每轮保持目标和前提不变。
        </p>
      )}
      <ol className="repair-history">
        {run.attempts?.map((a) => (
          <li key={a.number}>
            <strong>
              第 {a.number} 次 ·{" "}
              {a.status === "verified"
                ? "Lean 通过"
                : a.status === "duplicate"
                  ? "重复候选，未再检查"
                  : diagnostic[a.diagnostic?.category] || "未完成"}
            </strong>
            <div className="review-actions">
              <a
                href={`/api/artifacts/${a.proofArtifact}?view=summary`}
                target="_blank"
                rel="noreferrer"
              >
                查看候选
              </a>
              {a.checkArtifact && (
                <a
                  href={`/api/artifacts/${a.checkArtifact}?view=summary`}
                  target="_blank"
                  rel="noreferrer"
                >
                  检查依据
                </a>
              )}
            </div>
            {a.diagnostic?.message && a.status !== "verified" && (
              <details>
                <summary>Lean 报错与未完成步骤</summary>
                <pre>{a.diagnostic.message}</pre>
              </details>
            )}
            <details>
              <summary>
                {a.number === 1 ? "初始证明" : "相较上次修改了什么"}
              </summary>
              {a.diff?.removed && (
                <>
                  <small>移除</small>
                  <pre className="diff-removed">{a.diff.removed}</pre>
                </>
              )}
              <small>加入</small>
              <pre className="diff-added">
                {a.diff?.added || "没有新增内容"}
              </pre>
            </details>
          </li>
        ))}
      </ol>
      {run.knowledge && (
        <details>
          <summary>
            本轮检索到 {run.knowledge.entries.length} 条数学库声明
          </summary>
          <p className="muted">
            声明类型已在固定环境查询；下列适用条件说明仍需结合当前目标核对。
          </p>
          {run.knowledge.entries.map((e) => (
            <div className="knowledge-entry" key={e.name}>
              <a href={e.url} target="_blank" rel="noreferrer">
                {e.name}
              </a>
              <p>{e.conditions}</p>
              <pre>{e.signature}</pre>
            </div>
          ))}
          {run.knowledge.status === "lookup_failed" && (
            <p className="review-warning">
              查询未通过，没有将未核实的声明交给证明角色。
            </p>
          )}
        </details>
      )}
    </section>
  );
}
