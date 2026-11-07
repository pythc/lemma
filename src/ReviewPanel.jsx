import { terminalRun, reviewCompletion } from "../shared/review-completion.mjs";
import { OriginalProofDetails } from "./OriginalProofDetails.jsx";
import { DomainRecovery } from "./DomainRecovery.jsx";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  DownloadSimple,
  FileText,
  WarningCircle,
} from "@phosphor-icons/react";
import { rememberReview, reviewRunFor } from "./storage.js";
import {
  LIBRARY_PROFILES,
  libraryProfile,
  profileForContract,
} from "../shared/library-profiles.mjs";
import "./review.css";
import { request, base64 } from "./api.js";
import {
  TranslationReview,
  ResolutionFields,
  RepairHistory,
} from "./CapabilityReview.jsx";

const active = (run) => ["preparing", "running"].includes(run?.status);
const semanticLabel = {
  agent_reviewed: "Agent 已复核",
  human_confirmed: "人工已确认",
  unreviewed: "待确认",
};
const theoremLabel = {
  formalized_proved: "形式化已证明",
  refuted: "原命题否定已证明",
  unknown: "未知",
  semantic_review_required: "尚未判断",
};

export function ReviewPanel({
  paper,
  pageIndex,
  initialQuote = "",
  onLocate,
  onEvidence,
  requestedRunId,
  parentRunId,
  onSelectRun,
  onAddToScope,
  entryDraft,
  originEntryId,
  onClearEntry,
  onStarted,
  onNewReview,
  showHistory = true,
  acknowledgedRoot,
  onFinished,
}) {
  const [service, setService] = useState(null),
    [run, setRun] = useState(null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [manual, setManual] = useState(!!entryDraft);
  const [details, setDetails] = useState(false),
    [replay, setReplay] = useState(null);
  const [history, setHistory] = useState([]),
    [manualPage, setManualPage] = useState(entryDraft?.pageIndex ?? pageIndex),
    [manualQuote, setManualQuote] = useState(entryDraft?.quote || initialQuote);
  const [profileId, setProfileId] = useState(
    entryDraft?.target?.libraryProfile || paper.libraryProfile || "std-v1",
  );
  const [manualModelProof, setManualModelProof] = useState(false);
  const [supplements, setSupplements] = useState([]);
  const [seedProof, setSeedProof] = useState(""),
    [seedMode, setSeedMode] = useState("proof");
  const supplementPicker = (
    <details className="model-settings">
      <summary>补充 LaTeX 源、定义或引用原文（可选）</summary>
      <p className="muted">
        补充材料只作为待核对文字，不执行其中的指令。最多四份，合计 24000 字符。
      </p>
      <input
        type="file"
        accept=".tex,.txt,.md"
        multiple
        aria-label="补充论文材料"
        onChange={async (event) => {
          try {
            const files = Array.from(event.target.files || []);
            if (files.length > 4 || files.some((f) => f.size > 100000))
              throw new Error("材料最多四份，每份文件不超过 100 KB。");
            const values = await Promise.all(
              files.map(async (f) => ({ name: f.name, text: await f.text() })),
            );
            if (values.reduce((s, f) => s + f.text.length, 0) > 24000)
              throw new Error("补充材料合计超过 24000 字符。");
            setSupplements(values);
            setError("");
          } catch (e) {
            setError(e.message);
            setSupplements([]);
            event.target.value = "";
          }
        }}
      />
      {supplements.map((s) => (
        <p key={s.name}>
          {s.name} · {s.text.length} 字符
        </p>
      ))}
    </details>
  );
  const chosenProfile = libraryProfile(profileId);
  const profilePicker = (
    <label className="library-choice">
      数学库与检查范围
      <select
        aria-label="数学库与检查范围"
        aria-describedby="library-scope-description"
        value={profileId}
        onChange={(e) => setProfileId(e.target.value)}
      >
        {LIBRARY_PROFILES.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <small id="library-scope-description">{chosenProfile.scope}</small>
    </label>
  );
  async function connect() {
    try {
      setService(await request("/api/status"));
      setError("");
    } catch {
      setError("本机评审服务尚未连接。阅读和人工批注仍可使用。");
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    request("/api/status", undefined, controller.signal)
      .then(setService)
      .catch((e) => {
        if (!controller.signal.aborted) setError("本机评审服务尚未连接。");
      });
    if (entryDraft) return () => controller.abort();
    Promise.resolve(requestedRunId || reviewRunFor(paper.id))
      .then(
        (id) =>
          id && request(`/api/reviews/${id}`, undefined, controller.signal),
      )
      .then((value) => {
        if (
          value &&
          !controller.signal.aborted &&
          value.paperSha256 === paper.id
        ) {
          setRun(value);
          if (requestedRunId)
            void rememberReview(paper.id, parentRunId || value.id).catch(() => {
              if (!controller.signal.aborted)
                setError("评审已打开，但浏览器恢复索引未保存。");
            });
          if (value.contract)
            onLocate(value.contract.pageIndex, value.contract.quote);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("上次评审记录暂时不可读取，可重新连接本机服务。");
      });
    return () => controller.abort();
  }, [paper.id, requestedRunId, entryDraft?.id]);
  useEffect(() => {
    if (!active(run) && run?.proofIndexStatus !== "building") return;
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      try {
        const value = await request(
          `/api/reviews/${run.id}`,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setRun(value);
        if (active(value) || value.proofIndexStatus === "building")
          timer = setTimeout(poll, 1500);
      } catch {
        if (!controller.signal.aborted)
          setError(
            "执行状态暂时不可读取；不会自动重新提交任务。请重新连接后查看。",
          );
      }
    };
    timer = setTimeout(poll, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [run?.id, run?.status, run?.proofIndexStatus, service]);
  useEffect(() => {
    const controller = new AbortController();
    request(`/api/reviews?paper=${paper.id}`, undefined, controller.signal)
      .then((value) => setHistory(value.items))
      .catch(() => {});
    return () => controller.abort();
  }, [paper.id, run?.id, run?.status, service]);

  async function act(name, action) {
    if (busy) return;
    setBusy(name);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  async function start(mode, proposal, scopePage = pageIndex) {
    const result = await request("/api/reviews", {
      pdfBase64: await base64(paper.bytes),
      paperSha256: paper.id,
      pageIndex: scopePage,
      mode,
      libraryProfile: profileId,
      supplements,
      proofStrategy: mode === "model" || manualModelProof ? "model" : "manual",
      ...((mode === "model" || manualModelProof) && seedProof.trim()
        ? { seedProof: { proof: seedProof, mode: seedMode } }
        : {}),
      ...(proposal ? { proposal } : {}),
    });
    setRun(result);
    onSelectRun?.(result.id);
    onStarted?.(result.id);
    try {
      await rememberReview(paper.id, parentRunId || result.id);
    } catch {
      setError(`任务已创建，但浏览器索引未保存。任务编号：${result.id}`);
    }
    setConfirmed(false);
    setReplay(null);
    setManual(false);
  }
  function submitManual(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    void act("建立目标", () =>
      start(
        "manual",
        {
          label: String(form.get("label")),
          quote: String(form.get("quote")),
          statement: String(form.get("statement")),
          assumptions: String(form.get("assumptions"))
            .split("\n")
            .filter((s) => s.trim()),
          leanTarget: String(form.get("target")),
          ambiguity: "人工提交；必须核对 PDF 原始排版与量词。",
        },
        manualPage,
      ),
    );
  }
  function approve(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    void act("开始核验", async () => {
      const value = await request(`/api/reviews/${run.id}/approve`, {
        targetHash: run.contract.targetHash,
        confirmed,
        ...(run.semanticReview
          ? {
              semanticArtifact: run.semanticArtifact,
              resolutions: run.semanticReview.issues.map((issue) => ({
                issueId: issue.id,
                decision: "confirmed_with_reason",
                reason: String(form.get(`resolution_${issue.id}`) || ""),
              })),
            }
          : {}),
        ...((run.proofStrategy || run.mode) === "manual"
          ? {
              proof: String(form.get("proof")),
              proofMode: String(form.get("proofMode")),
            }
          : {}),
      });
      setRun(value);
    });
  }
  const result = run?.conclusion;
  const title = active(run)
    ? run.status === "preparing"
      ? "正在固定原文与目标"
      : "正在审计与核验"
    : run?.status === "awaiting_confirmation"
      ? run.semanticPolicy === "agent"
        ? "正在自动复核命题"
        : "先确认命题，再执行核验"
      : run?.status === "cancelled"
        ? "本次评审已取消"
        : run?.status === "blocked"
          ? "评审受阻，尚无判定"
          : run?.status === "interrupted"
            ? "上次执行已中断，尚无判定"
            : result?.headline || "尚未进行机器评审";

  if (
    onFinished &&
    terminalRun(run) &&
    run.root &&
    (!run.root || run.root !== acknowledgedRoot)
  ) {
    return (
      <section className="review-ready">
        <h3>
          {reviewCompletion(run).reviewComplete
            ? "本次范围核查已完成"
            : "本次核查未完成，部分结果已保存"}
        </h3>
        <p>回到阅读器后，确认查看结论和批注。</p>
        <button className="button primary" onClick={() => onFinished(run.id)}>
          返回阅读器
        </button>
      </section>
    );
  }
  return (
    <div className="review-content">
      <OriginalProofDetails
        route={run?.originalProofRoute}
        onEvidence={onEvidence}
        tasks={[...(run?.inheritedHarnessTasks || []), ...(run?.tasks || [])]}
        onLocate={onLocate}
      />
      <section
        className={`conclusion-card ${result?.theorem === "formalized_proved" ? "verified" : result?.theorem === "refuted" ? "refuted" : ""}`}
        aria-live="polite"
      >
        <p className="scope-label">
          {run?.contract
            ? `${run.contract.label} · 第 ${run.contract.pageIndex + 1} 页 · 单条命题`
            : `第 ${(run?.pageIndex ?? pageIndex) + 1} 页 · 待选择命题`}
        </p>
        <h3>{title}</h3>
        <p className="scope-caveat">
          {active(run)
            ? "执行中的任务不会计为验证通过。"
            : "本次只检查选定命题，不能据此评价整篇论文。"}
        </p>
        {run?.contract && (
          <p className="scope-library">
            {profileForContract(run.contract).label}
          </p>
        )}
        <dl className="conclusion-dimensions">
          <div>
            <dt>原文一致性</dt>
            <dd>
              {(run?.approval?.authority ===
              "autonomous_agent_semantic_assessment_not_human"
                ? "Agent 已复核"
                : semanticLabel[result?.semantic]) ||
                (run?.approval ? "人工已确认" : "待确认")}
            </dd>
          </div>
          <div>
            <dt>原证明</dt>
            <dd>
              {run?.originalProofRoute?.summary?.headline ||
                (result?.originalProof === "gap_candidate"
                  ? "疑点待复核"
                  : "未核验")}
            </dd>
          </div>
          <div>
            <dt>定理结论</dt>
            <dd>{theoremLabel[result?.theorem] || "尚未判断"}</dd>
          </div>
        </dl>
      </section>
      {error && (
        <p className="review-error" role="alert">
          <WarningCircle size={16} />
          {error}
        </p>
      )}
      {run?.error && (
        <p className="review-error">
          <WarningCircle size={16} />
          {run.error}
        </p>
      )}
      {run?.mode === "model" &&
        ["lemma.contract.v3", "lemma.contract.v4"].includes(
          run?.contract?.schemaVersion,
        ) &&
        !run.approval &&
        ["blocked", "awaiting_confirmation"].includes(run.status) && (
          <button
            type="button"
            className="button outline full"
            disabled={!!busy}
            onClick={() =>
              act("继续复核翻译", async () => {
                const next = await request(
                  `/api/reviews/${run.id}/retry-translation`,
                  {},
                );
                setRun(next);
                setConfirmed(false);
                setReplay(null);
                onSelectRun?.(next.id);
                await rememberReview(paper.id, parentRunId || next.id);
              })
            }
          >
            继续复核已固定的翻译
          </button>
        )}

      {!run && !manual && (
        <div className="review-start">
          {profilePicker}
          {supplementPicker}
          {!service?.model.configured && (
            <button
              className="button outline"
              disabled={!!busy}
              onClick={() => act("连接", connect)}
            >
              重新连接
            </button>
          )}
          <button
            className="advanced-entry"
            onClick={() => {
              setManualPage(pageIndex);
              setManualQuote(initialQuote);
              setManual(true);
            }}
          >
            高级：人工提交形式化目标
          </button>
        </div>
      )}

      {manual && (
        <form className="review-form" onSubmit={submitManual}>
          <h4>人工提交目标 · 第 {manualPage + 1} 页</h4>
          {profilePicker}
          {supplementPicker}
          <label>
            命题编号
            <input
              name="label"
              required
              maxLength={120}
              placeholder="如 Theorem 1"
              defaultValue={entryDraft?.label}
            />
          </label>
          <label>
            原文引句
            <textarea
              name="quote"
              required
              rows={3}
              maxLength={5000}
              defaultValue={manualQuote}
              placeholder="复制当前页中能够唯一定位的命题原文"
            />
          </label>
          <label>
            命题中文表述
            <textarea
              name="statement"
              required
              rows={2}
              maxLength={5000}
              defaultValue={entryDraft?.statement}
            />
          </label>
          <label>
            原有前提（每行一条）
            <textarea
              name="assumptions"
              rows={2}
              placeholder="不要补充论文没有的假设"
              defaultValue={entryDraft?.target?.assumptions.join("\n")}
            />
          </label>
          <label>
            Lean 目标
            <textarea
              name="target"
              required
              rows={3}
              maxLength={12000}
              spellCheck={false}
              placeholder={`完整 Prop 表达式；依赖 ${chosenProfile.label}`}
              defaultValue={entryDraft?.target?.leanTarget}
            />
          </label>
          <label className="confirmation-label">
            <input
              type="checkbox"
              checked={manualModelProof}
              onChange={(event) => setManualModelProof(event.target.checked)}
              disabled={!service?.model.configured}
            />
            目标由我提供，证明交给模型构造与修复
          </label>
          {manualModelProof && (
            <label>
              已有证明的核验方向
              <select
                value={seedMode}
                onChange={(e) => setSeedMode(e.target.value)}
              >
                <option value="proof">证明原命题</option>
                <option value="counterexample">证明原命题的否定</option>
              </select>
            </label>
          )}
          {manualModelProof && (
            <label>
              初始 Lean 证明（可选，失败后尝试修复）
              <textarea
                value={seedProof}
                onChange={(e) => setSeedProof(e.target.value)}
                maxLength={24000}
                rows={3}
                placeholder="留空则由模型从头构造；也可填 by …"
              />
            </label>
          )}
          <div className="review-actions">
            <button className="button primary" disabled={!!busy}>
              固定目标
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setManual(false)}
            >
              返回
            </button>
          </div>
        </form>
      )}

      {run?.contextArtifact && (
        <DomainRecovery
          key={run.id}
          run={run}
          busy={busy}
          modelConfigured={service?.model.configured}
          onLocate={onLocate}
          onStart={(input) =>
            act("领域补全", async () => {
              const payload =
                input.planText !== undefined
                  ? { mode: input.mode, plan: JSON.parse(input.planText) }
                  : input;
              const next = await request(
                `/api/reviews/${run.id}/recover-domain`,
                payload,
              );
              setRun(next);
              setConfirmed(false);
              setReplay(null);
              setManual(false);
              onSelectRun?.(next.id);
              await rememberReview(paper.id, parentRunId || next.id);
            })
          }
        />
      )}
      {run?.contract && (
        <section className="review-source">
          <h4>对应原文</h4>
          <blockquote>{run.contract.quote}</blockquote>
          <button
            className="source-locate"
            onClick={() => onLocate(run.contract.pageIndex, run.contract.quote)}
          >
            <FileText size={17} />第 {run.contract.pageIndex + 1} 页 · 定位原文
            <ArrowUpRight size={15} />
          </button>
        </section>
      )}

      {run?.semanticReview && (
        <TranslationReview run={run} onLocate={onLocate} />
      )}
      {!!run?.pendingObligations?.length && (
        <section className="capability-section">
          <h4>待补定义与证明义务</h4>
          <p>
            发现 {run.pendingObligations.length}{" "}
            项需要补齐的材料或条件。登记后仍为未核验。
          </p>
          {onAddToScope && (
            <button
              type="button"
              className="button outline"
              onClick={() => onAddToScope(run.id)}
            >
              在核查覆盖中登记
            </button>
          )}
        </section>
      )}

      {run?.status === "awaiting_confirmation" &&
        run.semanticPolicy !== "agent" && (
          <form className="review-form" onSubmit={approve}>
            <h4>固定目标</h4>
            <p className="muted">
              翻译来源：{run.mode === "manual" ? "人工提交" : "模型提取与复核"}
              ；证明构造：
              {(run.proofStrategy || run.mode) === "model"
                ? "模型候选，交由 Lean 检查"
                : "人工提交，交由 Lean 检查"}
              。
            </p>
            <p>{run.contract.statement}</p>
            {run.contract.assumptions.length > 0 && (
              <ul>
                {run.contract.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            )}
            {run.contract.ambiguity && (
              <p className="review-warning">待留意：{run.contract.ambiguity}</p>
            )}
            <div className="target-expression">
              <span>形式化命题</span>
              <pre>{run.contract.leanTarget}</pre>
            </div>
            <details>
              <summary>目标版本与信任基础</summary>
              <code>目标 {run.contract.targetHash}</code>
              <p>
                {profileForContract(run.contract).label} ·{" "}
                {profileForContract(run.contract).scope}
              </p>
              <code>
                库版本 {profileForContract(run.contract).revision}
                <br />
                导入 {run.contract.imports.join(", ")}
              </code>
            </details>
            {(run.proofStrategy || run.mode) === "manual" && (
              <>
                <label>
                  核验路线
                  <select name="proofMode">
                    <option value="proof">证明原命题</option>
                    <option value="counterexample">证明原命题的否定</option>
                  </select>
                </label>
                <label>
                  Lean 证明项
                  <textarea
                    name="proof"
                    required
                    rows={5}
                    maxLength={24000}
                    spellCheck={false}
                    placeholder="by …；不支持 sorry、额外公理或元编程"
                  />
                </label>
              </>
            )}
            <label className="confirmation-label">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              我已对照原文，核对前提、定义域和量词，确认此目标对应原命题。
            </label>
            <ResolutionFields review={run.semanticReview} />
            <button
              className="button primary full"
              disabled={
                !confirmed ||
                !!busy ||
                run.semanticReview?.issues.some(
                  (i) => i.sourceEvidenceRequired,
                ) ||
                (run.semanticReview?.targetCheck &&
                  run.semanticReview.targetCheck.status !== "well_typed")
              }
            >
              确认目标并核验 <ArrowRight size={18} />
            </button>
            <button
              type="button"
              className="advanced-entry"
              disabled={!!busy}
              onClick={() => {
                setRun(null);
                setConfirmed(false);
              }}
            >
              存在歧义，重新建立目标
            </button>
          </form>
        )}

      {run && <RepairHistory run={run} />}

      {active(run) && (
        <button
          className="button outline full"
          disabled={!!busy}
          onClick={() =>
            act("取消", async () => {
              await request(`/api/reviews/${run.id}/cancel`, {});
              setRun(await request(`/api/reviews/${run.id}`));
            })
          }
        >
          取消本次执行
        </button>
      )}

      {run?.root && (
        <section className="report-evidence">
          <div className="review-actions">
            <a
              className="button primary"
              href={`/api/reviews/${run.id}/bundle?format=ndjson`}
              download
            >
              <DownloadSimple size={17} />
              导出复现包
            </a>
            <button
              className="button outline"
              disabled={!!busy || !run.check}
              onClick={() =>
                act("复现", async () => {
                  setReplay(await request(`/api/reviews/${run.id}/replay`, {}));
                })
              }
            >
              {busy === "复现" ? "复现中…" : "复现检查"}
            </button>
          </div>
          {run.check && onAddToScope && (
            <button
              className="advanced-entry"
              onClick={() => onAddToScope(run.id)}
            >
              {originEntryId ? "关联回当前义务" : "登记到评审范围"}
            </button>
          )}
          <button
            className="advanced-entry"
            onClick={() => setDetails(!details)}
            aria-expanded={details}
          >
            {details ? "收起依据" : "查看检查依据与未完成项"}
          </button>
          {details && (
            <div className="check-details">
              <p>{run.check?.reason || "没有完成机器检查。"}</p>
              <p>{result?.caveat || "这是受阻记录，没有定理结论。"}</p>
              {run.originalProof?.explanation && (
                <p>原证明候选审计：{run.originalProof.explanation}</p>
              )}
              <p>
                检查输出的公理依赖：
                {run.check?.axioms?.length
                  ? run.check.axioms.join(", ")
                  : run.check?.status === "verified"
                    ? "无"
                    : "未取得审计结果"}
              </p>
              {run.check?.axioms?.some(
                (a) => !run.contract.allowedAxioms.includes(a),
              ) && (
                <p className="review-warning">
                  含未获准公理，不能作为已完成的证明。
                </p>
              )}
              {run.check?.source && (
                <details>
                  <summary>检查源码</summary>
                  <pre>{run.check.source}</pre>
                </details>
              )}
              {run.check?.stdout && (
                <details>
                  <summary>原始检查输出</summary>
                  <pre>{run.check.stdout}</pre>
                </details>
              )}
              <code>
                PDF {paper.id}
                <br />
                目标 {run.contract?.targetHash}
                <br />
                证据根 {run.root}
                <br />
                库内容{" "}
                {run.check?.environment?.library?.content?.sha256 ||
                  "见声明的基础工具链"}
              </code>
              <p className="muted">
                复现包包含原
                PDF、目标、人工确认记录、模型输入输出（如有）和检查产物。摘要证明版本关联，不证明来源或确认者身份。模型输出只归档，不保证再次生成相同内容。
              </p>
            </div>
          )}
          {replay && (
            <p
              className={replay.reproduced ? "replay-result" : "review-warning"}
              role="status"
            >
              {replay.reproduced ? (
                <CheckCircle size={17} />
              ) : (
                <WarningCircle size={17} />
              )}
              {replay.reproduced
                ? "已在新目录重跑，目标与机器结论一致。"
                : replay.revalidated
                  ? "已重新核验，但执行器版本不同，不能标为同环境复现。"
                  : "未完成复现，不能据此宣布原结论可靠。"}
            </p>
          )}
        </section>
      )}
      {showHistory && history.length > 0 && (
        <details className="review-history">
          <summary>历史评审 · {history.length} 条近期记录</summary>
          {history.map((item) => (
            <button
              className="history-row"
              key={item.id}
              disabled={active(run) || !!busy}
              onClick={() =>
                act("读取历史", async () => {
                  const value = await request(`/api/reviews/${item.id}`);
                  if (value.paperSha256 !== paper.id)
                    throw new Error("历史评审不属于当前文件版本。");
                  setRun(value);
                  onClearEntry?.();
                  onSelectRun?.(value.id);
                  setConfirmed(false);
                  setReplay(null);
                  await rememberReview(paper.id, parentRunId || value.id);
                  if (value.contract)
                    onLocate(value.contract.pageIndex, value.contract.quote);
                })
              }
            >
              <strong>
                {item.label} · 第 {item.pageIndex + 1} 页
              </strong>
              <small>
                {item.headline || item.status} ·{" "}
                {new Date(item.createdAt).toLocaleString()}
              </small>
            </button>
          ))}
        </details>
      )}
      {run && !active(run) && run.status !== "awaiting_confirmation" && (
        <button
          className="advanced-entry"
          onClick={() => {
            if (onNewReview) {
              onNewReview();
              return;
            }
            setRun(null);
            onClearEntry?.();
            setConfirmed(false);
            setDetails(false);
            setReplay(null);
          }}
        >
          开始新的评审
        </button>
      )}
    </div>
  );
}
