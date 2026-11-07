import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { acquireFileLease } from "./file-lease.mjs";
import { executionContext } from "./execution-context.mjs";

// Fair in-process queue plus local kernel leases for the production singleton.
// Cache acquisition audit/history remains in ensureDomainModules; never delete
// the OS lock file or treat its existence as evidence of a live holder.
export class LibraryAccess {
  constructor({ lockFile = null } = {}) {
    this.readers = 0;
    this.writer = false;
    this.queue = [];
    this.context = new AsyncLocalStorage();
    this.lockFile = lockFile;
  }
  drain() {
    if (this.writer) return;
    while (this.queue.length) {
      const next = this.queue[0];
      if (next.mode === "write" && this.readers) return;
      this.queue.shift();
      next.signal?.removeEventListener("abort", next.abort);
      if (next.signal?.aborted) {
        next.reject(next.signal.reason || Error("已取消"));
        continue;
      }
      if (next.mode === "write") this.writer = true;
      else this.readers++;
      next.resolve(() => {
        if (next.mode === "write") this.writer = false;
        else this.readers--;
        this.drain();
      });
      if (next.mode === "write") return;
    }
  }
  async run(mode, action, { signal } = {}) {
    signal?.throwIfAborted();
    const held = this.context.getStore();
    if (held) {
      if (held === "read" && mode === "write")
        throw Error("不能在活跃证明内修改数学库环境。");
      return action();
    }
    const task = executionContext.getStore();
    await task?.onToolQueued?.("lean-library");
    signal?.throwIfAborted();
    const release = await new Promise((resolve, reject) => {
      const item = { mode, resolve, reject, signal };
      item.abort = () => {
        const at = this.queue.indexOf(item);
        if (at >= 0) this.queue.splice(at, 1);
        reject(signal.reason || Error("已取消"));
        this.drain();
      };
      signal?.addEventListener("abort", item.abort, { once: true });
      this.queue.push(item);
      this.drain();
    });
    let lease;
    try {
      signal?.throwIfAborted();
      if (this.lockFile)
        lease = await acquireFileLease(this.lockFile, mode, { signal });
      await task?.onToolStarted?.("lean-library");
      const value = await this.context.run(mode, action);
      lease?.assertHeld();
      return value;
    } finally {
      try {
        await lease?.release();
      } finally {
        release();
      }
    }
  }
  read(action, options) {
    return this.run("read", action, options);
  }
  write(action, options) {
    return this.run("write", action, options);
  }
}
export const libraryAccess = new LibraryAccess({
  lockFile: fileURLToPath(
    new URL("../.tools/library-access.lock", import.meta.url),
  ),
});
