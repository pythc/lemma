import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { executionContext } from "./execution-context.mjs";
const parentSpan = new AsyncLocalStorage();
export async function nativeSpan(name, fn, attributes = {}) {
  const owner = executionContext.getStore(),
    start = Date.now();
  const span = {
    id: randomUUID(),
    parentId: parentSpan.getStore() || null,
    taskId: owner?.task?.id || null,
    ownerId: owner?.run?.id || null,
    targetHash:
      attributes.targetHash || owner?.run?.contract?.targetHash || null,
    name,
    startedAtMs: start,
    attributes,
  };
  if (owner?.run) (owner.run.nativeTimings ||= []).push(span);
  await owner?.onNativeStage?.({
    name,
    phase: "started",
    at: start,
    id: span.id,
  });
  let originalError;
  try {
    const value = await parentSpan.run(span.id, fn);
    span.status = value?.termination ? "interrupted" : "returned";
    span.resultStatus = value?.status || null;
    if (value?.timing) span.workerTiming = value.timing;
    return value;
  } catch (error) {
    originalError = error;
    span.status = "failed";
    span.error = error.message;
    throw error;
  } finally {
    span.endedAtMs = Date.now();
    span.elapsedMs = span.endedAtMs - start;
    try {
      await owner?.onNativeStage?.({
        name,
        phase: "ended",
        at: span.endedAtMs,
        id: span.id,
      });
      await owner?.onNativeSpan?.(span);
    } catch (error) {
      // Never replace the actual tool failure with a secondary telemetry error.
      // On success, fail closed if its required timing receipt cannot be saved.
      if (!originalError) throw error;
      originalError.timingPersistenceError = error.message;
    }
  }
}
export { intervalUnionMs, timingBreakdown } from "../shared/timing-metrics.mjs";
