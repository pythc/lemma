import { useEffect, useState } from "react";
import {
  CaretDown,
  ChatCircleText,
  FileText,
  ArrowUpRight,
  Sparkle,
  X,
  GitBranch,
  CheckCircle,
} from "@phosphor-icons/react";
import { annotationComments, appendAnnotationComment } from "./storage.js";
import { brief } from "./reader-model.js";

function Comments({ paperId, noteId }) {
  const [comments, setComments] = useState([]),
    [text, setText] = useState("");
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    annotationComments(paperId, noteId)
      .then((v) => {
        if (alive) setComments(v);
      })
      .catch(() => {
        if (alive) setError("评论暂时无法读取。");
      });
    return () => {
      alive = false;
    };
  }, [paperId, noteId]);
  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      setComments(await appendAnnotationComment(paperId, noteId, text));
      setText("");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="annotation-comments">
      <h4>
        <ChatCircleText size={16} />
        讨论 <span>{comments.length}</span>
      </h4>
      {comments.map((c) => (
        <div className="reader-comment" key={c.id}>
          <strong>
            我{" "}
            <time>
              {new Date(c.createdAt).toLocaleString("zh-CN", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </strong>
          <p>{c.body}</p>
        </div>
      ))}
      <form onSubmit={submit}>
        <textarea
          aria-label="添加评论"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="补充想法，或指出需要澄清的地方…"
          maxLength={5000}
          rows={2}
        />
        <button className="button outline" disabled={saving || !text.trim()}>
          {saving ? "保存中…" : "添加评论"}
        </button>
      </form>
      {error && (
        <p role="alert" className="reader-inline-error">
          {error}
        </p>
      )}
    </section>
  );
}

export function AnnotationCard({
  paper,
  note,
  open,
  onSelect,
  onClose,
  onAsk,
  onReview,
  onEvidence,
  onTask,
  onOpenRun,
  onMark,
}) {
  return (
    <article
      className={`reader-note ${open ? "expanded" : ""} ${note.kind}`}
      key={note.id}
    >
      <button
        className="reader-note-summary"
        aria-expanded={open}
        aria-controls={`note-detail-${note.id}`}
        aria-label={`${open ? "收起" : "展开"}批注：${note.summary || brief(note.body || note.title)}`}
        onClick={() => (open ? onClose() : onSelect(note.id))}
      >
        <ChatCircleText
          size={15}
          className={`note-author-icon ${note.origin}`}
        />
        <span className="reader-note-preview">
          <strong>
            {note.origin === "human"
              ? "我"
              : note.origin === "demo"
                ? "教学示例"
                : "AI 评审"}
          </strong>
          <span className="reader-note-excerpt">
            {note.summary || brief(note.body || note.title)}
          </span>
        </span>
        <CaretDown size={13} className={open ? "flipped" : ""} />
      </button>
      {open && (
        <div className="reader-note-detail" id={`note-detail-${note.id}`}>
          <div className="reader-note-meta">
            <span>第 {note.anchor.pageIndex + 1} 页</span>
            {note.status === "human_reviewed" && <CheckCircle size={13} />}
            <button className="note-collapse" onClick={onClose}>
              收起批注
            </button>
          </div>
          <h3>{note.title}</h3>
          <p className="note-long-text">{note.body}</p>
          <button className="note-source" onClick={() => onSelect(note.id)}>
            <FileText size={15} />
            <span>{note.anchor.quote || "框选区域 · 暂无文字"}</span>
            <ArrowUpRight size={15} />
          </button>
          {note.dimensions && (
            <dl className="annotation-dimensions">
              <div>
                <dt>原文一致性</dt>
                <dd>{note.dimensions.semantic}</dd>
              </div>
              <div>
                <dt>原证明</dt>
                <dd>{note.dimensions.original}</dd>
              </div>
              <div>
                <dt>形式化命题</dt>
                <dd>{note.dimensions.theorem}</dd>
              </div>
            </dl>
          )}
          {!!note.tasks?.length && (
            <section className="annotation-agents">
              <h4>
                <GitBranch size={16} />
                协作记录 {note.origin === "demo" && <span>演示</span>}
              </h4>
              {note.tasks.map((task) => (
                <button key={task.id} onClick={() => onTask(task, note)}>
                  <span className={`task-light ${task.status || "pending"}`} />
                  <strong>{task.role || task.id}</strong>
                  <span>{task.title || task.name}</span>
                  <small>
                    {{
                      running: "运行中",
                      succeeded: "已返回",
                      blocked: "受阻",
                      interrupted: "中断",
                    }[task.status] || task.state}
                  </small>
                </button>
              ))}
            </section>
          )}
          <section className="annotation-evidence">
            <h4>依据与来源</h4>
            <button onClick={() => onSelect(note.id)}>
              <FileText size={16} />
              <span>论文原文 · 第 {note.anchor.pageIndex + 1} 页</span>
              <ArrowUpRight size={14} />
            </button>
            {note.evidence?.map((e) => (
              <button key={e.id} onClick={() => onEvidence(e, note)}>
                <FileText size={16} />
                <span>{e.title}</span>
                <ArrowUpRight size={14} />
              </button>
            ))}
            {!note.evidence?.length && (
              <p className="muted">尚无机器核验证据。</p>
            )}
            <details>
              <summary>文件与目标版本</summary>
              <code>PDF {paper.id}</code>
              {note.targetHash && <code>目标 {note.targetHash}</code>}
              {note.runId && (
                <button onClick={() => onOpenRun(note.runId)}>
                  打开完整评审记录 <ArrowUpRight size={13} />
                </button>
              )}
            </details>
          </section>
          <div className="note-context-actions">
            <button
              className="button primary"
              disabled={!note.anchor.quote}
              onClick={() => onAsk(note.anchor, note.id)}
            >
              <Sparkle size={16} />问 AI
            </button>
            <button
              className="button outline"
              disabled={!note.anchor.quote}
              onClick={() => onReview(note.anchor)}
            >
              论证这一部分
            </button>
          </div>
          {!note.anchor.quote && (
            <p className="muted">
              此框选暂无文字。选择原文文字后，可问 AI 或发起局部论证。
            </p>
          )}
          {note.origin !== "agent" && (
            <button
              className="review-mark"
              onClick={onMark}
              disabled={note.status === "human_reviewed"}
            >
              {note.status === "human_reviewed"
                ? "已记录人工复核"
                : "记录人工复核"}
            </button>
          )}
          <Comments key={note.id} paperId={paper.id} noteId={note.id} />
        </div>
      )}
    </article>
  );
}
