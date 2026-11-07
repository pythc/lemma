import { useEffect, useRef, useState } from "react";
import { CaretRight, ArrowSquareOut } from "@phosphor-icons/react";
import { outlineEntries, resolveOutlineDestination } from "./pdf-outline.js";

function OutlineBranch({ items, expanded, toggle, selected, busy, onSelect }) {
  return (
    <ul className="pdf-outline-list">
      {items.map((item) => (
        <li key={item.id}>
          <div
            className={`outline-row ${selected === item.id ? "chosen" : ""}`}
          >
            {item.children.length ? (
              <button
                className="outline-disclosure"
                aria-label={`${expanded.has(item.id) ? "收起" : "展开"}：${item.title}`}
                aria-expanded={expanded.has(item.id)}
                onClick={() => toggle(item.id)}
              >
                <CaretRight size={13} />
              </button>
            ) : (
              <span className="outline-indent" />
            )}
            {item.url && !item.dest ? (
              <a
                className="outline-title"
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {item.title}
                <ArrowSquareOut size={12} />
              </a>
            ) : (
              <button
                className="outline-title"
                aria-current={selected === item.id ? "location" : undefined}
                aria-busy={busy === item.id}
                disabled={!item.dest && !item.children.length}
                onClick={() => (item.dest ? onSelect(item) : toggle(item.id))}
              >
                {item.title}
              </button>
            )}
          </div>
          {item.children.length > 0 && expanded.has(item.id) && (
            <OutlineBranch
              items={item.children}
              expanded={expanded}
              toggle={toggle}
              selected={selected}
              busy={busy}
              onSelect={onSelect}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

export function PdfOutline({ document, onNavigate }) {
  const [state, setState] = useState({ document: null, items: [], error: "" });
  const [expanded, setExpanded] = useState(new Set());
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(null);
  const [navigationError, setNavigationError] = useState("");
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    let cancelled = false;
    sequence.current++;
    setSelected(null);
    setBusy(null);
    setNavigationError("");
    setExpanded(new Set());
    setState({ document: null, items: [], error: "" });
    document
      .getOutline()
      .then((raw) => {
        if (cancelled) return;
        const items = outlineEntries(raw);
        setState({ document, items, error: "" });
        setExpanded(
          new Set(items.filter((i) => i.children.length).map((i) => i.id)),
        );
      })
      .catch(() => {
        if (!cancelled)
          setState({
            document,
            items: [],
            error: "暂时无法读取此 PDF 的目录。",
          });
      });
    return () => {
      cancelled = true;
      sequence.current++;
    };
  }, [document, retry]);

  function toggle(id) {
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function select(item) {
    const token = ++sequence.current;
    setBusy(item.id);
    setNavigationError("");
    try {
      const target = await resolveOutlineDestination(document, item.dest);
      if (token !== sequence.current) return;
      setSelected(item.id);
      onNavigate(target);
    } catch (e) {
      if (token === sequence.current) setNavigationError(e.message);
    } finally {
      if (token === sequence.current) setBusy(null);
    }
  }
  if (state.document !== document)
    return (
      <p className="outline-message" role="status">
        正在读取目录…
      </p>
    );
  if (state.error)
    return (
      <div className="outline-message" role="alert">
        <p>{state.error}</p>
        <button
          className="button outline"
          onClick={() => setRetry((n) => n + 1)}
        >
          重新读取
        </button>
      </div>
    );
  if (!state.items.length)
    return <p className="outline-message">此 PDF 没有内置目录。</p>;
  return (
    <nav className="pdf-outline" aria-label="PDF 内置目录">
      <OutlineBranch
        items={state.items}
        expanded={expanded}
        toggle={toggle}
        selected={selected}
        busy={busy}
        onSelect={select}
      />
      {navigationError && (
        <p className="outline-message" role="alert">
          {navigationError}
        </p>
      )}
    </nav>
  );
}
