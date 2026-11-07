import { useEffect, useRef, useState } from "react";
import { TextLayer } from "pdfjs-dist";
import { ChatCircleText } from "@phosphor-icons/react";
import "pdfjs-dist/web/pdf_viewer.css";
import { placeMarginNotes, COMMENT_MARGIN } from "./reading-flow.js";

export function PdfReader({
  document,
  pageIndex,
  zoom,
  annotations,
  selectedId,
  focusToken,
  sourceFocus,
  onSelect,
  onAnchor,
  onAsk,
  onReview,
  areaMode,
  onError,
  showMargin = false,
  renderNote,
  embedded = false,
  scrollContainerRef,
  onFocusApplied,
  onSourceApplied,
}) {
  const scrollRef = useRef(null),
    marginRef = useRef(null);
  const [noteHeights, setNoteHeights] = useState({});
  const holder = useRef(null),
    pageRef = useRef(null),
    drag = useRef(null),
    lastFocus = useRef(null);
  const [size, setSize] = useState({ width: 765, height: 990 });
  const [rubber, setRubber] = useState(null),
    [selection, setSelection] = useState(null);
  const [renderEpoch, setRenderEpoch] = useState(0),
    [sourceRects, setSourceRects] = useState([]);
  const [quoteRects, setQuoteRects] = useState({});
  const [anchorsReady, setAnchorsReady] = useState(false);
  useEffect(() => {
    if (!pageRef.current || !holder.current?.querySelector(".textLayer span"))
      return;
    const norm = (value) => value.normalize("NFC").replace(/\s+/g, " ").trim();
    const spans = [
      ...holder.current.querySelectorAll(".textLayer span"),
    ].filter((el) => norm(el.textContent));
    let joined = "";
    const ranges = spans.map((el) => {
      const start = joined.length;
      joined += norm(el.textContent) + " ";
      return { el, start, end: joined.length - 1 };
    });
    const bounds = pageRef.current.getBoundingClientRect(),
      found = {};
    for (const note of annotations.filter(
      (a) =>
        a.anchor.pageIndex === pageIndex &&
        !a.anchor.rects?.length &&
        a.anchor.quote,
    )) {
      const needle = norm(note.anchor.quote),
        start = joined.indexOf(needle);
      if (start < 0 || joined.indexOf(needle, start + 1) >= 0) continue;
      found[note.id] = ranges
        .filter((r) => r.end > start && r.start < start + needle.length)
        .map(({ el }) => {
          const r = el.getBoundingClientRect();
          return {
            x: (r.left - bounds.left) / bounds.width,
            y: (r.top - bounds.top) / bounds.height,
            width: r.width / bounds.width,
            height: r.height / bounds.height,
          };
        });
    }
    setQuoteRects(found);
    setAnchorsReady(true);
  }, [annotations, pageIndex, renderEpoch]);
  useEffect(() => {
    setSourceRects([]);
    if (!sourceFocus || sourceFocus.pageIndex !== pageIndex || !pageRef.current)
      return;
    const normalized = (v) => v.normalize("NFC").replace(/\s+/g, " ").trim();
    const spans = [
      ...holder.current.querySelectorAll(".textLayer span"),
    ].filter((el) => normalized(el.textContent));
    let joined = "";
    const ranges = spans.map((el) => {
      const start = joined.length;
      joined += normalized(el.textContent) + " ";
      return { el, start, end: joined.length - 1 };
    });
    const quote = normalized(sourceFocus.quote),
      start = joined.indexOf(quote);
    if (start < 0) return;
    const bounds = pageRef.current.getBoundingClientRect();
    const rects = ranges
      .filter((r) => r.end > start && r.start < start + quote.length)
      .map(({ el }) => {
        const r = el.getBoundingClientRect();
        return {
          x: (r.left - bounds.left) / bounds.width,
          y: (r.top - bounds.top) / bounds.height,
          width: r.width / bounds.width,
          height: r.height / bounds.height,
        };
      });
    setSourceRects(rects);
    if (rects.length && sourceFocus.scroll !== false) {
      (scrollContainerRef?.current || scrollRef.current).scrollTo({
        top: Math.max(
          0,
          (scrollContainerRef?.current || scrollRef.current).scrollTop +
            bounds.top -
            (
              scrollContainerRef?.current || scrollRef.current
            ).getBoundingClientRect().top +
            rects[0].y * bounds.height -
            160,
        ),
        behavior: "smooth",
      });
      onSourceApplied?.(sourceFocus.token);
    }
  }, [sourceFocus, pageIndex, renderEpoch]);
  useEffect(() => {
    if (!focusToken) return;
    const focusKey = `${focusToken}:${pageIndex}:${selectedId}`;
    if (lastFocus.current === focusKey) return;
    const note = annotations.find(
      (a) => a.id === selectedId && a.anchor.pageIndex === pageIndex,
    );
    const rect = note?.anchor.rects?.[0] || quoteRects[note?.id]?.[0];
    if (!note || !rect || !pageRef.current) return;
    lastFocus.current = focusKey;
    const scroll = scrollContainerRef?.current || scrollRef.current;
    scroll.scrollTo({
      top: Math.max(
        0,
        scroll.scrollTop +
          pageRef.current.getBoundingClientRect().top -
          scroll.getBoundingClientRect().top +
          rect.y * size.height -
          scroll.clientHeight * 0.3,
      ),
      behavior: "smooth",
    });
    onFocusApplied?.(focusToken);
  }, [focusToken, pageIndex, size.height, selectedId, quoteRects]);
  useEffect(() => {
    if (!embedded) return;
    const clearOtherSelection = () => {
      const selected = window.getSelection();
      if (
        !selected?.rangeCount ||
        !holder.current?.contains(selected.anchorNode) ||
        !holder.current?.contains(selected.focusNode)
      )
        setSelection(null);
    };
    window.document.addEventListener("selectionchange", clearOtherSelection);
    return () =>
      window.document.removeEventListener(
        "selectionchange",
        clearOtherSelection,
      );
  }, [embedded]);
  useEffect(() => {
    let disposed = false,
      renderTask,
      layer;
    setSelection(null);
    setAnchorsReady(false);
    setQuoteRects({});
    setSourceRects([]);
    const paint = async () => {
      try {
        const page = await document.getPage(pageIndex + 1);
        const target = holder.current;
        // A virtual page's DOM may detach before passive effect cleanup runs.
        if (disposed || !target || !pageRef.current) return;
        const viewport = page.getViewport({ scale: zoom });
        setSize({ width: viewport.width, height: viewport.height });
        const canvas = window.document.createElement("canvas");
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.setAttribute("aria-label", `论文第 ${pageIndex + 1} 页`);
        const text = window.document.createElement("div");
        text.className = "textLayer";
        text.style.setProperty("--scale-factor", viewport.scale);
        text.style.setProperty("--total-scale-factor", viewport.scale);
        target.replaceChildren(canvas, text);
        renderTask = page.render({
          canvasContext: canvas.getContext("2d"),
          canvas,
          viewport,
          transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
        });
        await renderTask.promise;
        if (disposed) return;
        const textContent = await page.getTextContent();
        if (disposed || holder.current !== target) return;
        layer = new TextLayer({
          textContentSource: textContent,
          container: text,
          viewport,
        });
        await layer.render();
        if (!disposed) setRenderEpoch((n) => n + 1);
      } catch (error) {
        if (
          !disposed &&
          error.name !== "RenderingCancelledException" &&
          error.name !== "AbortException"
        )
          onError(error.message);
      }
    };
    paint();
    return () => {
      disposed = true;
      renderTask?.cancel();
      layer?.cancel();
    };
  }, [document, pageIndex, zoom, onError]);

  const marginLayout = placeMarginNotes(
    annotations,
    quoteRects,
    pageIndex,
    size.height,
    noteHeights,
  );
  // Keep tiny markers out of the text and separate coincident source anchors.
  let markerBottom = -20;
  const markerTops = Object.fromEntries(
    marginLayout.placed.map(({ note, anchorTop }) => {
      const top = Math.max(anchorTop, markerBottom + 4);
      markerBottom = top + 16;
      return [note.id, top];
    }),
  );
  useEffect(() => {
    if (!showMargin || !marginRef.current) return;
    const measure = () => {
      const next = {};
      marginRef.current
        ?.querySelectorAll("[data-margin-note]")
        .forEach((el) => {
          next[el.dataset.marginNote] = el.getBoundingClientRect().height;
        });
      setNoteHeights((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    const observer = new ResizeObserver(measure);
    marginRef.current
      .querySelectorAll("[data-margin-note]")
      .forEach((el) => observer.observe(el));
    measure();
    return () => observer.disconnect();
  }, [showMargin, annotations, pageIndex, quoteRects, selectedId]);
  const norm = (event) => {
    const box = pageRef.current.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    };
  };
  function captureText() {
    if (areaMode) return;
    const chosen = window.getSelection();
    if (
      !chosen?.rangeCount ||
      !chosen.toString().trim() ||
      !holder.current.contains(chosen.anchorNode) ||
      !holder.current.contains(chosen.focusNode)
    ) {
      if (!chosen?.toString().trim()) setSelection(null);
      return;
    }
    const bounds = pageRef.current.getBoundingClientRect();
    const rects = [...chosen.getRangeAt(0).getClientRects()]
      .map((r) => ({
        x: Math.max(0, (r.left - bounds.left) / bounds.width),
        y: Math.max(0, (r.top - bounds.top) / bounds.height),
        width: Math.min(r.width / bounds.width, 1),
        height: Math.min(r.height / bounds.height, 1),
      }))
      .filter(
        (r) =>
          r.width > 0.002 &&
          r.height > 0.002 &&
          r.x + r.width <= 1.001 &&
          r.y + r.height <= 1.001,
      );
    if (rects.length)
      setSelection({ pageIndex, rects, quote: chosen.toString() });
  }
  return (
    <div
      ref={scrollRef}
      className={`${embedded ? "paper-page-content" : "paper-scroll"} ${showMargin ? "with-comments" : ""}`}
      onMouseUp={captureText}
      onKeyUp={captureText}
    >
      <div
        className="paper-spread"
        style={{
          width: size.width + (showMargin ? COMMENT_MARGIN : 0),
          minHeight: showMargin ? marginLayout.height : size.height,
        }}
      >
        <div
          className="pdf-page"
          ref={pageRef}
          style={{ width: size.width, height: size.height }}
        >
          <div ref={holder} className="pdf-content" />
          <div className="annotation-overlay" aria-label="原文批注位置">
            {sourceRects.map((r, i) => (
              <div
                key={`source-${i}`}
                className="run-source-highlight"
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.width * 100}%`,
                  height: `${r.height * 100}%`,
                }}
              />
            ))}
            {annotations
              .filter((a) => a.anchor.pageIndex === pageIndex)
              .map((a) => {
                const rects = a.anchor.rects?.length
                  ? a.anchor.rects
                  : quoteRects[a.id] || [];
                return (
                  <div key={a.id}>
                    {rects.map((r, i) => (
                      <div
                        key={`${a.id}-${i}`}
                        className={`anchor ${a.kind} ${a.id === selectedId ? "selected" : ""}`}
                        style={{
                          left: `${r.x * 100}%`,
                          top: `${r.y * 100}%`,
                          width: `${r.width * 100}%`,
                          height: `${r.height * 100}%`,
                        }}
                      />
                    ))}
                    {Number.isFinite(markerTops[a.id]) && (
                      <button
                        className={`anchor-label ${a.id === selectedId ? "selected" : ""}`}
                        style={{
                          "--marker-left": `${size.width + 4}px`,
                          top: markerTops[a.id],
                        }}
                        onClick={() => onSelect(a.id)}
                        aria-label={`展开批注：${a.title}`}
                        title={a.summary || a.title}
                      >
                        <ChatCircleText size={12} weight="fill" />
                      </button>
                    )}
                  </div>
                );
              })}
          </div>
          {areaMode && (
            <div
              className="area-selector"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = norm(e);
                setRubber({ ...drag.current, width: 0, height: 0 });
              }}
              onPointerMove={(e) => {
                if (!drag.current) return;
                const p = norm(e);
                setRubber({
                  x: Math.min(p.x, drag.current.x),
                  y: Math.min(p.y, drag.current.y),
                  width: Math.abs(p.x - drag.current.x),
                  height: Math.abs(p.y - drag.current.y),
                });
              }}
              onPointerUp={() => {
                if (rubber?.width > 0.01 && rubber?.height > 0.005)
                  onAnchor({ pageIndex, rects: [rubber], quote: "" });
                drag.current = null;
                setRubber(null);
              }}
              onPointerCancel={() => {
                drag.current = null;
                setRubber(null);
              }}
            >
              {rubber && (
                <div
                  className="rubber"
                  style={{
                    left: `${rubber.x * 100}%`,
                    top: `${rubber.y * 100}%`,
                    width: `${rubber.width * 100}%`,
                    height: `${rubber.height * 100}%`,
                  }}
                />
              )}
            </div>
          )}
        </div>
        {showMargin && (
          <aside
            className="word-comments"
            ref={marginRef}
            aria-label="原文旁批注"
            style={{ minHeight: marginLayout.height }}
          >
            {marginLayout.placed.map(({ note, top }) => (
              <div
                key={note.id}
                data-margin-note={note.id}
                className="positioned-comment"
                style={{ top }}
              >
                {renderNote(note)}
              </div>
            ))}
          </aside>
        )}
      </div>
      {showMargin && anchorsReady && marginLayout.unplaced.length > 0 && (
        <section className="unplaced-notes">
          <h3>本页待定位批注</h3>
          <p>未能唯一匹配原文位置，以下批注暂不贴靠正文。</p>
          {marginLayout.unplaced.map((note) => (
            <div key={note.id}>{renderNote(note)}</div>
          ))}
        </section>
      )}
      {selection && (
        <div
          className="selection-action"
          role="toolbar"
          aria-label="所选原文操作"
          onMouseDown={(e) => e.preventDefault()}
        >
          <span>已选原文</span>
          <button
            onClick={() => {
              onAnchor(selection);
              setSelection(null);
              window.getSelection()?.removeAllRanges();
            }}
          >
            添加批注
          </button>
          <button
            onClick={() => {
              onAsk?.(selection);
              setSelection(null);
              window.getSelection()?.removeAllRanges();
            }}
          >
            问 AI
          </button>
          <button
            onClick={() => {
              onReview?.(selection);
              setSelection(null);
              window.getSelection()?.removeAllRanges();
            }}
          >
            局部论证
          </button>
          <button
            aria-label="关闭选区工具"
            onClick={() => {
              setSelection(null);
              window.getSelection()?.removeAllRanges();
            }}
          >
            关闭
          </button>
        </div>
      )}
    </div>
  );
}
