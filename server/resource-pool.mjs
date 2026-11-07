import { executionContext } from "./execution-context.mjs";
import { nativeResourcePolicy } from "./resources/native-policy.mjs";
/** FIFO resource limits. Waiting is cancellable and is not execution. */
export class ResourcePool {
  constructor(limit = 1, { name = null } = {}) {
    this.name = name;
    this.limit = limit;
    this.running = 0;
    this.queue = [];
  }
  setLimit(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8)
      throw Error("无效并发额度。");
    this.limit = limit;
    this.drain();
  }
  drain() {
    while (this.running < this.limit && this.queue.length) {
      const item = this.queue.shift();
      item.signal?.removeEventListener("abort", item.abort);
      if (item.signal?.aborted) {
        item.reject(item.signal.reason || Error("已取消"));
        continue;
      }
      this.running++;
      item.resolve(() => {
        this.running--;
        this.drain();
      });
    }
  }
  async run(fn, { signal, onQueued, onStarted } = {}) {
    if (signal?.aborted) throw signal.reason || Error("已取消");
    const context = executionContext.getStore();
    onQueued ||= this.name
      ? () => context?.onToolQueued?.(this.name)
      : undefined;
    onStarted ||= this.name
      ? () => context?.onToolStarted?.(this.name)
      : undefined;
    await onQueued?.();
    if (signal?.aborted) throw signal.reason || Error("已取消");
    const release = await new Promise((resolve, reject) => {
      const item = { resolve, reject, signal };
      item.abort = () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason || Error("已取消"));
      };
      signal?.addEventListener("abort", item.abort, { once: true });
      this.queue.push(item);
      this.drain();
    });
    try {
      if (signal?.aborted) throw signal.reason;
      await onStarted?.();
      return await fn();
    } finally {
      release();
    }
  }
  snapshot() {
    return {
      limit: this.limit,
      running: this.running,
      queued: this.queue.length,
    };
  }
}
const models = new Map();
export const leanPool = new ResourcePool(nativeResourcePolicy.concurrency, {
  name: "lean",
});
export const referencePool = new ResourcePool(2);
export function modelPool(config) {
  const id = `${config?.endpoint || "unconfigured"}:${config?.model || ""}`;
  if (!models.has(id)) models.set(id, new ResourcePool());
  const pool = models.get(id);
  pool.setLimit(config?.concurrency || 1);
  return pool;
}
