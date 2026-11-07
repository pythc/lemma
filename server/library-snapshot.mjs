import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
  chmod,
  realpath,
  readdir,
  copyFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sharedContentTree } from "./toolchain-tree.mjs";
import { digest, isHash, sha256 } from "./evidence.mjs";
import { acquireFileLease } from "./file-lease.mjs";

const error = (code, message, details = {}) =>
  Object.assign(new Error(message), { code, details });

export async function readLibrarySnapshot(id, options) {
  const { snapshotRoot, roots, commit, manifestSha256, signal } = options;
  if (!isHash(id))
    throw error(
      "library_snapshot_invalid",
      "Invalid library snapshot identity",
    );
  signal?.throwIfAborted();
  const directory = path.join(snapshotRoot, id);
  let descriptor;
  try {
    if ((await lstat(directory)).isSymbolicLink())
      throw error(
        "library_snapshot_invalid",
        "Snapshot directory is a symlink",
      );
    descriptor = JSON.parse(
      await readFile(path.join(directory, "snapshot.json"), "utf8"),
    );
  } catch (e) {
    if (e.code === "ENOENT")
      throw error(
        "library_snapshot_missing",
        "所需数学库快照不存在，未改用当前缓存。",
        { expected: id },
      );
    throw e;
  }
  if (
    descriptor.schemaVersion !== "lemma.library-snapshot.v1" ||
    descriptor.id !== id ||
    descriptor.content?.sha256 !== id ||
    descriptor.commit !== commit ||
    descriptor.manifestSha256 !== manifestSha256 ||
    JSON.stringify(descriptor.roots) !== JSON.stringify(roots)
  )
    throw error("library_snapshot_invalid", "数学库快照清单身份不符。", {
      expected: id,
    });
  const manifest = await readFile(path.join(directory, "lake-manifest.json"));
  if (sha256(manifest) !== manifestSha256)
    throw error("library_manifest_mismatch", "数学库快照依赖清单摘要不符。");
  const canonical = await realpath(directory);
  for (const relative of roots)
    if (
      (await realpath(path.join(directory, relative))) !==
      path.join(canonical, relative)
    )
      throw error("library_snapshot_invalid", "数学库快照路径包含符号链接。");
  const actual = await sharedContentTree(directory, roots, { signal });
  signal?.throwIfAborted();
  if (actual.sha256 !== id || actual.fileCount !== descriptor.content.fileCount)
    throw error(
      "library_snapshot_digest_mismatch",
      "数学库快照内容摘要不符。",
      {
        expected: id,
        actual: actual.sha256,
      },
    );
  return {
    descriptor,
    directory,
    searchPaths: roots.map((r) => path.join(directory, r)),
  };
}

export async function sealLibrarySnapshot({
  sourceRoot,
  identity,
  ...options
}) {
  const id = identity.content?.sha256;
  if (!isHash(id))
    throw error("library_snapshot_invalid", "Cannot seal an unbound library");
  const lookup = () =>
    readLibrarySnapshot(id, {
      ...options,
      commit: identity.commit,
      manifestSha256: identity.manifestSha256,
    });
  try {
    return await lookup();
  } catch (e) {
    if (e.code !== "library_snapshot_missing") throw e;
  }
  const lease = await acquireFileLease(
    path.join(options.snapshotRoot, ".locks", id),
    "write",
    options,
  );
  let stage;
  try {
    try {
      return await lookup();
    } catch (e) {
      if (e.code !== "library_snapshot_missing") throw e;
    }
    const sourceTree = await sharedContentTree(sourceRoot, options.roots, {
      signal: options.signal,
    });
    if (sourceTree.sha256 !== id)
      throw error(
        "library_publication_changed",
        "缓存内容与发布清单不一致，未创建快照。",
        {
          expected: id,
          actual: sourceTree.sha256,
        },
      );
    const manifest = await readFile(
      path.join(sourceRoot, "lake-manifest.json"),
    );
    if (sha256(manifest) !== identity.manifestSha256)
      throw error("library_manifest_mismatch", "缓存依赖清单摘要不符。");
    stage = path.join(options.snapshotRoot, `.staging-${id}-${randomUUID()}`);
    await mkdir(stage, { recursive: true });
    for (const relative of options.roots) {
      options.signal?.throwIfAborted();
      await cp(path.join(sourceRoot, relative), path.join(stage, relative), {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
        errorOnExist: true,
        force: false,
      });
    }
    const copied = await sharedContentTree(stage, options.roots, {
      includeFiles: true,
      signal: options.signal,
    });
    if (copied.sha256 !== id)
      throw error(
        "library_snapshot_copy_mismatch",
        "数学库快照复制后摘要不一致。",
        {
          expected: id,
          actual: copied.sha256,
        },
      );
    for (const item of copied.files)
      await chmod(path.join(stage, item.path), 0o444);
    const descriptor = {
      schemaVersion: "lemma.library-snapshot.v1",
      id,
      commit: identity.commit,
      manifestSha256: identity.manifestSha256,
      roots: options.roots,
      content: sourceTree,
    };
    await writeFile(path.join(stage, "lake-manifest.json"), manifest, {
      mode: 0o444,
    });
    await writeFile(
      path.join(stage, "snapshot.json"),
      JSON.stringify(descriptor, null, 2) + "\n",
      { mode: 0o444 },
    );
    options.signal?.throwIfAborted();
    lease.assertHeld();
    const directory = path.join(options.snapshotRoot, id);
    await rename(stage, directory);
    return {
      descriptor,
      directory,
      searchPaths: options.roots.map((r) => path.join(directory, r)),
    };
  } catch (e) {
    // Failed staging copies are retained, never accepted or silently overwritten.
    if (stage) e.snapshotStage = stage;
    throw e;
  } finally {
    await lease.release();
  }
}

// Append-only cache audits retained the exact previous file inventory. Recover
// that inventory by digest; never infer old contents from the latest manifest.
export async function restoreHistoricalSnapshot(id, options) {
  const {
    historyRoot,
    sourceRoot,
    snapshotRoot,
    roots,
    commit,
    manifestSha256,
  } = options;
  if (!isHash(id))
    throw error(
      "library_snapshot_invalid",
      "Invalid archived snapshot identity",
    );
  let inventory;
  for (const name of await readdir(historyRoot).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  })) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    const previous = await readFile(
      path.join(historyRoot, name, "before.json"),
      "utf8",
    ).catch((e) => {
      // A writer may have died immediately after making its audit directory.
      // Incomplete unrelated entries cannot stand in for a matching inventory.
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (previous === null) continue;
    const record = JSON.parse(previous);
    if (record.metadata?.content?.sha256 !== id) continue;
    if (
      record.metadata.commit !== commit ||
      record.metadata.manifestSha256 !== manifestSha256 ||
      JSON.stringify(record.metadata.roots) !== JSON.stringify(roots) ||
      !Array.isArray(record.files) ||
      digest(record.files) !== id
    )
      throw error(
        "library_history_mismatch",
        "历史数学库清单与请求身份不一致。",
      );
    inventory = record.files;
    break;
  }
  if (!inventory)
    throw error(
      "library_snapshot_missing",
      "所需数学库快照及其原始文件清单不存在，未改用新环境。",
      { expected: id },
    );
  const lease = await acquireFileLease(
    path.join(snapshotRoot, ".locks", id),
    "write",
    options,
  );
  let stage;
  try {
    try {
      return await readLibrarySnapshot(id, options);
    } catch (e) {
      if (e.code !== "library_snapshot_missing") throw e;
    }
    stage = path.join(snapshotRoot, `.staging-${id}-${randomUUID()}`);
    for (const relative of roots)
      await mkdir(path.join(stage, relative), { recursive: true });
    const canonical = await realpath(sourceRoot);
    for (const file of inventory) {
      options.signal?.throwIfAborted();
      if (
        typeof file.path !== "string" ||
        path.normalize(file.path) !== file.path ||
        !roots.some((root) => file.path.startsWith(root + path.sep)) ||
        !isHash(file.sha256)
      )
        throw error("library_history_mismatch", "历史库文件路径或摘要无效。");
      const source = path.join(sourceRoot, file.path);
      if ((await realpath(source)) !== path.join(canonical, file.path))
        throw error("library_history_mismatch", "历史库文件路径包含符号链接。");
      const destination = path.join(stage, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(
        source,
        destination,
        constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
      );
      await chmod(destination, 0o444);
    }
    const content = await sharedContentTree(stage, roots, {
      signal: options.signal,
    });
    if (content.sha256 !== id)
      throw error(
        "library_history_content_missing",
        "当前缓存不能恢复归档时的数学库内容。",
        {
          expected: id,
          actual: content.sha256,
        },
      );
    const manifest = await readFile(
      path.join(sourceRoot, "lake-manifest.json"),
    );
    if (sha256(manifest) !== manifestSha256)
      throw error("library_manifest_mismatch", "历史库依赖清单摘要不符。");
    const descriptor = {
      schemaVersion: "lemma.library-snapshot.v1",
      id,
      commit,
      manifestSha256,
      roots,
      content,
    };
    await writeFile(path.join(stage, "lake-manifest.json"), manifest, {
      mode: 0o444,
    });
    await writeFile(
      path.join(stage, "snapshot.json"),
      JSON.stringify(descriptor, null, 2) + "\n",
      { mode: 0o444 },
    );
    lease.assertHeld();
    await rename(stage, path.join(snapshotRoot, id));
    return {
      descriptor,
      directory: path.join(snapshotRoot, id),
      searchPaths: roots.map((p) => path.join(snapshotRoot, id, p)),
    };
  } catch (e) {
    if (stage) e.snapshotStage = stage;
    throw e;
  } finally {
    await lease.release();
  }
}
