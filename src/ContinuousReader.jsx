import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PdfReader } from "./PdfReader.jsx";

function PaperPage({
  index,
  root,
  dimensions,
  zoom,
  initial,
  onLayout,
  ...props
}) {
  const slot = useRef(null),
    content = useRef(null);
  const [visible, setVisible] = useState(index === initial);
  const [measured, setMeasured] = useState(null);
  const estimatedHeight = dimensions.height * zoom;
  const reservedHeight = measured
    ? (measured.height * zoom) / measured.zoom
    : estimatedHeight;
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      {
        root: root.current,
        rootMargin: "1000px 0px",
      },
    );
    observer.observe(slot.current);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    if (!visible || !content.current) return;
    const measure = () => {
      const height = content.current?.getBoundingClientRect().height;
      if (!height) return;
      setMeasured((old) =>
        old?.height === height && old.zoom === zoom ? old : { height, zoom },
      );
      onLayout();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [visible, zoom, onLayout]);
  return (
    <section
      className="continuous-page"
      ref={slot}
      data-page-index={index}
      aria-label={`第 ${index + 1} 页`}
      style={
        visible
          ? { minHeight: Math.max(estimatedHeight, reservedHeight) }
          : { height: reservedHeight }
      }
    >
      {visible ? (
        <div ref={content}>
          <PdfReader
            {...props}
            pageIndex={index}
            zoom={zoom}
            embedded
            scrollContainerRef={root}
          />
        </div>
      ) : (
        <div
          className="page-placeholder"
          style={{ width: dimensions.width * zoom, height: estimatedHeight }}
        />
      )}
    </section>
  );
}

export function ContinuousReader({
  document,
  initialPageIndex = 0,
  navigation,
  onPageChange,
  zoom,
  ...props
}) {
  const root = useRef(null),
    frame = useRef(null);
  const [focusedToken, setFocusedToken] = useState(null);
  const [sourceToken, setSourceToken] = useState(null);
  const sourceFocus = useMemo(
    () =>
      props.sourceFocus && props.sourceFocus.token === sourceToken
        ? { ...props.sourceFocus, scroll: false }
        : props.sourceFocus,
    [props.sourceFocus, sourceToken],
  );
  const [dimensions, setDimensions] = useState(() =>
    Array.from({ length: document.numPages }, () => ({
      width: 612,
      height: 792,
    })),
  );
  const anchor = useRef({ pageIndex: initialPageIndex, fraction: 0 });
  const pendingAnchor = useRef(null),
    oldZoom = useRef(zoom);
  const onPage = useRef(onPageChange);
  onPage.current = onPageChange;
  if (oldZoom.current !== zoom) {
    pendingAnchor.current = { ...anchor.current };
    oldZoom.current = zoom;
  }
  const observe = useRef(null);
  observe.current = () => {
    const el = root.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const slots = [...el.querySelectorAll(".continuous-page")];
    const current =
      slots.find((s) => s.getBoundingClientRect().bottom > top + 40) ||
      slots.at(-1);
    if (!current) return;
    const box = current.getBoundingClientRect();
    const pageIndex = Number(current.dataset.pageIndex);
    anchor.current = { pageIndex, fraction: (top - box.top) / box.height };
    onPage.current(pageIndex);
  };
  const layout = useRef(null);
  if (!layout.current)
    layout.current = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const el = root.current,
          saved = pendingAnchor.current;
        const slot =
          saved && el?.querySelector(`[data-page-index="${saved.pageIndex}"]`);
        if (slot) {
          const box = slot.getBoundingClientRect();
          el.scrollTop +=
            box.top -
            el.getBoundingClientRect().top +
            saved.fraction * box.height;
        }
        observe.current();
      });
    };
  useEffect(() => {
    let disposed = false;
    const pages = [...dimensions];
    let cursor = 0;
    void Promise.all(
      Array.from({ length: Math.min(4, document.numPages) }, async () => {
        while (!disposed && cursor < document.numPages) {
          const index = cursor++;
          try {
            const page = await document.getPage(index + 1);
            const viewport = page.getViewport({ scale: 1 });
            pages[index] = { width: viewport.width, height: viewport.height };
          } catch (e) {
            if (!disposed) props.onError(e.message);
          }
        }
      }),
    ).then(() => {
      if (!disposed) {
        pendingAnchor.current ||= { ...anchor.current };
        setDimensions(pages);
      }
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame.current);
    };
  }, [document]);
  useLayoutEffect(() => {
    layout.current();
  }, [zoom, dimensions]);
  useLayoutEffect(() => {
    const index = Math.max(
      0,
      Math.min(
        document.numPages - 1,
        navigation?.pageIndex ?? initialPageIndex,
      ),
    );
    const slot = root.current?.querySelector(`[data-page-index="${index}"]`);
    if (!slot) return;
    pendingAnchor.current = null;
    const el = root.current;
    const fraction = navigation?.fraction || 0;
    const pageHeight = dimensions[index].height * zoom;
    el.scrollTop +=
      slot.getBoundingClientRect().top -
      el.getBoundingClientRect().top -
      24 +
      fraction * pageHeight;
    observe.current();
  }, [document, navigation, initialPageIndex]);
  return (
    <div
      className="paper-scroll continuous-reader"
      ref={root}
      aria-label="论文连续阅读区"
      onScroll={() => {
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => observe.current());
      }}
      onWheel={() => {
        pendingAnchor.current = null;
      }}
      onPointerDown={() => {
        pendingAnchor.current = null;
      }}
      onTouchStart={() => {
        pendingAnchor.current = null;
      }}
    >
      {dimensions.map((size, index) => (
        <PaperPage
          {...props}
          focusToken={props.focusToken === focusedToken ? 0 : props.focusToken}
          sourceFocus={sourceFocus}
          onFocusApplied={setFocusedToken}
          onSourceApplied={setSourceToken}
          key={index}
          document={document}
          index={index}
          root={root}
          dimensions={size}
          zoom={zoom}
          initial={initialPageIndex}
          onLayout={layout.current}
        />
      ))}
    </div>
  );
}
