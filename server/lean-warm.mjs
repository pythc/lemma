import { ResourcePool } from "./resource-pool.mjs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { nativeHost } from "./resources/native-host.mjs";
import { executionContext } from "./execution-context.mjs";
import { digest } from "./evidence.mjs";
import { nativeSpan } from "./native-timing.mjs";

class WarmClient {
  constructor({ directory, environment, sandboxProfile }) {
    this.directory = directory;
    this.epoch = randomUUID();
    this.version = 0;
    this.id = 0;
    this.pending = new Map();
    this.events = new Set();
    this.buffer = Buffer.alloc(0);
    this.control = "";
    this.failure = null;
    this.initialized = false;
    this.busy = false;
    this.child = spawn(
      nativeHost.python,
      [
        fileURLToPath(new URL("../worker/native_warm.py", import.meta.url)),
        nativeHost.root,
        String(nativeHost.capacity),
      ],
      {
        cwd: directory,
        env: {
          PATH: path.join(environment.runtime.toolRoot, "bin"),
          HOME: directory,
          LEAN_PATH: environment.library.searchPaths.join(path.delimiter),
          LANG: "C.UTF-8",
        },
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      },
    );
    this.closed = new Promise((resolve) =>
      this.child.once("close", (code) => {
        this.fail(Error(`Warm supervisor exited (${code})`));
        resolve();
      }),
    );
    this.child.on("error", (e) => this.fail(e));
    this.child.on("exit", () => {
      // A killed supervisor cannot run its finally block; its Lean child may
      // still hold both inherited pipes and the host lock. Reap only the exact
      // group birth identity announced by this supervisor, never a reused PID.
      this.fail(Error("Warm supervisor exited before client retirement"));
      void this.reapOrphan();
    });
    this.child.stdin.on("error", (e) => this.fail(e));
    this.child.stdout.on("data", (b) => {
      this.buffer = Buffer.concat([this.buffer, b]);
      this.parse();
    });
    this.stderr = "";
    let stderrBytes = 0;
    this.child.stderr.on("data", (b) => {
      stderrBytes += b.length;
      this.stderr = (this.stderr + b.toString()).slice(-8000);
      if (stderrBytes > 1000000)
        this.fail(Error("Warm stderr envelope exceeded"));
    });
    this.child.stdio[3].on("data", (b) => {
      this.control += b;
      let i;
      while ((i = this.control.indexOf("\n")) >= 0) {
        const line = this.control.slice(0, i);
        this.control = this.control.slice(i + 1);
        try {
          this.emit({ control: JSON.parse(line) });
        } catch (e) {
          this.fail(e);
        }
      }
    });
    this.command({
      kind: "configure",
      maxMemoryMiB: 8192,
      command: "/usr/bin/sandbox-exec",
      args: [
        "-p",
        sandboxProfile(
          directory,
          environment.library.searchPaths,
          environment.runtime,
        ) +
          '\n(allow file-read* (literal "/private/etc/localtime") (subpath "/private/var/db/timezone") (subpath "/usr/share/zoneinfo"))',
        environment.runtime.binary,
        "-M",
        "8192",
        "--server",
      ],
    });
  }
  command(data) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(data) + "\n");
  }
  emit(message) {
    if (message.control?.event === "acquired") {
      this.nativePid = message.control.pid;
      this.nativeBirth = message.control.birth;
    }
    if (message.control?.event === "failed") {
      this.fail(Error(message.control.error + ": " + this.stderr));
      return;
    }
    for (const f of [...this.events]) f(message);
  }
  async reapOrphan() {
    if (!this.nativePid || !this.nativeBirth) return;
    try {
      const { stdout } = await promisify(execFile)(
        "/bin/ps",
        ["-p", String(this.nativePid), "-o", "lstart="],
        { timeout: 5000 },
      );
      if (stdout.trim() === this.nativeBirth)
        process.kill(-this.nativePid, "SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH" && e.code !== 1) this.cleanupError = e.message;
    }
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const f of [...this.events]) f({ error });
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.child.stdin.destroy();
  }
  parse() {
    try {
      while (true) {
        const boundary = this.buffer.indexOf("\r\n\r\n");
        if (boundary < 0) {
          if (this.buffer.length > 4096) throw Error("Invalid LSP framing");
          return;
        }
        const size = Number(
          /Content-Length: (\d+)/i.exec(
            this.buffer.subarray(0, boundary).toString(),
          )?.[1],
        );
        if (!Number.isSafeInteger(size) || size > 4000000)
          throw Error("LSP payload envelope exceeded");
        if (this.buffer.length < boundary + 4 + size) return;
        const m = JSON.parse(
          this.buffer.subarray(boundary + 4, boundary + 4 + size),
        );
        this.buffer = this.buffer.subarray(boundary + 4 + size);
        if (Object.hasOwn(m, "id") && !m.method) {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
          }
        } else if (m.method && Object.hasOwn(m, "id")) {
          this.send({
            jsonrpc: "2.0",
            id: m.id,
            error: { code: -32601, message: "Client request unsupported" },
          });
        } else this.emit(m);
      }
    } catch (e) {
      this.fail(e);
    }
  }
  wait(predicate) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const receive = (m) => {
        if (m.error || predicate(m)) {
          this.events.delete(receive);
          m.error ? reject(m.error) : resolve(m);
        }
      };
      this.events.add(receive);
    });
  }
  send(message) {
    const bytes = Buffer.from(JSON.stringify(message)),
      frame = Buffer.concat([
        Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`),
        bytes,
      ]);
    this.command({ kind: "send", bytes: frame.toString("base64") });
  }
  request(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
  async run(code, { signal, timeoutMs = 1200000 } = {}) {
    signal?.throwIfAborted();
    const context = executionContext.getStore(),
      cancel = () => this.fail(signal.reason || Error("Warm work cancelled"));
    signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(
      () => this.fail(Error("Warm work exceeded execution time envelope")),
      timeoutMs,
    );
    try {
      await context?.onToolQueued?.("lean-host");
      const acquired = this.wait((m) => m.control?.event === "acquired");
      this.command({ kind: "acquire" });
      await acquired;
      await context?.onToolStarted?.("lean-host");
      if (!this.initialized) {
        await this.request("initialize", {
          processId: process.pid,
          rootUri: pathToFileURL(this.directory).href,
          capabilities: {},
          initializationOptions: {},
        });
        this.notify("initialized", {});
        this.initialized = true;
      }
      const uri = `untitled:lemma-${this.epoch}.lean`,
        version = ++this.version;
      let diagnostics = [];
      const receiver = (m) => {
        if (
          m.method === "textDocument/publishDiagnostics" &&
          m.params.uri === uri &&
          m.params.version === version
        )
          diagnostics = m.params.isIncremental
            ? [...diagnostics, ...m.params.diagnostics]
            : m.params.diagnostics;
      };
      this.events.add(receiver);
      // A real source file is kept for exact navigation; didChange binds the same
      // public bytes to a new version. A stale notification cannot settle this work.
      await writeFile(path.join(this.directory, "Scratch.lean"), code, {
        mode: 0o600,
      });
      if (version === 1)
        this.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: "lean4", version, text: code },
        });
      else
        this.notify("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text: code }],
        });
      await this.request("textDocument/waitForDiagnostics", { uri, version });
      this.events.delete(receiver);
      const released = this.wait((m) => m.control?.event === "released");
      this.command({ kind: "release" });
      const releaseReceipt = await released;
      await context?.onToolFinished?.("lean-host");
      return {
        exitCode: diagnostics.some((d) => d.severity === 1) ? 1 : 0,
        diagnostics,
        stdout: diagnostics.map((d) => d.message).join("\n"),
        stderr: "",
        termination: null,
        scope: "diagnostic_only_not_a_certificate",
        peakRssBytes: releaseReceipt.control.peakRssBytes,
        workerEpoch: this.epoch,
        documentVersion: version,
        workerReused: version > 1,
      };
    } catch (e) {
      this.fail(e);
      await this.closed;
      throw e;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    }
  }
  async close() {
    if (!this.closeJob)
      this.closeJob = (async () => {
        if (!this.failure) {
          try {
            this.command({ kind: "close" });
          } catch {}
        }
        this.child.stdin.end();
        await this.closed;
        await rm(this.directory, { recursive: true, force: true });
      })();
    return this.closeJob;
  }
}

// Slots count running work across processes; local clients only cache stopped
// contexts. No old worker is reused across changed verified environment bytes.
export class WarmLeanPool {
  constructor({ maxClients = 3, idleMs = 60000 } = {}) {
    this.maxClients = maxClients;
    this.idleMs = idleMs;
    this.admission = new ResourcePool(maxClients, { name: "lean-warm" });
    this.clients = [];
    this.queue = Promise.resolve();
  }
  async run(code, environment, sandboxProfile, options = {}) {
    return this.admission.run(
      () => this.runReserved(code, environment, sandboxProfile, options),
      { signal: options.signal },
    );
  }
  async runReserved(code, environment, sandboxProfile, options = {}) {
    const key = digest({
      environment,
      owner: options.runId || null,
      workspace: options.workspaceRevision || null,
      protocol: "lean-lsp-v1",
    });
    // Short critical section selects an idle client, never serializes native work.
    let release;
    const prior = this.queue;
    this.queue = new Promise((r) => (release = r));
    await prior;
    let client;
    try {
      client = this.clients.find((c) => !c.busy && !c.failure && c.key === key);
      if (!client) {
        const retired = this.clients.find((c) => !c.busy);
        if (this.clients.length >= this.maxClients && !retired)
          throw Object.assign(
            Error(
              "All warm contexts are in use; use a new diagnostic after current work settles",
            ),
            { code: "warm_context_busy" },
          );
        if (retired && this.clients.length >= this.maxClients) {
          this.clients.splice(this.clients.indexOf(retired), 1);
          await retired.close();
        }
        const directory = await realpath(
          await mkdtemp(path.join(os.tmpdir(), "lemma-warm-")),
        );
        client = new WarmClient({ directory, environment, sandboxProfile });
        client.key = key;
        this.clients.push(client);
      }
      clearTimeout(client.idleTimer);
      client.ownerId = options.runId || null;
      client.busy = true;
    } finally {
      release();
    }
    try {
      return await nativeSpan("native.exploration", () =>
        client.run(code, options),
      );
    } finally {
      client.busy = false;
      if (client.failure) {
        this.clients = this.clients.filter((c) => c !== client);
        await client.close();
      } else {
        client.idleTimer = setTimeout(() => {
          if (!client.busy) {
            this.clients = this.clients.filter((c) => c !== client);
            void client.close().catch(() => {});
          }
        }, this.idleMs);
        client.idleTimer.unref();
      }
    }
  }
  async closeOwner(ownerId) {
    const owned = this.clients.filter((c) => c.ownerId === ownerId);
    if (owned.some((c) => c.busy))
      throw Error("Warm work must drain before closing its owner");
    this.clients = this.clients.filter((c) => c.ownerId !== ownerId);
    await Promise.all(
      owned.map((c) => {
        clearTimeout(c.idleTimer);
        return c.close();
      }),
    );
  }
  async close() {
    await Promise.all(
      this.clients.map((c) => {
        clearTimeout(c.idleTimer);
        return c.close();
      }),
    );
    this.clients = [];
  }
}
