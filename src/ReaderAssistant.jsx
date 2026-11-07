import { useEffect, useRef, useState } from "react";
import {
  Sparkle,
  X,
  ArrowUp,
  ArrowUpRight,
  StopCircle,
  ArrowClockwise,
  Minus,
} from "@phosphor-icons/react";
import { base64, request } from "./api.js";
import { readerChatFor, rememberReaderChat } from "./storage.js";

export function ReaderAssistant({
  paper,
  context,
  onClose,
  onLocate,
  onReview,
}) {
  const [question, setQuestion] = useState(""),
    [jobs, setJobs] = useState([]),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false),
    [minimized, setMinimized] = useState(false);
  const alive = useRef(true),
    bottom = useRef(null);
  const key = `${context.pageIndex}:${context.quote}`;
  const active = jobs.find((j) => ["preparing", "running"].includes(j.status));
  useEffect(() => {
    alive.current = true;
    readerChatFor(paper.id, key)
      .then((list) => {
        if (alive.current) {
          setJobs(list);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive.current) {
          setError("对话历史读取失败，暂未发送问题。");
        }
      });
    return () => {
      alive.current = false;
    };
  }, [paper.id, key]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [jobs, minimized]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer;
    async function poll() {
      try {
        const job = await request(
          `/api/reader/chats/${active.id}`,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const normalizeQuote = (v) =>
          v.normalize("NFC").replace(/\s+/g, " ").trim();
        if (
          job.paperSha256 !== paper.id ||
          normalizeQuote(job.quote) !== normalizeQuote(context.quote) ||
          job.pageIndex !== context.pageIndex
        )
          throw new Error("回答与当前论文选区不一致。");
        setJobs((old) => old.map((j) => (j.id === job.id ? job : j)));
        if (["preparing", "running"].includes(job.status))
          timer = setTimeout(poll, 1800);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e.message);
          timer = setTimeout(poll, 5000);
        }
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active?.id, paper.id, key]);
  useEffect(() => {
    if (loaded)
      void rememberReaderChat(paper.id, key, jobs).catch(() => {
        if (alive.current) setError("对话索引保存失败，请保留任务编号。");
      });
  }, [jobs, loaded, paper.id, key]);
  async function send(value = question) {
    if (busy || active || !loaded || !value.trim()) return;
    setBusy(true);
    setError("");
    try {
      const previous = jobs.filter((j) => j.status === "completed").at(-1);
      const job = await request("/api/reader/chats", {
        pdfBase64: await base64(paper.bytes),
        paperSha256: paper.id,
        pageIndex: context.pageIndex,
        quote: context.quote,
        question: value,
        parentId: previous?.id || null,
      });
      // Preserve the accepted job even if the popup was closed during submission.
      const next = [...jobs, job];
      if (alive.current) {
        setJobs(next);
        setQuestion("");
      }
      try {
        await rememberReaderChat(paper.id, key, next);
      } catch {
        if (alive.current)
          setError(`问题已提交，但对话索引未保存。请保留任务编号：${job.id}`);
      }
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      className={`reader-ai-window ${minimized ? "minimized" : ""}`}
      role="dialog"
      aria-modal="false"
      aria-label="选区 AI 助手"
    >
      <header>
        <Sparkle size={20} />
        <div>
          <strong>一起读这一段</strong>
          <small>第 {context.pageIndex + 1} 页 · 基于所选原文</small>
        </div>
        <button
          className="icon-button"
          aria-label={minimized ? "展开 AI 窗口" : "最小化 AI 窗口"}
          onClick={() => setMinimized(!minimized)}
        >
          <Minus size={17} />
        </button>
        <button
          className="icon-button"
          aria-label="关闭 AI 窗口"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      {!minimized && (
        <>
          <button
            className="ai-context"
            onClick={() => onLocate(context.pageIndex, context.quote)}
          >
            {context.quote}
            <ArrowUpRight size={14} />
          </button>
          <div className="ai-messages" aria-live="polite">
            {!jobs.length && (
              <div className="ai-welcome">
                <h4>从一个问题开始</h4>
                <p>解释概念、拆解这一步的逻辑，或判断它是否需要进一步论证。</p>
                <button
                  onClick={() =>
                    send("请通俗解释这一段在讲什么，以及它与前后文的关系。")
                  }
                  disabled={!loaded || busy}
                >
                  这里在讲什么？
                </button>
                <button
                  onClick={() =>
                    send(
                      "这一部分是否需要进一步论证？请指出关键假设、可能缺口和建议验证的命题。",
                    )
                  }
                  disabled={!loaded || busy}
                >
                  这一部分需要论证吗？
                </button>
              </div>
            )}
            {jobs.map((job) => (
              <div className="ai-turn" key={job.id}>
                <p className="ai-question">{job.question}</p>
                {job.response ? (
                  <div className="ai-answer">
                    <small>
                      <Sparkle size={13} />
                      AI 解读
                    </small>
                    <p>{job.response.answer}</p>
                    <div className="ai-citations">
                      {job.response.citations.map((c, i) => (
                        <button
                          key={i}
                          title={c.quote}
                          onClick={() => onLocate(c.pageIndex, c.quote)}
                        >
                          来源 {i + 1} · 第 {c.pageIndex + 1} 页{" "}
                          <ArrowUpRight size={12} />
                        </button>
                      ))}
                    </div>
                    <p className="ai-review-suggestion">
                      {job.response.reviewSuggestion.reason}
                    </p>
                    <button
                      className="button outline"
                      disabled={!!active || busy}
                      onClick={() => onReview(context)}
                    >
                      发起局部论证 <ArrowUpRight size={14} />
                    </button>
                    <details>
                      <summary>本次回答依据</summary>
                      <code>{job.responseArtifact}</code>
                      <a
                        target="_blank"
                        rel="noreferrer"
                        href={`/api/artifacts/${job.responseArtifact}?view=summary`}
                      >
                        查看来源与回答记录
                      </a>
                    </details>
                  </div>
                ) : ["preparing", "running"].includes(job.status) ? (
                  <p className="ai-wait">
                    <ArrowClockwise size={15} className="spin" />
                    {job.status === "preparing"
                      ? "正在核对选区与上下文…"
                      : "正在分析…"}
                  </p>
                ) : (
                  <p className="reader-inline-error">
                    {job.error || "回答已中断。"}
                  </p>
                )}
              </div>
            ))}
            <div ref={bottom} />
          </div>
          {error && (
            <p role="alert" className="reader-inline-error">
              {error}
            </p>
          )}
          <form
            className="ai-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              autoFocus
              rows={2}
              maxLength={3000}
              aria-label="向 AI 提问"
              placeholder="继续追问这一段…"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
            {active ? (
              <button
                type="button"
                aria-label="停止 AI 回答"
                onClick={async () => {
                  try {
                    await request(`/api/reader/chats/${active.id}/cancel`, {});
                  } catch (e) {
                    setError(e.message);
                  }
                }}
              >
                <StopCircle size={22} />
              </button>
            ) : (
              <button
                aria-label="发送问题"
                disabled={busy || !loaded || !question.trim()}
              >
                <ArrowUp size={20} />
              </button>
            )}
          </form>
          <footer>
            <span>AI 解释供阅读参考，论证会另建评审任务。</span>
            {jobs.length > 0 && !active && (
              <button
                disabled={busy}
                onClick={() => {
                  setJobs([]);
                  setError("");
                }}
              >
                新对话
              </button>
            )}
          </footer>
        </>
      )}
    </section>
  );
}
