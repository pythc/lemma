import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";

// FULL-synchronous commits run off the API event loop. Writer loss is fatal to
// this client: reopening while its native jobs survive would break ownership.
export class ActionJournal {
  constructor(root) {
    this.root = root;
    this.pending = new Map();
    this.seq = 0;
    this.worker = null;
    this.epoch = randomUUID();
    this.failure = null;
    this.closing = false;
  }
  call(method, args = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing && method !== "close")
      return Promise.reject(Error("Journal is closing"));
    if (!this.worker) {
      const worker = (this.worker = new Worker(
        new URL("./action-journal-worker.mjs", import.meta.url),
        { workerData: { root: this.root, epoch: this.epoch } },
      ));
      const fail = (e) => {
        this.failure = e;
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
        worker.unref();
      };
      worker.on("message", (m) => {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(Error(m.error)) : p.resolve(m.value);
        if (!this.pending.size) worker.unref();
      });
      worker.on("error", fail);
      worker.on("exit", (code) => {
        if (!this.closing)
          fail(
            Error(`Action writer exited (${code}); outcome must be reconciled`),
          );
        if (this.worker === worker) this.worker = null;
      });
    }
    this.worker.ref();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }
  async close() {
    this.closing = true;
    const worker = this.worker;
    if (!worker) return;
    try {
      if (!this.failure) await this.call("close");
    } finally {
      await worker.terminate();
      if (this.worker === worker) this.worker = null;
    }
  }
}
