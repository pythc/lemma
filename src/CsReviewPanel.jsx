import { useState } from "react";
import { LIBRARY_PROFILES } from "../shared/library-profiles.mjs";
import {
  KIND_LABELS,
  OUTCOME_LABELS,
} from "../shared/cs-track.mjs";

const PROVERS = [
  ["coq", "Coq / Rocq"],
  ["isabelle", "Isabelle"],
  ["agda", "Agda"],
  ["fstar", "F*"],
  ["tla", "TLA+"],
  ["easycrypt", "EasyCrypt"],
  ["dafny", "Dafny"],
];

const EMPTY = {
  kind: "prose_proof",
  label: "",
  statement: "",
  code: "",
  expected: "",
  profileId: "std-v1",
  quote: "",
  leanTarget: "",
  proof: "",
  prover: "coq",
  source: "",
  config: "",
  bound: "3",
  files: [],
  tolerance: "",
  artifactPresent: false,
  environment: "gpu",
};

export function CsReviewPanel({
  run,
  busy,
  proposing = false,
  candidates = [],
  candidateNotice = "",
  onSubmit,
  onReveal,
  onReplay,
  onPropose,
}) {
  const [draft, setDraft] = useState(EMPTY);
  const set = (key) => (event) =>
    setDraft((current) => ({
      ...current,
      [key]:
        event.target.type === "checkbox"
          ? event.target.checked
          : event.target.value,
    }));
  function adopt(candidate) {
    setDraft((current) => ({
      ...current,
      statement: candidate.sentence,
      quote:
        current.kind === "math" || current.kind === "mechanized_artifact"
          ? candidate.sentence
          : "",
      expected: current.kind === "computation" ? candidate.sentence : "",
      code: "",
      proof: "",
      source: "",
      leanTarget: "",
      config: "",
      files: [],
      tolerance: "",
    }));
  }
  function submit(event) {
    event.preventDefault();
    const claim = {
      kind: draft.kind,
      label: draft.label,
      statement: draft.statement,
    };
    if (draft.kind === "computation") {
      claim.code = draft.code;
      claim.expected = draft.expected;
      claim.command = "python3 experiment.py";
      const tolerance = String(draft.tolerance || "").trim();
      if (tolerance) claim.tolerance = Number(tolerance);
      const files = draft.files.filter((file) => file.name.trim() || file.content);
      if (files.length) claim.files = files;
    }
    if (draft.kind === "math") {
      claim.profileId = draft.profileId;
      claim.quote = draft.quote;
      claim.leanTarget = draft.leanTarget;
      claim.proof = draft.proof;
    }
    if (draft.kind === "mechanized_artifact") {
      claim.prover = draft.prover;
      if (draft.prover === "coq" || draft.prover === "rocq") {
        claim.quote = draft.quote;
        claim.source = draft.source;
        claim.artifactPresent = true;
      } else if (draft.prover === "tla") {
        claim.quote = draft.quote;
        claim.source = draft.source;
        claim.config = draft.config;
        claim.bound = Number(draft.bound);
        claim.artifactPresent = true;
      } else claim.artifactPresent = draft.artifactPresent;
    }
    if (draft.kind === "other") claim.environment = draft.environment;
    onSubmit([claim]);
  }
  return (
    <section className="cs-panel" aria-label="计算机论文评审">
      <h2>计算机论文</h2>
      <p>
        对照值、散文原句和证明对应的定理句都必须在原文里只出现一次。数字要整段出现，不能从 20 里截出 2。多个对照值逐行比较，对不上会留下每一行。TLA+ 只仿真一条给定深度的行为。离线重放使用已归档的程序、文件和证明。
      </p>
      <div className="cs-actions">
        <button
          className="button outline"
          type="button"
          disabled={busy || proposing}
          onClick={onPropose}
        >
          {proposing ? "正在提出候选…" : "从论文提出候选"}
        </button>
      </div>
      {(candidateNotice || candidates.length > 0) && (
        <section className="cs-candidate-block" aria-label="原文候选">
          {candidateNotice && (
            <p className="cs-candidate-notice">{candidateNotice}</p>
          )}
          {candidates.length > 0 && (
        <ul className="cs-claims cs-candidates">
          {candidates.map((candidate) => (
            <li key={candidate.id}>
              <strong>原文候选</strong>
              <p>{candidate.sentence || "没有原句"}</p>
              <p>
                {candidate.status === "candidate"
                  ? "原句已定位。选定种类并提交之后才会检查。"
                  : candidate.reason}
              </p>
              {candidate.status === "candidate" && (
                <button
                  className="button subtle"
                  type="button"
                  onClick={() => adopt(candidate)}
                >
                  放入表单
                </button>
              )}
            </li>
          ))}
        </ul>
          )}
        </section>
      )}
      {run?.csClaims?.length ? (
        <CsClaimList claims={run.csClaims} />
      ) : (
        <p className="muted">
          {run ? "正在检查这条主张。" : "选择一条主张后再开始。"}
        </p>
      )}
      {run?.root && (
        <div className="cs-actions">
          <button className="button primary" onClick={onReveal}>
            确定，查看结果
          </button>
          <button className="button outline" type="button" disabled={busy} onClick={onReplay}>
            离线重放
          </button>
        </div>
      )}
      <form onSubmit={submit}>
        <label>
          主张种类
          <select aria-label="主张种类" value={draft.kind} onChange={set("kind")}>
            {Object.entries(KIND_LABELS)
              .filter(([id]) => id !== "unknown")
              .map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
          </select>
        </label>
        <label>
          名称
          <input
            aria-label="主张名称"
            value={draft.label}
            onChange={set("label")}
            maxLength={120}
          />
        </label>
        <label>
          {draft.kind === "prose_proof" ? "论文中的原句" : "表述"}
          <textarea
            aria-label="主张表述"
            value={draft.statement}
            onChange={set("statement")}
            required
            maxLength={2000}
          />
        </label>
        {draft.kind === "computation" && (
          <>
            <label>
              Python 代码
              <textarea
                aria-label="Python 代码"
                value={draft.code}
                onChange={set("code")}
                required
              />
            </label>
            <label>
              论文中的对照原文
              <textarea
                aria-label="对照输出"
                value={draft.expected}
                onChange={set("expected")}
                required
                placeholder="每行一个对照值"
              />
            </label>
            <label>
              数值容差
              <input
                aria-label="数值容差"
                value={draft.tolerance || ""}
                onChange={set("tolerance")}
                inputMode="decimal"
                placeholder="留空则必须逐字相同"
              />
            </label>
            {draft.files.map((file, index) => (
              <div key={index} className="cs-file">
                <label>
                  附加文件名
                  <input
                    aria-label={`附加文件名 ${index + 1}`}
                    value={file.name}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        files: current.files.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, name: event.target.value }
                            : item,
                        ),
                      }))
                    }
                  />
                </label>
                <label>
                  附加文件内容
                  <textarea
                    aria-label={`附加文件内容 ${index + 1}`}
                    value={file.content}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        files: current.files.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, content: event.target.value }
                            : item,
                        ),
                      }))
                    }
                  />
                </label>
                <button
                  className="button subtle"
                  type="button"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      files: current.files.filter((_, itemIndex) => itemIndex !== index),
                    }))
                  }
                >
                  移除这个文件
                </button>
              </div>
            ))}
            <button
              className="button subtle"
              type="button"
              disabled={draft.files.length >= 6}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  files: [...current.files, { name: "", content: "" }],
                }))
              }
            >
              添加文件
            </button>
            <p>重放命令：python3 experiment.py</p>
          </>
        )}
        {draft.kind === "math" && (
          <>
            <label>
              数学库配置
              <select
                aria-label="数学库配置"
                value={draft.profileId}
                onChange={set("profileId")}
              >
                {LIBRARY_PROFILES.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              原文引句
              <textarea
                aria-label="原文引句"
                value={draft.quote}
                onChange={set("quote")}
                required
              />
            </label>
            <label>
              Lean 目标
              <textarea
                aria-label="Lean 目标"
                value={draft.leanTarget}
                onChange={set("leanTarget")}
                required
              />
            </label>
            <label>
              Lean 证明
              <textarea
                aria-label="Lean 证明"
                value={draft.proof}
                onChange={set("proof")}
                required
              />
            </label>
          </>
        )}
        {draft.kind === "mechanized_artifact" && (
          <>
            <label>
              证明器
              <select aria-label="证明器" value={draft.prover} onChange={set("prover")}>
                {PROVERS.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {(draft.prover === "coq" || draft.prover === "rocq") && (
              <>
                <label>
                  论文中的定理句
                  <textarea
                    aria-label="论文中的定理句"
                    value={draft.quote}
                    onChange={set("quote")}
                    required
                  />
                </label>
                <label>
                  Rocq 源码
                  <textarea
                    aria-label="Rocq 源码"
                    value={draft.source}
                    onChange={set("source")}
                    required
                  />
                </label>
              </>
            )}
            {draft.prover === "tla" && (
              <>
                <label>
                  论文中的定理句
                  <textarea
                    aria-label="论文中的定理句"
                    value={draft.quote}
                    onChange={set("quote")}
                    required
                  />
                </label>
                <label>
                  TLA+ 规格
                  <textarea
                    aria-label="TLA+ 规格"
                    value={draft.source}
                    onChange={set("source")}
                    required
                    placeholder="模块名必须是 Paper"
                  />
                </label>
                <label>
                  TLC 配置
                  <textarea
                    aria-label="TLC 配置"
                    value={draft.config}
                    onChange={set("config")}
                    required
                  />
                </label>
                <label>
                  搜索界
                  <input
                    aria-label="搜索界"
                    value={draft.bound}
                    onChange={set("bound")}
                    inputMode="numeric"
                    required
                  />
                </label>
                <p>
                  按这个深度仿真一条行为。走到无法继续时会记下这条行为，不把它当成没有错误。其余行为和更深处不检查，完成也不等于证明。
                </p>
              </>
            )}
            {draft.prover !== "coq" &&
              draft.prover !== "rocq" &&
              draft.prover !== "tla" && (
              <p>这个证明器尚未接入，提交后不会运行。</p>
            )}
          </>
        )}
        {draft.kind === "other" && (
          <label>
            实验环境
            <select
              aria-label="实验环境"
              value={draft.environment}
              onChange={set("environment")}
            >
              <option value="gpu">GPU 训练</option>
              <option value="cluster">集群或长实验</option>
              <option value="exploit">漏洞利用</option>
            </select>
          </label>
        )}
        <div className="cs-actions">
          <button className="button primary" disabled={busy || proposing}>
            {busy ? "正在检查…" : "检查这条主张"}
          </button>
          <button
            className="button outline"
            type="button"
            disabled={busy || proposing}
            onClick={() => onSubmit([])}
          >
            只登记这篇论文
          </button>
          {run && (
            <button className="button subtle" type="button" onClick={onReplay}>
              离线重放当前记录
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

export function CsClaimList({ claims }) {
  return (
    <ul className="cs-claims">
      {claims.map((claim) => (
        <li key={claim.id}>
          <strong>{claim.label}</strong>
          <p>{claim.statement}</p>
          <dl>
            <div>
              <dt>检查方式</dt>
              <dd>{KIND_LABELS[claim.kind] || claim.kind}</dd>
            </div>
            <div>
              <dt>机器结果</dt>
              <dd>{OUTCOME_LABELS[claim.outcome] || claim.outcome}</dd>
            </div>
          </dl>
          <p>{claim.reason}</p>
          {claim.execution?.kind === "computation" && (
            <p>
              命令 {claim.execution.command || "python3 experiment.py"}
              {claim.execution.files?.length
                ? `。归档文件 ${claim.execution.files.map((file) => file.name).join("、")}，这些文件没有单独核对。`
                : "。"}
            </p>
          )}
          {claim.comparisons?.length > 0 && (
            <ol className="cs-comparisons">
              {claim.comparisons.map((row, index) => (
                <li key={index}>
                  {!row.expected && row.actual === ""
                    ? "不符：多出一行空行"
                    : `${
                        row.toleranceUsed
                          ? `容差 ${claim.execution?.tolerance} 内`
                          : row.matched
                            ? "一致"
                            : "不符"
                      }：原文「${row.expected}」，输出「${row.actual}」`}
                </li>
              ))}
            </ol>
          )}
          {claim.columns && (
            <dl>
              <div>
                <dt>重放命令</dt>
                <dd>{claim.columns.make}</dd>
              </div>
              <div>
                <dt>{claim.columns.bound ? "搜索界" : "公理与 admit"}</dt>
                <dd>{claim.columns.bound || claim.columns.axioms}</dd>
              </div>
              <div>
                <dt>定位到的原句</dt>
                <dd>{claim.columns.correspondence}</dd>
              </div>
              {claim.columns.trace && (
                <div>
                  <dt>
                    {claim.outcome === "execution_failed"
                      ? "异常前的状态"
                      : "界内行为"}
                  </dt>
                  <dd className="cs-trace">{claim.columns.trace}</dd>
                </div>
              )}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );
}

export function CsReviewSummary({ run, onReplay, busy }) {
  const conclusion = run.conclusion || {};
  return (
    <section className="result-summary" aria-label="计算机评审记录">
      <h2>{conclusion.headline || "计算机评审记录已保存"}</h2>
      <p className="result-scope">
        {conclusion.notice ||
          "整篇论文没有验证结论。下面只列出每条主张自己的检查结果。"}
      </p>
      <CsClaimList claims={run.csClaims || []} />
      {run.root && onReplay && (
        <button className="button outline" type="button" disabled={busy} onClick={onReplay}>
          离线重放
        </button>
      )}
    </section>
  );
}
