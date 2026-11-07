import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  DownloadSimple,
  WarningCircle,
  CheckCircle,
} from "@phosphor-icons/react";
import { request, base64 } from "./api.js";
import { ENTRY_TYPES, ENTRY_STATES } from "../shared/ledger-labels.mjs";
import "./review.css";

export function PaperLedgerPanel({
  paper,
  pageIndex,
  initialQuote,
  initialRunId,
  initialEntryId,
  onLocate,
  onOpenRun,
  onReviewEntry,
}) {
  const [view, setView] = useState(null),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(""),
    [history, setHistory] = useState([]),
    [candidate, setCandidate] = useState(null);
  const [runId, setRunId] = useState(initialRunId || ""),
    [selectedId, setSelectedId] = useState(initialEntryId || null),
    [replay, setReplay] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [adoptType, setAdoptType] = useState("claim");
  const endpoint = `/api/papers/${paper.id}/ledger`;
  useEffect(() => {
    const abort = new AbortController();
    Promise.all([
      request(endpoint, undefined, abort.signal),
      request(`/api/reviews?paper=${paper.id}`, undefined, abort.signal),
    ])
      .then(([value, runs]) => {
        if (!abort.signal.aborted) {
          setView(value);
          setHistory(runs.items.filter((r) => r.root));
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(e.message);
          setLoaded(true);
        }
      });
    return () => abort.abort();
  }, [paper.id]);
  useEffect(() => {
    const abort = new AbortController();
    setCandidate(null);
    if (runId)
      request(`/api/reviews/${runId}`, undefined, abort.signal)
        .then((value) => {
          if (!abort.signal.aborted && value.paperSha256 === paper.id)
            setCandidate(value);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(e.message);
        });
    return () => abort.abort();
  }, [runId, paper.id]);
  async function act(label, action) {
    if (busy) return;
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  async function mutate(operation, payload) {
    const value = await request(endpoint, {
      expectedRevision: view.revision,
      operation,
      payload,
    });
    setView(value);
    setReplay(null);
    return value;
  }
  const submit = (label, action) => (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void act(label, () => action(data));
  };
  const items = view?.report.items || [];
  const matchingEntry =
    candidate?.contract &&
    items.find(
      (e) =>
        e.type === adoptType &&
        e.pageIndex === candidate.contract.pageIndex &&
        e.label === candidate.contract.label &&
        e.statement === candidate.contract.statement &&
        e.quote.normalize("NFC").replace(/\s+/g, " ").trim() ===
          candidate.contract.quote.normalize("NFC").replace(/\s+/g, " ").trim(),
    );
  const candidateEntryId = initialEntryId || matchingEntry?.id;
  const candidateCurrent =
    candidate &&
    items.some(
      (e) =>
        (!candidateEntryId || e.id === candidateEntryId) &&
        e.evidence.some((b) => b.runId === candidate.id && b.current),
    );
  const visible = showAll
    ? items
    : [...items].sort(
        (a, b) => Number(a.state === "proved") - Number(b.state === "proved"),
      );
  const pendingCount = items.filter(
    (e) => !["proved", "refuted"].includes(e.state),
  ).length;
  return (
    <div className="review-content ledger-content">
      <section className="conclusion-card" aria-live="polite">
        <p className="scope-label">
          {view ? view.snapshot.title : "范围与证明义务"} · 文件{" "}
          {paper.id.slice(0, 6)}
        </p>
        <h3>
          {view?.report.headline ||
            (loaded ? "先明确本次评审范围" : "正在读取范围账本")}
        </h3>
        <p className="scope-caveat">
          人工登记的清单不证明全篇无遗漏；原证明仍需独立审计。
        </p>
        {view && (
          <dl className="conclusion-dimensions">
            <div>
              <dt>登记总数</dt>
              <dd>{items.length} 项</dd>
            </div>
            <div>
              <dt>形式化已证明 / 否定</dt>
              <dd>
                {view.report.counts.proved} / {view.report.counts.refuted}
              </dd>
            </div>
            <div>
              <dt>未完成或范围外</dt>
              <dd>{pendingCount} 项</dd>
            </div>
          </dl>
        )}
      </section>
      {error && (
        <p className="review-error" role="alert">
          <WarningCircle size={16} />
          {error}
        </p>
      )}
      {loaded && !view && (
        <form
          className="review-form"
          onSubmit={submit("建立范围", async (data) => {
            setView(
              await request(endpoint + "/create", {
                title: String(data.get("title")),
                description: String(data.get("description")),
                pdfBase64: await base64(paper.bytes),
              }),
            );
          })}
        >
          <label>
            范围名称
            <input
              name="title"
              required
              maxLength={120}
              defaultValue="主定理与关键依赖"
            />
          </label>
          <label>
            本次范围与排除项
            <textarea
              name="description"
              required
              maxLength={3000}
              rows={3}
              placeholder="写明选择哪些主定理、引理和材料，哪些内容尚不覆盖。"
            />
          </label>
          <p className="muted">
            服务端会固定原 PDF
            并提取各页文本。没有文本的页面保留缺口，不会静默算作已检查。
          </p>
          <button className="button primary" disabled={!!busy}>
            {busy || "建立评审范围"}
          </button>
        </form>
      )}
      {view && (
        <>
          <p className="ledger-scope-description">
            {view.snapshot.description}
          </p>
          {view.pagesWithoutText.length > 0 && (
            <p className="review-warning">
              第 {view.pagesWithoutText.map((p) => p + 1).join("、")}{" "}
              页没有文本层；尚未 OCR 或核查其中义务。
            </p>
          )}
          {view.generatorChanged && (
            <p className="review-warning">
              报告生成器版本已变化；请导出并重新核验，不能标为同环境复现。
            </p>
          )}
          {view.report.mains.map((main) => (
            <p className="ledger-blocker" key={main.id}>
              <strong>{items.find((e) => e.id === main.id)?.label}</strong> ·{" "}
              {main.closed
                ? "登记依赖内的形式目标已检查"
                : `${main.blockedIds.length} 项未闭合${main.cycleIds.length ? "，存在循环依赖" : ""}`}
            </p>
          ))}
          <div className="ledger-list-heading">
            <h4>登记义务</h4>
            <button
              className="advanced-entry"
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? "未完成优先" : "登记顺序"}
            </button>
          </div>
          {!items.length && (
            <p className="muted">
              尚无条目。可登记已有评审，或先记录缺失定义、条件和引用。
            </p>
          )}
          <div className="ledger-list">
            {visible.map((entry) => (
              <article className="ledger-entry" key={entry.id}>
                <button
                  className="ledger-entry-summary"
                  aria-expanded={selectedId === entry.id}
                  onClick={() =>
                    setSelectedId(selectedId === entry.id ? null : entry.id)
                  }
                >
                  <span>
                    <strong>{entry.label}</strong>
                    {view.snapshot.mainIds.includes(entry.id) && (
                      <small className="ledger-main-tag">主目标</small>
                    )}
                    <small>
                      {ENTRY_TYPES[entry.type]} · 第 {entry.pageIndex + 1} 页
                    </small>
                  </span>
                  <span className={`ledger-state ${entry.state}`}>
                    {ENTRY_STATES[entry.state]}
                  </span>
                </button>
                {selectedId === entry.id && (
                  <div className="ledger-entry-detail">
                    <p>{entry.statement}</p>
                    <blockquote>{entry.quote}</blockquote>
                    <button
                      className="source-locate"
                      onClick={() => onLocate(entry.pageIndex, entry.quote)}
                    >
                      第 {entry.pageIndex + 1} 页 · 定位原文{" "}
                      <ArrowUpRight size={15} />
                    </button>
                    {entry.excludedReason && (
                      <p className="review-warning">
                        排除理由：{entry.excludedReason}。此项仍计入登记总数。
                      </p>
                    )}
                    {entry.state === "stale" && (
                      <p className="review-warning">
                        条目或依赖已变更，原证据保留但不计入当前完成状态。
                      </p>
                    )}
                    {entry.target && (
                      <details>
                        <summary>固定形式化目标</summary>
                        <pre>{entry.target.leanTarget}</pre>
                        <code>{entry.target.targetHash}</code>
                      </details>
                    )}
                    {["claim", "proof_step", "condition"].includes(
                      entry.type,
                    ) &&
                      onReviewEntry && (
                        <button
                          className="advanced-entry"
                          onClick={() => onReviewEntry(entry)}
                        >
                          为此义务建立评审目标
                        </button>
                      )}
                    {entry.evidence.map((evidence) => (
                      <button
                        className="history-row"
                        key={`${evidence.root}:${evidence.entryHash}:${evidence.dependencyHash}`}
                        onClick={() => onOpenRun(evidence.runId)}
                      >
                        <strong>
                          {evidence.current ? "当前关联" : "历史关联 · 已过期"}{" "}
                          · 查看核验依据 <ArrowUpRight size={13} />
                        </strong>
                        <small>
                          {evidence.root.slice(0, 16)} ·{" "}
                          {evidence.theorem === "formalized_proved"
                            ? "形式化已证明"
                            : evidence.theorem === "refuted"
                              ? "否定已证明"
                              : "未知"}
                        </small>
                      </button>
                    ))}
                    {entry.dependsOn.length > 0 && (
                      <div className="ledger-dependencies">
                        <p className="muted">依赖项</p>
                        {entry.dependsOn.map((id) => {
                          const dep = items.find((e) => e.id === id);
                          return (
                            <button
                              className="source-locate"
                              key={id}
                              onClick={() => {
                                setSelectedId(id);
                                onLocate(dep.pageIndex, dep.quote);
                              }}
                            >
                              {dep.label} · {ENTRY_STATES[dep.state]}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <details>
                      <summary>编辑依赖与范围</summary>
                      <form
                        className="review-form"
                        onSubmit={submit("更新依赖", (data) =>
                          mutate("set_dependencies", {
                            entryId: entry.id,
                            dependsOn: data.getAll("dependencies"),
                            reason: String(data.get("reason")),
                          }),
                        )}
                      >
                        {items.map((dep) => (
                          <label className="confirmation-label" key={dep.id}>
                            <input
                              type="checkbox"
                              name="dependencies"
                              value={dep.id}
                              defaultChecked={entry.dependsOn.includes(dep.id)}
                            />
                            {dep.label} · {ENTRY_TYPES[dep.type]}
                          </label>
                        ))}
                        <label>
                          依赖修改理由
                          <input name="reason" required maxLength={1000} />
                        </label>
                        <button className="button outline" disabled={!!busy}>
                          保存依赖并使旧关联过期
                        </button>
                      </form>
                      {entry.type === "claim" && (
                        <form
                          className="review-form"
                          onSubmit={submit("修改主目标", (data) =>
                            mutate("set_main", {
                              entryId: entry.id,
                              selected: !view.snapshot.mainIds.includes(
                                entry.id,
                              ),
                              reason: String(data.get("reason")),
                            }),
                          )}
                        >
                          <label>
                            主目标范围变更理由
                            <input name="reason" required maxLength={1000} />
                          </label>
                          <button className="button outline" disabled={!!busy}>
                            {view.snapshot.mainIds.includes(entry.id)
                              ? "移出主目标，保留条目"
                              : "设为主目标"}
                          </button>
                        </form>
                      )}
                      <form
                        className="review-form"
                        onSubmit={submit("调整排除项", (data) =>
                          mutate("exclude", {
                            entryId: entry.id,
                            reason: entry.excludedReason
                              ? null
                              : String(data.get("reason")),
                          }),
                        )}
                      >
                        {!entry.excludedReason && (
                          <label>
                            列为范围外的理由
                            <input name="reason" required maxLength={1000} />
                          </label>
                        )}
                        <button className="button outline" disabled={!!busy}>
                          {entry.excludedReason
                            ? "恢复到登记范围"
                            : "列为范围外并保留未完成记录"}
                        </button>
                      </form>
                    </details>
                    <details>
                      <summary>修订条目内容</summary>
                      <form
                        className="review-form"
                        onSubmit={submit("修订条目", (data) =>
                          mutate("edit_entry", {
                            entryId: entry.id,
                            label: String(data.get("label")),
                            pageIndex: Number(data.get("page")) - 1,
                            quote: String(data.get("quote")),
                            statement: String(data.get("statement")),
                            reason: String(data.get("reason")),
                          }),
                        )}
                      >
                        <EntryFields
                          paper={paper}
                          pageIndex={entry.pageIndex}
                          quote={entry.quote}
                          entry={entry}
                        />
                        <label>
                          修订理由
                          <input name="reason" required maxLength={1000} />
                        </label>
                        <p className="muted">
                          修订会解除当前形式目标并使相关关联过期；旧版本和证据仍保留。
                        </p>
                        <button className="button outline" disabled={!!busy}>
                          保存新版本
                        </button>
                      </form>
                    </details>
                    {["claim", "proof_step", "condition"].includes(
                      entry.type,
                    ) && (
                      <details>
                        <summary>关联新的核验记录</summary>
                        <form
                          className="review-form"
                          onSubmit={submit("关联运行", (data) =>
                            mutate("link_run", {
                              entryId: entry.id,
                              runId: String(data.get("runId")),
                            }),
                          )}
                        >
                          <label>
                            近期已归档评审
                            <select name="runId" required defaultValue="">
                              <option value="">选择对应目标</option>
                              {history.map((r) => (
                                <option value={r.id} key={r.id}>
                                  {r.label} · 第 {r.pageIndex + 1} 页 ·{" "}
                                  {r.headline || r.status}
                                </option>
                              ))}
                            </select>
                          </label>
                          <p className="muted">
                            必须匹配同一原文、表述及固定目标；关联不代表原证明已核验。
                          </p>
                          <button className="button outline" disabled={!!busy}>
                            关联该目标
                          </button>
                        </form>
                      </details>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
          <details
            open={
              !!initialRunId &&
              !items.some(
                (e) =>
                  (!initialEntryId || e.id === initialEntryId) &&
                  e.evidence.some((b) => b.runId === initialRunId && b.current),
              )
            }
            className="ledger-register"
          >
            <summary>
              {candidateEntryId ? "关联已有义务的评审" : "登记已有评审"}
            </summary>
            <label className="library-choice">
              近期已归档评审
              <select
                aria-label="选择要登记的评审"
                value={runId}
                onChange={(e) => setRunId(e.target.value)}
              >
                <option value="">选择已有记录</option>
                {history.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label} · 第 {r.pageIndex + 1} 页 ·{" "}
                    {r.headline || r.status}
                  </option>
                ))}
              </select>
            </label>
            {candidate && (!candidate.contract || !candidate.check) && (
              <p className="muted">
                此记录没有可关联的完整目标与检查链；历史评审仍保留该受阻记录。
              </p>
            )}
            {candidate?.contract && candidate.check && (
              <form
                className="review-form"
                onSubmit={submit("登记运行", async (data) => {
                  const next = candidateEntryId
                    ? await mutate("link_run", {
                        entryId: candidateEntryId,
                        runId: candidate.id,
                      })
                    : await mutate("adopt_run", {
                        runId: candidate.id,
                        type: String(data.get("type")),
                        asMain: data.has("main"),
                      });
                  setSelectedId(
                    candidateEntryId || next.snapshot.entries.at(-1).id,
                  );
                })}
              >
                <p>
                  <strong>{candidate.contract.label}</strong> · 第{" "}
                  {candidate.contract.pageIndex + 1} 页
                </p>
                <blockquote>{candidate.contract.quote}</blockquote>
                <details>
                  <summary>核对固定目标</summary>
                  <pre>{candidate.contract.leanTarget}</pre>
                </details>
                {!candidateEntryId && (
                  <label>
                    条目类别
                    <select
                      name="type"
                      value={adoptType}
                      onChange={(e) => setAdoptType(e.target.value)}
                    >
                      <option value="claim">命题</option>
                      <option value="proof_step">原证明步骤</option>
                      <option value="condition">条件与边界</option>
                    </select>
                  </label>
                )}
                {!candidateEntryId && adoptType === "claim" && (
                  <label className="confirmation-label">
                    <input type="checkbox" name="main" />
                    同时设为主目标（仅命题）
                  </label>
                )}
                <button
                  className="button outline"
                  disabled={!!busy || !!candidateCurrent}
                >
                  {candidateCurrent
                    ? "该记录已关联当前版本"
                    : candidateEntryId
                      ? "关联到已有义务"
                      : "登记该命题及实际证据"}
                </button>
              </form>
            )}
          </details>
          <details className="ledger-register">
            <summary>登记未完成项</summary>
            {!!candidate?.pendingObligations?.length && (
              <div className="translation-issues">
                <p>
                  当前评审发现 {candidate.pendingObligations.length}{" "}
                  项待补材料或条件：
                </p>
                <ul>
                  {candidate.pendingObligations.map((item, i) => (
                    <li key={i}>
                      第 {item.pageIndex + 1} 页 · {item.statement}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="button outline"
                  disabled={!!busy}
                  onClick={() =>
                    act("登记评审义务", () =>
                      mutate("import_review_obligations", {
                        runId: candidate.id,
                      }),
                    )
                  }
                >
                  将这些事项登记为未核验
                </button>
                <p className="muted">
                  登记后可在条目中建立依赖；不会自动补前提或改变任何证明结论。
                </p>
              </div>
            )}
            <form
              className="review-form"
              onSubmit={submit("登记义务", async (data) => {
                const next = await mutate("add_entry", {
                  type: String(data.get("type")),
                  label: String(data.get("label")),
                  pageIndex: Number(data.get("page")) - 1,
                  quote: String(data.get("quote")),
                  statement: String(data.get("statement")),
                });
                setSelectedId(next.snapshot.entries.at(-1).id);
              })}
            >
              <label>
                条目类别
                <select name="type">
                  {Object.entries(ENTRY_TYPES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <EntryFields
                paper={paper}
                pageIndex={pageIndex}
                quote={initialQuote}
              />
              <button className="button outline" disabled={!!busy}>
                登记为未核验
              </button>
            </form>
          </details>
          <section className="report-evidence">
            <div className="review-actions">
              <a
                className="button primary"
                href={endpoint + "/bundle"}
                download
              >
                <DownloadSimple size={17} />
                导出范围复现包
              </a>
              <button
                className="button outline"
                disabled={!!busy}
                onClick={() =>
                  act("范围复现", async () =>
                    setReplay(await request(endpoint + "/replay", {})),
                  )
                }
              >
                {busy === "范围复现" ? "逐项重放中…" : "复现登记证据"}
              </button>
            </div>
            {replay && (
              <p
                className={
                  replay.reproduced ? "replay-result" : "review-warning"
                }
                role="status"
              >
                {replay.reproduced ? (
                  <CheckCircle size={17} />
                ) : (
                  <WarningCircle size={17} />
                )}
                {replay.root !== view.root
                  ? "这是旧修订的重放结果，不计入当前修订。"
                  : replay.reproduced
                    ? "全部关联证据已逐项重跑，账本结果一致；未完成项仍保留。"
                    : replay.revalidated
                      ? "已逐项重新核验，执行环境不同，不能称为同环境复现。"
                      : "未完成全部机器证据的复现，保留未完成状态。"}
              </p>
            )}
            <details>
              <summary>
                范围与修订依据 · {view.snapshot.changes.length} 次记录
              </summary>
              <code>
                账本修订 {view.revision}
                <br />
                报告根 {view.root}
              </code>
              <p>{view.report.caveat}</p>
              <ol className="ledger-changes">
                {[...view.snapshot.changes].reverse().map((c, i) => (
                  <li key={i}>
                    {changeLabel[c.type] || c.type}
                    {c.entryId &&
                      ` · ${items.find((e) => e.id === c.entryId)?.label || "历史条目"}`}
                    <small>
                      {new Date(c.at).toLocaleString()}
                      {c.reason && ` · ${c.reason}`}
                    </small>
                  </li>
                ))}
              </ol>
              <p className="muted">
                本机预算：{view.limits.entries} 项登记、{view.limits.runs}{" "}
                次独立核验、{view.limits.revisions}{" "}
                次修订。超过预算会停止，不清除既有记录。账本不代替自然语言语义与原证明审计。
              </p>
            </details>
            <details>
              <summary>调整范围说明</summary>
              <form
                className="review-form"
                onSubmit={submit("修改范围", (data) =>
                  mutate("set_scope", {
                    title: String(data.get("title")),
                    description: String(data.get("description")),
                    reason: String(data.get("reason")),
                  }),
                )}
              >
                <label>
                  范围名称
                  <input
                    name="title"
                    required
                    maxLength={120}
                    defaultValue={view.snapshot.title}
                  />
                </label>
                <label>
                  范围说明
                  <textarea
                    name="description"
                    required
                    maxLength={3000}
                    defaultValue={view.snapshot.description}
                  />
                </label>
                <label>
                  变更理由
                  <input name="reason" required maxLength={1000} />
                </label>
                <button className="button outline" disabled={!!busy}>
                  保存范围修订
                </button>
              </form>
            </details>
          </section>
        </>
      )}
      {loaded && (
        <button
          className="advanced-entry"
          disabled={!!busy}
          onClick={() =>
            act("重新读取", async () => {
              setView(await request(endpoint));
              setHistory(
                (await request(`/api/reviews?paper=${paper.id}`)).items.filter(
                  (r) => r.root,
                ),
              );
            })
          }
        >
          重新读取范围与记录
        </button>
      )}
    </div>
  );
}
const changeLabel = {
  create: "建立范围",
  add_entry: "登记未完成项",
  import_review_obligations: "登记评审发现的义务",
  adopt_run: "登记实际评审",
  link_run: "关联证据",
  set_dependencies: "修订依赖",
  edit_entry: "修订条目",
  set_main: "调整主目标",
  exclude: "调整排除项",
  set_scope: "修订范围说明",
};
function EntryFields({ paper, pageIndex, quote = "", entry }) {
  return (
    <>
      <label>
        条目编号
        <input
          name="label"
          required
          maxLength={120}
          defaultValue={entry?.label}
        />
      </label>
      <label>
        原文页码
        <input
          name="page"
          type="number"
          min={1}
          max={paper.pageCount}
          required
          defaultValue={pageIndex + 1}
        />
      </label>
      <label>
        原文引句
        <textarea
          name="quote"
          rows={3}
          required
          maxLength={5000}
          defaultValue={quote}
        />
      </label>
      <label>
        条目表述
        <textarea
          name="statement"
          rows={2}
          required
          maxLength={5000}
          defaultValue={entry?.statement}
        />
      </label>
    </>
  );
}
