import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../server/evidence.mjs";
import { contentTree } from "../server/toolchain-tree.mjs";
import {
  readLibrarySnapshot,
  sealLibrarySnapshot,
  restoreHistoricalSnapshot,
} from "../server/library-snapshot.mjs";

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lemma-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = path.join(directory, "source"),
    roots = ["build"];
  const snapshotRoot = path.join(directory, "snapshots");
  await mkdir(path.join(sourceRoot, "build"), { recursive: true });
  const manifest = Buffer.from('{"packages":[]}');
  await writeFile(path.join(sourceRoot, "lake-manifest.json"), manifest);
  await writeFile(
    path.join(sourceRoot, "build/Old.olean"),
    "INTEGRITY FIXTURE, NOT A PROOF",
  );
  const options = {
    sourceRoot,
    roots,
    snapshotRoot,
    commit: "fixture",
    manifestSha256: sha256(manifest),
  };
  const identity = async () => ({
    commit: options.commit,
    manifestSha256: options.manifestSha256,
    content: await contentTree(sourceRoot, roots),
  });
  return { options, identity };
}

test("a published snapshot survives cache growth and is never hard-linked to mutable files", async (t) => {
  const { options, identity } = await setup(t);
  const first = await sealLibrarySnapshot({
    ...options,
    identity: await identity(),
  });
  const before = await readFile(
    path.join(first.directory, "build/Old.olean"),
    "utf8",
  );
  const a = await stat(path.join(options.sourceRoot, "build/Old.olean"));
  const b = await stat(path.join(first.directory, "build/Old.olean"));
  assert.notEqual(a.ino, b.ino);
  await writeFile(
    path.join(options.sourceRoot, "build/New.olean"),
    "NEW INTEGRITY FIXTURE",
  );
  const second = await sealLibrarySnapshot({
    ...options,
    identity: await identity(),
  });
  assert.notEqual(first.descriptor.id, second.descriptor.id);
  const restored = await readLibrarySnapshot(first.descriptor.id, options);
  assert.equal(
    await readFile(path.join(restored.directory, "build/Old.olean"), "utf8"),
    before,
  );
  await assert.rejects(
    readFile(path.join(restored.directory, "build/New.olean")),
    { code: "ENOENT" },
  );
});

test("historical inventories recover exactly the old subset, never changed bytes", async (t) => {
  const { options, identity } = await setup(t);
  options.historyRoot = path.join(options.sourceRoot, "history");
  const recordDirectory = path.join(
    options.historyRoot,
    "00000000-0000-0000-0000-000000000000",
  );
  await mkdir(recordDirectory, { recursive: true });
  await mkdir(path.join(options.historyRoot, "00000000-0000-0000-0000-000000000001"));
  const content = await contentTree(options.sourceRoot, options.roots, {
    includeFiles: true,
  });
  const metadata = { ...(await identity()), roots: options.roots };
  await writeFile(
    path.join(recordDirectory, "before.json"),
    JSON.stringify({
      metadata,
      files: content.files,
    }),
  );
  await writeFile(
    path.join(options.sourceRoot, "build/New.olean"),
    "AFTER ARCHIVE",
  );
  const restored = await restoreHistoricalSnapshot(
    metadata.content.sha256,
    options,
  );
  assert.equal(restored.descriptor.id, metadata.content.sha256);
  await assert.rejects(
    readFile(path.join(restored.directory, "build/New.olean")),
    { code: "ENOENT" },
  );
  options.snapshotRoot = path.join(
    options.sourceRoot,
    "another-snapshot-store",
  );
  await writeFile(
    path.join(options.sourceRoot, "build/Old.olean"),
    "OLD FILE CHANGED",
  );
  await assert.rejects(
    restoreHistoricalSnapshot(metadata.content.sha256, options),
    { code: "library_history_content_missing" },
  );
});

test("concurrent publishers converge on one verified identity", async (t) => {
  const { options, identity } = await setup(t);
  const publication = await identity();
  const [a, b] = await Promise.all([
    sealLibrarySnapshot({ ...options, identity: publication }),
    sealLibrarySnapshot({ ...options, identity: publication }),
  ]);
  assert.equal(a.directory, b.directory);
  assert.deepEqual(a.descriptor, b.descriptor);
});

test("changed cache, missing archived snapshot and tampered snapshot fail closed", async (t) => {
  const { options, identity } = await setup(t);
  const original = await identity();
  await writeFile(path.join(options.sourceRoot, "build/New.olean"), "changed");
  await assert.rejects(
    sealLibrarySnapshot({ ...options, identity: original }),
    { code: "library_publication_changed" },
  );
  await assert.rejects(readLibrarySnapshot(original.content.sha256, options), {
    code: "library_snapshot_missing",
  });
  const saved = await sealLibrarySnapshot({
    ...options,
    identity: await identity(),
  });
  const file = path.join(saved.directory, "build/Old.olean");
  await chmod(file, 0o600);
  await writeFile(file, "TAMPERED");
  await assert.rejects(readLibrarySnapshot(saved.descriptor.id, options), {
    code: "library_snapshot_digest_mismatch",
  });
  await assert.rejects(
    sealLibrarySnapshot({ ...options, identity: await identity() }),
    { code: "library_snapshot_digest_mismatch" },
  );
});
