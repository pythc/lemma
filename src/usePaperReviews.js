import { terminalRun } from "../shared/review-completion.mjs";
import { useEffect, useRef, useState } from "react";
import { request } from "./api.js";
import { isActiveRun } from "./reader-model.js";

export function usePaperReviews(paperId, refreshToken = 0) {
  const [runs, setRuns] = useState([]),
    [error, setError] = useState("");
  const cache = useRef(new Map());
  useEffect(() => {
    setRuns((previous) =>
      previous.filter((run) => run.paperSha256 === paperId),
    );
    setError("");
    cache.current = new Map();
    if (!paperId) return;
    const controller = new AbortController();
    let timer;
    const streams = new Map();
    let polling = false,
      dirty = false;
    async function poll() {
      if (polling) {
        dirty = true;
        return;
      }
      polling = true;
      clearTimeout(timer);
      try {
        const list = await request(
          `/api/reviews?paper=${paperId}`,
          undefined,
          controller.signal,
        );
        const values = await Promise.all(
          list.items.map(async (item) => {
            const known = cache.current.get(item.id);
            if (
              known &&
              !isActiveRun(known) &&
              known.status === item.status &&
              known.root === item.root &&
              (known.revision || 0) === (item.revision || 0)
            )
              return known;
            return request(
              `/api/reviews/${item.id}`,
              undefined,
              controller.signal,
            );
          }),
        );
        if (controller.signal.aborted) return;
        const matching = values.filter((r) => r.paperSha256 === paperId);
        cache.current = new Map(matching.map((r) => [r.id, r]));
        setRuns(matching);
        for (const r of matching.filter(
          (r) =>
            ["langgraph-v1", "team-v1"].includes(r.engine) &&
            !streams.has(r.id) &&
            !terminalRun(r),
        )) {
          const stream = new EventSource(
            `/api/reviews/${r.id}/events?after=${r.revision || 0}`,
          );
          stream.addEventListener("review", () => {
            void poll();
          });
          streams.set(r.id, stream);
        }
        for (const [id, stream] of streams)
          if (!matching.some((r) => r.id === id && !terminalRun(r))) {
            stream.close();
            streams.delete(id);
          }
        setError("");
        timer = setTimeout(poll, matching.some(isActiveRun) ? 1800 : 5000);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError("评审状态暂时不可读取；保留最近一次状态，不会重发任务。");
          timer = setTimeout(poll, 5000);
        }
      } finally {
        polling = false;
        if (dirty && !controller.signal.aborted) {
          dirty = false;
          clearTimeout(timer);
          timer = setTimeout(poll, 50);
        }
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
      for (const stream of streams.values()) stream.close();
    };
  }, [paperId, refreshToken]);
  return { runs: runs.filter((run) => run.paperSha256 === paperId), error };
}
