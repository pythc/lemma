import { AsyncLocalStorage } from "node:async_hooks";
export const verificationContext = new AsyncLocalStorage();
import { nativeSpan } from "./native-timing.mjs";
import { createReadStream } from "node:fs";
import { readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { digest } from "./evidence.mjs";

const inFlight = new Map();
export async function sharedContentTree(root, roots, options = {}) {
  options = {
    ...verificationContext.getStore(),
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    ),
  };
  options.signal?.throwIfAborted();
  const key = JSON.stringify([
    path.resolve(root),
    roots,
    !!options.includeFiles,
    options.verificationEpoch || "shared",
  ]);
  let job = inFlight.get(key);
  const coalesced = !!job;
  if (!job) {
    const controller = new AbortController();
    job = { controller, consumers: 0 };
    const current = job;
    job.promise = contentTree(root, roots, {
      ...options,
      signal: controller.signal,
    }).finally(() => {
      if (inFlight.get(key) === current) inFlight.delete(key);
    });
    job.promise.catch(() => {});
    inFlight.set(key, job);
  }
  job.consumers++;
  let onAbort;
  try {
    return await nativeSpan(
      "environment.shared_verify",
      async () =>
        structuredClone(
          await Promise.race([
            job.promise,
            new Promise((_, reject) => {
              onAbort = () =>
                reject(options.signal.reason || Error("Cancelled"));
              options.signal?.addEventListener("abort", onAbort, {
                once: true,
              });
              if (options.signal?.aborted) onAbort();
            }),
          ]),
        ),
      { coalesced, cache: "in_flight_only" },
    );
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (--job.consumers === 0) {
      if (inFlight.get(key) === job) inFlight.delete(key);
      job.controller.abort(Error("No verification consumers remain"));
      await job.promise.catch(() => {});
    }
  }
}

// Include imported objects and native libraries, not only the small Lean launcher.
export function contentTree(root, roots, options = {}) {
  options = {
    ...verificationContext.getStore(),
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    ),
  };
  const stats = { roots: [...roots], files: 0, bytes: 0 };
  return nativeSpan(
    "environment.content_hash",
    () => contentTreeReserved(root, roots, options, stats),
    stats,
  );
}
async function contentTreeReserved(
  root,
  roots,
  { includeFiles = false, signal } = {},
  stats,
) {
  const paths = [];
  async function visit(relative) {
    signal?.throwIfAborted();
    const full = path.join(root, relative),
      info = await lstat(full);
    if (info.isDirectory()) {
      for (const name of (await readdir(full)).sort())
        await visit(path.join(relative, name));
    } else if (info.isFile()) paths.push(relative);
    else throw new Error("工具链目录包含不支持的文件类型。");
  }
  for (const relative of roots) await visit(relative);
  // Read every byte on every verification. Bounded parallel I/O hides stream
  // setup latency without trusting mtimes or changing the historical ordering.
  const files = new Array(paths.length);
  let next = 0,
    failure;
  const worker = async () => {
    while (!failure && next < paths.length) {
      const index = next++,
        relative = paths[index];
      try {
        signal?.throwIfAborted();
        const hash = createHash("sha256");
        for await (const bytes of createReadStream(path.join(root, relative), {
          signal,
        })) {
          hash.update(bytes);
          stats.bytes += bytes.length;
        }
        stats.files++;
        files[index] = { path: relative, sha256: hash.digest("hex") };
      } catch (error) {
        failure ||= error;
      }
    }
  };
  // Await all already-open readers before reporting a failed verification.
  await Promise.all(Array.from({ length: Math.min(8, paths.length) }, worker));
  if (failure) throw failure;
  return {
    schema: "lemma.toolchain-tree.v1",
    sha256: digest(files),
    fileCount: files.length,
    ...(includeFiles ? { files } : {}),
  };
}
export const toolchainTree = (root) => sharedContentTree(root, ["bin", "lib"]);
