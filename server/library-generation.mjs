// Atomic publication only. Building a new generation never modifies a leased one.
import {
  readFile,
  mkdir,
  rename,
  writeFile,
  statfs,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireFileLease } from "./file-lease.mjs";
import { isHash } from "./evidence.mjs";
import { nativeSpan } from "./native-timing.mjs";
export async function readGeneration(root) {
  try {
    const g = JSON.parse(
      await readFile(path.join(root, "current.json"), "utf8"),
    );
    if (g.schema !== "lemma.library-generation.v1" || !isHash(g.snapshotId))
      throw Error("Invalid library generation publication");
    return g;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export async function publishGeneration(root, generation, { signal } = {}) {
  if (!isHash(generation.snapshotId))
    throw Error("Invalid generation snapshot");
  await mkdir(root, { recursive: true });
  const lease = await acquireFileLease(
    path.join(root, "publish.lock"),
    "write",
    { signal },
  );
  try {
    const previous = await readGeneration(root);
    if (generation.parentSnapshotId !== (previous?.snapshotId || null))
      throw Error(
        "Generation publication changed while preparing; prepared evidence retained",
      );
    const value = {
      ...generation,
      schema: "lemma.library-generation.v1",
      publishedAt: new Date().toISOString(),
    };
    const temp = path.join(root, `.publication-${randomUUID()}.json`);
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    signal?.throwIfAborted();
    lease.assertHeld();
    await rename(temp, path.join(root, "current.json"));
    return value;
  } finally {
    await lease.release();
  }
}
export async function generationCapacity(root, requiredBytes) {
  await mkdir(root, { recursive: true });
  const s = await statfs(root);
  const available = s.bavail * s.bsize;
  // Reserve physical headroom even when the filesystem supports cloned copies.
  if (available < requiredBytes)
    throw Object.assign(
      Error(
        "Insufficient disk space for an isolated library generation; no live files were changed",
      ),
      {
        code: "environment_storage_full",
        details: { availableBytes: available, requiredBytes },
      },
    );
  return { availableBytes: available, requiredBytes };
}
export function generationBuild(root, action, { signal } = {}) {
  return nativeSpan("environment.generation_queue", async () => {
    const lease = await acquireFileLease(
      path.join(root, "build.lock"),
      "write",
      { signal },
    );
    try {
      return await nativeSpan("environment.generation_build", action);
    } finally {
      await lease.release();
    }
  });
}

// Admission and continuous physical-space guard, independent of mathematical
// task policy. A filesystem cannot promise reserved blocks to this process;
// exhaustion is a resource failure and never publishes a partial generation.
export async function guardedGeneration(
  root,
  stage,
  action,
  {
    signal,
    headroom = 2 * 1024 ** 3,
    check = generationCapacity,
    pollMs = 1000,
  } = {},
) {
  const admission = await check(root, headroom);
  const controller = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const allocation = {
    schema: "lemma.generation-allocation.v1",
    ...admission,
    headroom,
    growthBudgetBytes: admission.availableBytes - headroom,
    admittedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(stage, "allocation.json"),
    JSON.stringify(allocation),
  );
  let pending = Promise.resolve(),
    checking = false;
  const timer = setInterval(() => {
    if (checking || combined.aborted) return;
    checking = true;
    pending = check(root, headroom)
      .catch((e) => controller.abort(e))
      .finally(() => {
        checking = false;
      });
  }, pollMs);
  timer.unref();
  try {
    const result = await action(combined);
    await pending;
    combined.throwIfAborted();
    await check(root, headroom);
    return result;
  } finally {
    clearInterval(timer);
    await pending;
  }
}

// Recoverable maintenance only: snapshots (including historical/archived ones)
// are never GC'd. Build lease excludes active staging; restore is a rename.
export async function quarantineGeneration(root, name, { signal } = {}) {
  if (!/^staging-[0-9a-f-]{36}$/.test(name))
    throw Error("Invalid staging generation identity");
  return generationBuild(
    root,
    async () => {
      const stage = path.join(root, name);
      if (
        !(await lstat(stage)).isDirectory() ||
        (await lstat(stage)).isSymbolicLink()
      )
        throw Error("Generation must be a real staging directory");
      const terminal = await Promise.all(
        ["failure.json", "published.json"].map((f) =>
          readFile(path.join(stage, f), "utf8")
            .then(JSON.parse)
            .catch((e) => {
              if (e.code === "ENOENT") return null;
              throw e;
            }),
        ),
      );
      if (!terminal.some(Boolean))
        throw Error(
          "Generation has no terminal receipt; retain unknown preparation",
        );
      const quarantine = path.join(root, "quarantine");
      await mkdir(quarantine, { recursive: true });
      const destination = path.join(quarantine, name);
      await rename(stage, destination);
      return {
        source: stage,
        destination,
        recoverable: true,
        snapshotsRemoved: 0,
      };
    },
    { signal },
  );
}
