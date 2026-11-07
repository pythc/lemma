import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "virtual:lemma-pdf-worker";
import {
  ArrowRight,
  CaretLeft,
  CaretRight,
  CheckCircle,
  DownloadSimple,
  FileText,
  List,
  MagnifyingGlass,
  Minus,
  Plus,
  Selection,
  UploadSimple,
  X,
  WarningCircle,
  ArrowsOutSimple,
  BookOpen,
  ArrowClockwise,
  GitBranch,
  ChatCircleText,
} from "@phosphor-icons/react";
import { ContinuousReader } from "./ContinuousReader.jsx";
import { PdfOutline } from "./PdfOutline.jsx";
import { COMMENT_MARGIN } from "./reading-flow.js";
import { ReviewPanel } from "./ReviewPanel.jsx";
import { PaperLedgerPanel } from "./PaperLedgerPanel.jsx";
import {
  annotationsFor,
  listPapers,
  saveAnnotation,
  savePaper,
} from "./storage.js";
import {
  createAnnotation,
  identifyPdf,
  reportFor,
  MAX_PDF_BYTES,
} from "./domain.js";
import { AnnotationCard } from "./AnnotationPanel.jsx";
import { ReaderAssistant } from "./ReaderAssistant.jsx";
import { ReviewWorkflow } from "./ReviewWorkflow.jsx";
import { usePaperReviews } from "./usePaperReviews.js";
import { annotationsFromRuns } from "./reader-model.js";
import { request, base64 } from "./api.js";
import { rememberReview } from "./storage.js";
import { annotationComments } from "./storage.js";
import { ReviewSummary } from "./ReviewSummary.jsx";
import { CsReviewPanel } from "./CsReviewPanel.jsx";
import { resultKey, resultIsVisible } from "./reading-flow.js";
import { resultAcknowledgements, acknowledgeResult } from "./storage.js";
import { evidenceDisplay } from "../shared/evidence-display.mjs";
import "./workbench.css";
import "./reader-workflow.css";
import "./reading-flow.css";

GlobalWorkerOptions.workerSrc = workerUrl;
function Modal({ title, onClose, children, wide = false }) {
  const dialog = useRef(null);
  useEffect(() => {
    const el = dialog.current;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      className={`modal ${wide ? "wide" : ""}`}
      ref={dialog}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
    >
      <div className="modal-title">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="关闭对话框"
          onClick={onClose}
        >
          <X size={22} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function EvidenceContent({ preview, kind }) {
  const data = evidenceDisplay(preview, kind);
  const { description, lists } = data;
  return (
    <>
      {description && <p>{description}</p>}
      {data.statement && <blockquote>{data.statement}</blockquote>}
      {lists.map(([label, values]) => (
        <section key={label}>
          <h4>{label}</h4>
          <ol>
            {values.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ol>
        </section>
      ))}
      {data.counterexample && <p>{data.counterexample}</p>}
      {data.pages.map((p) => (
        <details key={p.pageIndex}>
          <summary>第 {p.pageIndex + 1} 页原文</summary>
          <p className="evidence-text">{p.text}</p>
        </details>
      ))}
      {!description &&
        !data.statement &&
        !data.counterexample &&
        !data.pages?.length &&
        !lists.some(([, values]) => values?.length) && (
          <p>依据已保存，可下载查看完整内容。</p>
        )}
    </>
  );
}

function ArtifactPreview({ id }) {
  const [value, setValue] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setValue(null);
    setError("");
    request(`/api/artifacts/${id}?view=summary`, undefined, controller.signal)
      .then((v) => {
        if (!controller.signal.aborted) setValue(v);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [id]);
  return (
    <div className="reader-artifact">
      {error && <p role="alert">{error}</p>}
      {value ? (
        <>
          <EvidenceContent preview={value.preview} kind={value.kind} />
          <a className="source-locate" href={`/api/artifacts/${id}`} download>
            下载完整依据
          </a>
          {!!value.inputs.length && <h4>相关依据</h4>}
          {value.inputs.map((input, i) => (
            <a key={input} href={`/api/artifacts/${input}`} download>
              依据 {i + 1}
            </a>
          ))}
        </>
      ) : (
        !error && <p>正在读取依据…</p>
      )}
    </div>
  );
}

export function App() {
  const [paper, setPaper] = useState(null),
    [document, setDocument] = useState(null),
    [localNotes, setNotes] = useState([]),
    [selectedId, setSelectedId] = useState(null);
  const [pageIndex, setPageIndex] = useState(2),
    [zoom, setZoom] = useState(1.25),
    [panel, setPanel] = useState(null),
    [modal, setModal] = useState(null);
  const [areaMode, setAreaMode] = useState(false),
    [anchor, setAnchor] = useState(null);
  const [query, setQuery] = useState(""),
    [searchResults, setSearchResults] = useState([]),
    [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [library, setLibrary] = useState([]);
  const [homeTrack, setHomeTrack] = useState(null);
  const [openingBookmark, setOpeningBookmark] = useState(() =>
    Boolean(new URLSearchParams(window.location.search).get("review")),
  );
  const [csCandidates, setCsCandidates] = useState([]);
  const [csCandidateNotice, setCsCandidateNotice] = useState("");
  const [proposing, setProposing] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const [fitWidth, setFitWidth] = useState(true);
  const readerContainer = useRef(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [annotationsVisible, setAnnotationsVisible] = useState(true);
  const [pageNavigation, setPageNavigation] = useState(null);
  const [aiContext, setAiContext] = useState(null);
  const [workflowNew, setWorkflowNew] = useState(false),
    [focusedPassage, setFocusedPassage] = useState(null);
  const [startingReview, setStartingReview] = useState(false),
    [reviewRefresh, setReviewRefresh] = useState(0);
  const [launchedRun, setLaunchedRun] = useState(null);
  const { runs, error: runsError } = usePaperReviews(paper?.id, reviewRefresh);
  const [sourceFocus, setSourceFocus] = useState(null);
  const [requestedRunId, setRequestedRunId] = useState(null),
    [scopeRunId, setScopeRunId] = useState(null);
  const [entryDraft, setEntryDraft] = useState(null);
  const input = useRef(null),
    currentDoc = useRef(null),
    loadSequence = useRef(0),
    loadingTask = useRef(null),
    mounted = useRef(true),
    activePaperId = useRef(null),
    searchSequence = useRef(0);
  const reviewPool =
    paper?.track === "cs"
      ? runs.filter((run) => run.engine === "cs-review-v1")
      : runs.filter((run) => run.engine !== "cs-review-v1");
  const currentRun = workflowNew
    ? null
    : reviewPool.find((r) => r.id === requestedRunId) ||
      (launchedRun?.paperSha256 === paper?.id &&
      (paper?.track !== "cs" || launchedRun.engine === "cs-review-v1")
        ? launchedRun
        : null) ||
      reviewPool[0] ||
      null;
  const [acknowledgements, setAcknowledgements] = useState({});
  const [showProgress, setShowProgress] = useState(false);
  const startLock = useRef(false);
  const revealed = resultIsVisible(currentRun, paper?.id, acknowledgements);
  const showResults = revealed && !showProgress;
  const notes = useMemo(
    () => [
      ...localNotes.filter(
        (n) => n.paperId === paper?.id && n.origin !== "agent",
      ),
      ...(revealed ? annotationsFromRuns([currentRun], paper?.id) : []),
    ],
    [localNotes, currentRun, revealed, paper?.id],
  );
  const showMargin = annotationsVisible && notes.length > 0;
  const selected = notes.find((n) => n.id === selectedId);
  const onError = useCallback((text) => setError(text), []);
  useEffect(() => {
    if (!fitWidth || !document || !readerContainer.current) return;
    let cancelled = false;
    const resize = async () => {
      const page = await document.getPage(1);
      if (cancelled || !readerContainer.current) return;
      const scroll = readerContainer.current.querySelector(".paper-scroll");
      if (!scroll) return;
      const styles = window.getComputedStyle(scroll);
      const available =
        scroll.clientWidth -
        parseFloat(styles.paddingLeft) -
        parseFloat(styles.paddingRight) -
        (showMargin && scroll.clientWidth > 720 ? COMMENT_MARGIN : 0);
      setZoom(
        Math.max(
          0.25,
          Math.min(1.25, available / page.getViewport({ scale: 1 }).width),
        ),
      );
    };
    const observer = new ResizeObserver(() => void resize().catch(() => {}));
    observer.observe(readerContainer.current);
    void resize().catch(() => {});
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [document, fitWidth, showMargin, showResults, showProgress, panel]);

  async function activate(saved) {
    const request = ++loadSequence.current;
    searchSequence.current++;
    setSearching(false);
    setBusy(true);
    setError("");
    try {
      const task = getDocument({
        data: new Uint8Array(saved.bytes.slice(0)),
        standardFontDataUrl: "/pdf-standard-fonts/",
        cMapUrl: "/pdf-cmaps/",
        cMapPacked: true,
        wasmUrl: "/pdf-wasm/",
      });
      loadingTask.current = task;
      const pdf = await task.promise;
      if (!mounted.current || request !== loadSequence.current) {
        void pdf.loadingTask.destroy().catch(() => {});
        return;
      }
      const next = { ...saved, pageCount: pdf.numPages };
      await savePaper(next);
      const [found, seen] = await Promise.all([
        annotationsFor(next.id),
        resultAcknowledgements(next.id),
      ]);
      if (!mounted.current || request !== loadSequence.current) {
        void pdf.loadingTask.destroy().catch(() => {});
        return;
      }
      void currentDoc.current?.loadingTask.destroy().catch(() => {});
      currentDoc.current = pdf;
      activePaperId.current = next.id;
      setAcknowledgements(seen);
      setShowProgress(false);
      setPaper(next);
      setCsCandidates([]);
      setCsCandidateNotice("");
      setDocument(pdf);
      setNotes(found);
      setSelectedId(null);
      setAnnotationsVisible(true);
      setPageIndex(next.isDemo ? 2 : 0);
      setPageNavigation({ pageIndex: next.isDemo ? 2 : 0, token: Date.now() });
      setSidebarOpen(true);
      setZoom(1.25);
      setFitWidth(true);
      setPanel(null);
      setAnchor(null);
      setAreaMode(false);
      setSearchResults([]);
      setQuery("");
      setSourceFocus(null);

      setAiContext(null);
      setWorkflowNew(false);
      setFocusedPassage(null);
      setLaunchedRun(null);
      setRequestedRunId(null);
      setScopeRunId(null);
      setEntryDraft(null);
      return next;
    } catch (e) {
      if (request === loadSequence.current && mounted.current)
        setError(`无法打开论文：${e.message}`);
      return false;
    } finally {
      if (request === loadSequence.current && mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadSequence.current++;
      void loadingTask.current?.destroy().catch(() => {});
      void currentDoc.current?.loadingTask.destroy().catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!message) return;
    const timeout = setTimeout(() => setMessage(""), 4500);
    return () => clearTimeout(timeout);
  }, [message]);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("review");
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) {
      setOpeningBookmark(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const sequence = loadSequence.current;
    setBusy(true);
    void request(`/api/reviews/${id}/source`, undefined, controller.signal)
      .then(async (source) => {
        if (cancelled || sequence !== loadSequence.current) return;
        const bytes = Uint8Array.from(atob(source.pdfBase64), (c) =>
          c.charCodeAt(0),
        ).buffer;
        const run = source.review || {};
        const opened = await activate({
          id: source.paperSha256,
          title: run.title || "论文评审",
          fileName: "paper.pdf",
          bytes,
          isDemo: false,
          track: "math",
          createdAt: run.createdAt,
        });
        if (!cancelled && opened) {
          setRequestedRunId(id);
          setWorkflowNew(false);
          setShowProgress(true);
        }
        if (!cancelled) setOpeningBookmark(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setOpeningBookmark(false);
          setError(`无法读取评审论文：${e.message}`);
          setBusy(false);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  async function importPdf(event, track = homeTrack || paper?.track) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const door = track === "cs" ? "cs" : track === "math" ? "math" : null;
    try {
      if (!door) throw new Error("请先选择数学论文或计算机论文。");
      if (file.size > MAX_PDF_BYTES)
        throw new Error("请选择 25 MB 以内的 PDF 文件。");
      const bytes = await file.arrayBuffer();
      const id = await identifyPdf(bytes);
      const existing = (await listPapers()).some((p) => p.id === id);
      const ok = await activate({
        id,
        title: file.name.replace(/\.pdf$/i, ""),
        fileName: file.name,
        bytes,
        isDemo: false,
        track: door,
        createdAt: new Date().toISOString(),
      });
      if (ok) {
        const saved = await request(`/api/reviews?paper=${id}`).catch(
          () => null,
        );
        if (door === "cs") {
          const csRun = saved?.items?.find(
            (item) => item.engine === "cs-review-v1",
          );
          if (csRun) {
            setRequestedRunId(csRun.id);
            await rememberReview(id, csRun.id);
            setWorkflowNew(false);
          } else setWorkflowNew(true);
          setReviewRefresh((n) => n + 1);
        } else {
          const mathRun = saved?.items?.find(
            (item) => item.engine !== "cs-review-v1",
          );
          if (mathRun) {
            setRequestedRunId(mathRun.id);
            await rememberReview(id, mathRun.id);
            setWorkflowNew(false);
            setReviewRefresh((n) => n + 1);
          } else if (!existing) {
            setWorkflowNew(true);
            await startWorkflow(
              {
                pageIndex: 0,
              },
              ok,
              null,
            );
          }
        }
        setMessage(
          existing
            ? "已打开本机保存的论文与批注。"
            : door === "cs"
              ? "论文已导入。先登记一条计算机主张。"
              : "论文已导入。评审进度显示在右侧。",
        );
      }
    } catch (e) {
      setError(e.message);
    }
  }
  function choose(id) {
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    setAnnotationsVisible(true);
    setSelectedId(id);
    setSourceFocus(null);
    setPageIndex(note.anchor.pageIndex);
    setPageNavigation({ pageIndex: note.anchor.pageIndex, token: Date.now() });
    setFocusToken((t) => t + 1);
  }
  function nextPage(n) {
    if (document && Number.isFinite(n)) {
      const target = Math.max(
        0,
        Math.min(document.numPages - 1, Math.trunc(n)),
      );
      setPageIndex(target);
      setPageNavigation({ pageIndex: target, token: Date.now() });
    }
  }
  async function search(event) {
    event.preventDefault();
    if (!document || !query.trim()) return;
    const request = ++searchSequence.current,
      pdf = document,
      term = query.trim().toLowerCase();
    setSearching(true);
    try {
      const hits = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        if (request !== searchSequence.current || pdf !== currentDoc.current)
          return;
        const content = await (await pdf.getPage(i)).getTextContent();
        const text = content.items.map((x) => x.str || "").join(" "),
          at = text.toLowerCase().indexOf(term);
        if (at !== -1)
          hits.push({
            page: i - 1,
            text: text.slice(Math.max(0, at - 32), at + 110),
          });
      }
      if (request === searchSequence.current) setSearchResults(hits);
    } catch (e) {
      setError(e.message);
    } finally {
      if (request === searchSequence.current) setSearching(false);
    }
  }
  async function addNote(event) {
    event.preventDefault();
    const data = new FormData(event.target);
    try {
      const note = createAnnotation(
        paper,
        anchor,
        String(data.get("title")),
        String(data.get("body")),
      );
      await saveAnnotation(note);
      if (activePaperId.current !== note.paperId) return;
      setNotes((previous) => [...previous, note]);
      setSelectedId(note.id);
      setAnchor(null);
      setAreaMode(false);
      setMessage("批注已保存，重新打开后仍可查看。");
    } catch (e) {
      setError(e.message);
    }
  }
  async function markReviewed() {
    const next = {
      ...selected,
      status: "human_reviewed",
      reviewedAt: new Date().toISOString(),
    };
    try {
      await saveAnnotation(next);
      setNotes((previous) =>
        previous.map((n) => (n.id === next.id ? next : n)),
      );
      setMessage("已记录人工复核；此操作没有新增机器证据。");
    } catch (e) {
      setError(e.message);
    }
  }
  function download(name, type, content) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = window.document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function exportNotes(values = notes) {
    try {
      const withComments = await Promise.all(
        values.map(async (note) => ({
          ...note,
          comments: await annotationComments(paper.id, note.id),
        })),
      );
      download(
        `${paper.title}-批注.json`,
        "application/json",
        JSON.stringify(reportFor(paper, withComments), null, 2),
      );
    } catch (e) {
      setError(`导出失败：${e.message}`);
    }
  }
  async function showLibrary() {
    setLibrary(await listPapers());
    setModal({ type: "library" });
  }

  function locate(page, quote) {
    nextPage(page);
    setSourceFocus({ pageIndex: page, quote, token: Date.now() });
  }
  function openRun(id) {
    setRequestedRunId(id);
    setWorkflowNew(false);
    setEntryDraft(null);

    setShowProgress(false);
    setModal({ type: "review", runId: id });
  }
  function askAI(selection) {
    setAiContext(selection);
  }
  function prepareFocused(selection) {
    setFocusedPassage(selection);
    nextPage(selection.pageIndex);
    setSidebarOpen(true);
    setWorkflowNew(true);
    setShowProgress(true);
    setAiContext(null);
    setError("");
  }
  function showArtifact(task) {
    if (task.output)
      setModal({ type: "artifact", id: task.output, title: task.title });
  }
  async function startWorkflow(
    { pageIndex: scopePage, profile },
    targetPaper = paper,
    passage = focusedPassage,
  ) {
    if (startLock.current || !targetPaper) return;
    startLock.current = true;
    const identity = targetPaper.id;
    setStartingReview(true);
    setError("");
    try {
      const run = await request("/api/reviews", {
        pdfBase64: await base64(targetPaper.bytes),
        paperSha256: identity,
        pageIndex: passage?.pageIndex ?? scopePage,
        mode: "model",
        orchestration: "team",
        ...(passage ? { libraryProfile: profile } : {}),
        ...(passage ? { focusQuote: passage.quote } : {}),
      });
      await rememberReview(identity, run.id).catch(() => {
        if (activePaperId.current === identity)
          setError(`任务已创建，但恢复索引未保存：${run.id}`);
      });
      if (activePaperId.current !== identity) return;
      setLaunchedRun(run);
      setRequestedRunId(run.id);
      setWorkflowNew(false);
      setFocusedPassage(null);
      setReviewRefresh((n) => n + 1);
    } catch (e) {
      if (activePaperId.current === identity) setError(e.message);
    } finally {
      startLock.current = false;
      setStartingReview(false);
    }
  }

  async function revealResult() {
    if (!resultKey(currentRun, paper?.id)) return;
    try {
      const identity = paper.id;
      const seen = await acknowledgeResult(identity, currentRun);
      if (activePaperId.current !== identity) return;
      setAcknowledgements(seen);

      setShowProgress(false);
      setSidebarOpen(true);
      setSelectedId(null);
    } catch (e) {
      setError(e.message);
    }
  }
  function newReview() {
    setSidebarOpen(true);
    setWorkflowNew(true);
    setFocusedPassage(null);
    setEntryDraft(null);
    setShowProgress(true);
    setModal(null);
    if (paper?.track === "cs") return;
    void startWorkflow({ pageIndex: 0 }, paper, null);
  }
  async function startCsReview(claims) {
    if (startLock.current || !paper) return;
    startLock.current = true;
    const identity = paper.id;
    setStartingReview(true);
    setError("");
    try {
      const run = await request("/api/reviews", {
        pdfBase64: await base64(paper.bytes),
        paperSha256: identity,
        pageIndex: 0,
        track: "cs",
        orchestration: "cs",
        claims,
      });
      await rememberReview(identity, run.id).catch(() => {
        if (activePaperId.current === identity)
          setError(`任务已创建，但恢复索引未保存：${run.id}`);
      });
      if (activePaperId.current !== identity) return;
      setLaunchedRun(run);
      setRequestedRunId(run.id);
      setWorkflowNew(false);
      setShowProgress(true);
      setReviewRefresh((n) => n + 1);
    } catch (e) {
      if (activePaperId.current === identity) setError(e.message);
    } finally {
      startLock.current = false;
      setStartingReview(false);
    }
  }
  async function proposeCsCandidates() {
    if (startLock.current || !paper) return;
    startLock.current = true;
    const identity = paper.id;
    setProposing(true);
    setError("");
    setCsCandidateNotice("");
    try {
      const result = await request("/api/cs-candidates", {
        pdfBase64: await base64(paper.bytes),
        paperSha256: identity,
      });
      if (activePaperId.current !== identity) return;
      setCsCandidates(result.candidates || []);
      setCsCandidateNotice(result.notice || "");
    } catch (e) {
      if (activePaperId.current === identity) setError(e.message);
    } finally {
      startLock.current = false;
      setProposing(false);
    }
  }
  async function replayCsReview() {
    if (startLock.current || !currentRun?.id) return;
    startLock.current = true;
    const identity = paper?.id;
    setStartingReview(true);
    setError("");
    try {
      const run = await request(`/api/reviews/${currentRun.id}/cs-replay`, {});
      if (identity && activePaperId.current === identity)
        await rememberReview(identity, run.id).catch(() => {});
      if (identity && activePaperId.current !== identity) return;
      setLaunchedRun(run);
      setRequestedRunId(run.id);
      setWorkflowNew(false);
      setShowProgress(false);
      setReviewRefresh((n) => n + 1);
    } catch (e) {
      setError(e.message);
    } finally {
      startLock.current = false;
      setStartingReview(false);
    }
  }
  function renderNote(note) {
    return (
      <AnnotationCard
        paper={paper}
        note={note}
        open={note.id === selectedId}
        onSelect={choose}
        onClose={() => setSelectedId(null)}
        onAsk={askAI}
        onReview={prepareFocused}
        onEvidence={(e, n) =>
          n.origin === "agent"
            ? setModal({ type: "artifact", id: e.id, title: e.title })
            : setModal({ type: "evidence", note: n })
        }
        onTask={(task, n) =>
          n.origin === "agent"
            ? showArtifact(task)
            : setModal({ type: "task", task })
        }
        onOpenRun={openRun}
        onMark={markReviewed}
      />
    );
  }
  return (
    <div
      className={`app-shell reading-flow ${!paper ? "upload-mode" : ""} ${paper && !sidebarOpen ? "reading-focus" : ""}`}
    >
      <header className="app-header">
        <button
          className="wordmark"
          aria-label="返回上传首页"
          onClick={() => {
            loadSequence.current++;
            setAnchor(null);
            setBusy(false);
            setOpeningBookmark(false);
            setPaper(null);
            setCsCandidates([]);
            setCsCandidateNotice("");
            setDocument(null);
            setAiContext(null);
            setPanel(null);
            setHomeTrack(null);
            activePaperId.current = null;
          }}
        >
          Lemma
        </button>
        {paper && (
          <>
            <span className="header-divider" />
            <h1>{paper.title}</h1>
            {(paper.isDemo || paper.isFixture) && (
              <span className="mode-label">核验示例</span>
            )}
          </>
        )}
        <div className="header-actions">
          <button className="button subtle" onClick={showLibrary}>
            <BookOpen size={18} />
            论文库
          </button>
          {paper && (
            <button
              className="button outline"
              onClick={() => input.current.click()}
              disabled={busy}
            >
              <UploadSimple size={18} />
              上传论文
            </button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          onChange={(event) => void importPdf(event, paper?.track || homeTrack)}
          hidden
        />
      </header>
      {!paper && openingBookmark ? (
        <main className="upload-home" role="status">
          <h1>正在打开评审检查点</h1>
          <p>正在读取对应论文与已保存的评审状态。</p>
        </main>
      ) : !paper ? (
        <main className="upload-home">
          <div className="upload-intro">
            <h1>选择论文类型</h1>
            <p>
              数学论文沿用全文阅读和 Lean 核验。计算机论文按主张选择检查方式。
            </p>
          </div>
          <div className="track-choices" role="group" aria-label="论文类型">
            <button
              className="track-choice"
              aria-pressed={homeTrack === "math"}
              onClick={() => setHomeTrack("math")}
            >
              <strong>数学论文</strong>
              <span>阅读全文，并按命题做 Lean 核验。</span>
            </button>
            <button
              className="track-choice"
              aria-pressed={homeTrack === "cs"}
              onClick={() => setHomeTrack("cs")}
            >
              <strong>计算机论文</strong>
              <span>先分类主张。计算和符合现有库的命题才会检查。</span>
            </button>
          </div>
          {homeTrack && (
            <button
              className="upload-drop"
              disabled={busy}
              onClick={() => input.current.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!busy)
                  void importPdf(
                    {
                      target: { files: e.dataTransfer.files, value: "" },
                    },
                    homeTrack,
                  );
              }}
            >
              {busy ? (
                <ArrowClockwise className="spin" size={32} />
              ) : (
                <UploadSimple size={32} />
              )}
              <strong>
                {busy
                  ? "正在打开论文…"
                  : homeTrack === "cs"
                    ? "上传计算机论文 PDF"
                    : "上传数学论文 PDF"}
              </strong>
              <span>点击选择，或将文件拖到这里</span>
              <small>PDF · 最大 25 MB</small>
            </button>
          )}
          {error && (
            <p className="upload-error" role="alert">
              {error}
              {error.includes("fake worker") && (
                <button
                  className="button outline"
                  onClick={() => window.location.reload()}
                >
                  重新加载阅读器
                </button>
              )}
            </p>
          )}
        </main>
      ) : (
        <>
          {revealed && (
            <div className="result-display-bar">
              <button
                className="button subtle"
                onClick={() => {
                  setSidebarOpen(showProgress || !sidebarOpen);
                  setShowProgress(false);
                }}
              >
                {sidebarOpen && !showProgress ? "收起评审结果" : "查看评审结果"}
              </button>
              {!!notes.length && (
                <button className="button subtle" onClick={() => exportNotes()}>
                  <DownloadSimple size={16} />
                  导出批注
                </button>
              )}
              <button
                className="button subtle progress-link"
                onClick={() => {
                  setSidebarOpen(true);
                  setShowProgress(true);
                }}
              >
                <GitBranch size={17} />
                查看评审过程
              </button>
            </div>
          )}
          <div className={`workspace ${sidebarOpen ? "" : "reading-only"}`}>
            {panel && (
              <aside className="navigation-pane">
                <div className="pane-heading">
                  <h2>
                    {
                      {
                        outline: "论文目录",
                        search: "搜索原文",
                      }[panel]
                    }
                  </h2>
                  <button
                    className="icon-button"
                    onClick={() => setPanel(null)}
                    aria-label="收起侧栏"
                  >
                    <X size={18} />
                  </button>
                </div>
                {panel === "outline" && document && (
                  <PdfOutline
                    document={document}
                    onNavigate={(target) => {
                      setSelectedId(null);
                      setSourceFocus(null);
                      setPageIndex(target.pageIndex);
                      setPageNavigation({ ...target, token: Date.now() });
                    }}
                  />
                )}
                {panel === "search" && (
                  <>
                    <form onSubmit={search} className="search-form">
                      <input
                        aria-label="搜索关键词"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="搜索论文原文…"
                      />
                      <button className="button outline" disabled={searching}>
                        {searching ? "搜索中" : "查找"}
                      </button>
                    </form>
                    <p className="muted">
                      搜索文本层；扫描页可能没有可检索文字。
                    </p>
                    {searchResults.map((hit) => (
                      <button
                        key={hit.page}
                        className="search-hit"
                        onClick={() => nextPage(hit.page)}
                      >
                        <strong>第 {hit.page + 1} 页</strong>
                        <span>{hit.text}</span>
                      </button>
                    ))}
                    {query && !searching && !searchResults.length && (
                      <p className="muted">暂无匹配，请输入关键词后查找。</p>
                    )}
                  </>
                )}
              </aside>
            )}
            <main className="reader-region" ref={readerContainer}>
              <div className="reader-toolbar">
                <button
                  className="tool"
                  aria-label="目录"
                  onClick={() =>
                    setPanel(panel === "outline" ? null : "outline")
                  }
                >
                  <List size={20} />
                  <span>目录</span>
                </button>
                <div className="toolbar-divider" />
                <button
                  className="icon-button"
                  aria-label="上一页"
                  disabled={!document || pageIndex === 0}
                  onClick={() => nextPage(pageIndex - 1)}
                >
                  <CaretLeft size={18} />
                </button>
                <input
                  className="page-input"
                  aria-label="当前页码"
                  type="number"
                  min="1"
                  max={paper?.pageCount || 1}
                  value={pageIndex + 1}
                  onChange={(e) => nextPage(Number(e.target.value) - 1)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      nextPage(Number(e.currentTarget.value) - 1);
                  }}
                />
                <span className="page-total">/ {paper?.pageCount || "—"}</span>
                <button
                  className="icon-button"
                  aria-label="下一页"
                  disabled={!document || pageIndex === paper?.pageCount - 1}
                  onClick={() => nextPage(pageIndex + 1)}
                >
                  <CaretRight size={18} />
                </button>
                <div className="toolbar-divider" />
                <button
                  className="tool search-toggle"
                  aria-label="搜索文档"
                  onClick={() => setPanel("search")}
                >
                  <MagnifyingGlass size={20} />
                  <span>搜索文档</span>
                </button>
                <div className="toolbar-spacer" />
                <button
                  className="icon-button"
                  aria-label="缩小"
                  onClick={() => {
                    setFitWidth(false);
                    setZoom((v) => Math.max(0.25, v - 0.1));
                  }}
                >
                  <Minus size={18} />
                </button>
                <button
                  className="zoom-label"
                  onClick={() => {
                    setFitWidth(false);
                    setZoom(1.25);
                  }}
                  title="恢复 125%"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  className="icon-button"
                  aria-label="放大"
                  onClick={() => {
                    setFitWidth(false);
                    setZoom((v) => Math.min(2.5, v + 0.1));
                  }}
                >
                  <Plus size={18} />
                </button>
                <button
                  className="icon-button"
                  aria-label="适应页面宽度"
                  aria-pressed={fitWidth}
                  title="适应页面宽度"
                  onClick={() => setFitWidth(true)}
                >
                  <ArrowsOutSimple size={18} />
                </button>
                <div className="toolbar-divider" />
                {notes.length > 0 && (
                  <button
                    className={`tool annotation-toggle ${annotationsVisible ? "selected-tool" : ""}`}
                    aria-label={annotationsVisible ? "隐藏批注" : "显示批注"}
                    aria-pressed={annotationsVisible}
                    onClick={() => {
                      setAnnotationsVisible((value) => !value);
                      setSelectedId(null);
                    }}
                  >
                    <ChatCircleText size={18} />
                    <span>批注</span>
                    <small>{notes.length}</small>
                  </button>
                )}
                <button
                  className={`tool ${areaMode ? "selected-tool" : ""}`}
                  aria-label="框选批注"
                  aria-pressed={areaMode}
                  onClick={() => {
                    setAreaMode(!areaMode);
                    setMessage(
                      areaMode
                        ? "已切换为原文选择"
                        : "在论文上拖动框选，即可添加批注。",
                    );
                  }}
                >
                  <Selection size={20} />
                  <span>框选批注</span>
                </button>
              </div>
              {error && (
                <div className="error-banner" role="alert">
                  <WarningCircle size={18} />
                  <span>{error}</span>
                  {error.includes("fake worker") && (
                    <button onClick={() => window.location.reload()}>
                      重新加载阅读器
                    </button>
                  )}
                  <button
                    onClick={() => setError("")}
                    aria-label="关闭错误提示"
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
              {busy ? (
                <div className="loading-state">
                  <ArrowClockwise size={24} className="spin" />
                  <p>正在打开论文…</p>
                </div>
              ) : document ? (
                <ContinuousReader
                  key={paper.id}
                  document={document}
                  initialPageIndex={paper.isDemo ? 2 : 0}
                  navigation={pageNavigation}
                  onPageChange={setPageIndex}
                  zoom={zoom}
                  annotations={notes}
                  showMargin={showMargin}
                  renderNote={renderNote}
                  selectedId={selectedId}
                  focusToken={focusToken}
                  sourceFocus={sourceFocus}
                  onSelect={choose}
                  onAnchor={setAnchor}
                  onAsk={askAI}
                  onReview={prepareFocused}
                  areaMode={areaMode}
                  onError={onError}
                />
              ) : null}
            </main>

            {sidebarOpen && (
              <aside className="review-side">
                {showResults ? (
                  <ReviewSummary
                    run={currentRun}
                    onLocate={locate}
                    onDetails={() =>
                      ["langgraph-v1", "team-v1"].includes(currentRun.engine)
                        ? setShowProgress(true)
                        : setModal({ type: "review", runId: currentRun.id })
                    }
                    onCoverage={() => setModal({ type: "coverage" })}
                    onAnnotations={() => {
                      setSidebarOpen(false);
                      if (notes[0]) choose(notes[0].id);
                    }}
                    onEvidence={showArtifact}
                    onOriginalReview={async (reviewRunId) => {
                      try {
                        const r = await request("/api/original-proofs", {
                          reviewRunId,
                        });
                        setRequestedRunId(r.id);
                        await rememberReview(paper.id, r.id);
                        setWorkflowNew(false);
                        setShowProgress(true);
                        setReviewRefresh((n) => n + 1);
                      } catch (e) {
                        setError(e.message);
                      }
                    }}
                    onRetry={newReview}
                    onReplay={replayCsReview}
                    busy={startingReview}
                  />
                ) : paper.track === "cs" ? (
                  <CsReviewPanel
                    run={currentRun}
                    busy={startingReview}
                    proposing={proposing}
                    candidates={csCandidates}
                    candidateNotice={csCandidateNotice}
                    onSubmit={startCsReview}
                    onReveal={revealResult}
                    onReplay={replayCsReview}
                    onPropose={proposeCsCandidates}
                  />
                ) : (
                  <ReviewWorkflow
                    key={`${paper.id}:${currentRun?.id || "new"}`}
                    paper={paper}
                    run={currentRun}
                    runs={runs}
                    pageIndex={pageIndex}
                    onPage={nextPage}
                    onSelectRun={(id) => {
                      setRequestedRunId(id);
                      setWorkflowNew(false);
                      setFocusedPassage(null);
                      setShowProgress(true);
                    }}
                    onStart={startWorkflow}
                    focusedPassage={focusedPassage}
                    onConclusion={() =>
                      setModal({ type: "review", runId: currentRun?.id })
                    }
                    onTask={showArtifact}
                    onLocate={locate}
                    onChild={(id) =>
                      setModal({
                        type: "review",
                        runId: id,
                        parentRunId: currentRun.id,
                      })
                    }
                    onRefresh={() => setReviewRefresh((n) => n + 1)}
                    starting={startingReview}
                    error={error || runsError}
                    onReveal={revealResult}
                    revealed={revealed}
                    onNew={newReview}
                  />
                )}
              </aside>
            )}
          </div>
        </>
      )}
      {aiContext && paper && (
        <ReaderAssistant
          key={`${paper.id}:${aiContext.pageIndex}:${aiContext.quote}`}
          paper={paper}
          context={aiContext}
          onClose={() => setAiContext(null)}
          onLocate={locate}
          onReview={prepareFocused}
        />
      )}
      {message && (
        <div className="toast" role="status">
          <CheckCircle size={18} />
          {message}
        </div>
      )}
      {anchor && (
        <Modal title="添加原文批注" onClose={() => setAnchor(null)}>
          <form onSubmit={addNote} className="note-form">
            <p className="muted">
              第 {anchor.pageIndex + 1} 页 ·{" "}
              {anchor.quote ? "文本选区" : "区域选区"}
            </p>
            {anchor.quote && <blockquote>{anchor.quote}</blockquote>}
            <label>
              标题
              <input
                name="title"
                autoFocus
                required
                maxLength={150}
                placeholder="这一步需要澄清什么？"
              />
            </label>
            <label>
              批注内容
              <textarea
                name="body"
                required
                rows={5}
                maxLength={10000}
                placeholder="写下前提、疑问或具体反例…"
              />
            </label>
            <button className="button primary" type="submit">
              保存批注
            </button>
          </form>
        </Modal>
      )}
      {modal && (
        <Modal
          title={
            {
              evidence: "证据追溯",
              task: "Agent 产物",
              about: "关于工作台",
              library: "论文库",
              artifact: modal.title || "任务依据",
              review: "评审核对与依据",
              coverage: "核查覆盖",
            }[modal.type]
          }
          wide={["evidence", "review", "coverage"].includes(modal.type)}
          onClose={() => setModal(null)}
        >
          {modal.type === "review" && paper && (
            <ReviewPanel
              key={`${paper.id}:${modal.runId || "new"}`}
              paper={paper}
              pageIndex={pageIndex}
              onEvidence={showArtifact}
              requestedRunId={modal.runId}
              parentRunId={modal.parentRunId}
              showHistory={false}
              acknowledgedRoot={
                revealed && currentRun?.id === modal.runId
                  ? currentRun.root
                  : undefined
              }
              onFinished={(id) => {
                setRequestedRunId(modal.parentRunId || id);
                setWorkflowNew(false);
                setShowProgress(true);
                setReviewRefresh((n) => n + 1);
                setModal(null);
              }}
              entryDraft={entryDraft}
              originEntryId={entryDraft?.id}
              onClearEntry={() => setEntryDraft(null)}
              onLocate={locate}
              onStarted={(id) => {
                setRequestedRunId(modal.parentRunId || id);
                setWorkflowNew(false);
                setShowProgress(true);
                setReviewRefresh((n) => n + 1);
                setModal(null);
              }}
              onSelectRun={(id) => {
                setRequestedRunId(modal.parentRunId || id);
                setReviewRefresh((n) => n + 1);
              }}
              onAddToScope={(id) => {
                setScopeRunId(id);
                setModal({ type: "coverage" });
              }}
              onNewReview={newReview}
            />
          )}
          {modal.type === "coverage" && paper && (
            <PaperLedgerPanel
              paper={paper}
              pageIndex={pageIndex}
              initialRunId={scopeRunId}
              onLocate={(page, quote) => {
                locate(page, quote);
                setModal(null);
              }}
              onOpenRun={openRun}
              onReviewEntry={(entry) => {
                setEntryDraft(entry);
                setModal({ type: "review", runId: null });
              }}
            />
          )}
          {modal.type === "artifact" && <ArtifactPreview id={modal.id} />}
          {modal.type === "evidence" && (
            <div className="evidence-detail">
              <p className="eyebrow">
                {modal.note.label || "人工批注"} ·{" "}
                {modal.note.origin === "demo" ? "教学示例" : "人工记录"} ·{" "}
                {modal.note.status === "human_reviewed"
                  ? "人工复核已记录"
                  : "待复核"}
              </p>
              <h3>{modal.note.title}</h3>
              <blockquote>
                {modal.note.anchor.quote || "原文区域批注"}
              </blockquote>
              <div className="trace-steps">
                <span>原文定位</span>
                <ArrowRight />
                <span>条件核查</span>
                <ArrowRight />
                <span>论据／反例</span>
                <ArrowRight />
                <span>独立核验</span>
              </div>
              {modal.note.evidence.length ? (
                modal.note.evidence.map((e) => (
                  <section key={e.id}>
                    <div className="evidence-label">
                      <b>
                        {e.id} · {e.title}
                      </b>
                      <span>{e.type}</span>
                    </div>
                    <p>{e.body}</p>
                    <small>{e.source}</small>
                  </section>
                ))
              ) : (
                <section>
                  <b>人工提供的依据</b>
                  <p>{modal.note.body}</p>
                  <small>
                    此批注尚未关联机器证据；实际核验结果见“评审结论”。
                  </small>
                </section>
              )}
              <details>
                <summary>版本与可追溯信息</summary>
                <code>
                  论文 SHA-256：{paper.id}
                  <br />
                  批注 ID：{modal.note.id}
                  <br />
                  页码：{modal.note.anchor.pageIndex + 1}
                  <br />
                  来源：{modal.note.origin}
                  <br />
                  此批注的机器证据：未关联
                </code>
              </details>
              <button
                className="button outline"
                onClick={() => exportNotes([modal.note])}
              >
                <DownloadSimple size={18} />
                导出这条证据
              </button>
            </div>
          )}
          {modal.type === "task" && (
            <div className="task-detail">
              <span className="kind note">模拟轨迹 · 无模型调用</span>
              <h3>
                {modal.task.name} · {modal.task.action}
              </h3>
              <p>{modal.task.artifact}</p>
              <p className="muted">
                职责 {modal.task.id} · {modal.task.state}
              </p>
              <p>
                这是教学示例中的模拟产物。本机真实任务、交接与执行结果见“评审结论”。
              </p>
            </div>
          )}
          {modal.type === "library" && (
            <div className="library">
              {library.map((p) => (
                <button
                  className="library-row"
                  key={p.id}
                  onClick={() => {
                    setModal(null);
                    activate(p);
                  }}
                >
                  <FileText size={24} />
                  <span>
                    <strong>{p.title}</strong>
                    <small>
                      {p.pageCount} 页 ·{" "}
                      {p.track === "cs"
                        ? "计算机论文"
                        : p.isDemo
                          ? "教学示例"
                          : p.isFixture
                            ? "核验样本"
                            : "数学论文"}
                    </small>
                  </span>
                  <ArrowRight size={18} />
                </button>
              ))}
              <button
                className="button primary"
                onClick={() => {
                  setModal(null);
                  input.current.click();
                }}
              >
                <Plus size={18} />
                导入另一篇论文
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
