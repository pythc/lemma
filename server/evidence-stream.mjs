import { streamArtifact, copyArtifactFile } from "./evidence-raw.mjs";
import { durableFile, syncDirectory } from "./durable-files.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  rm,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { isHash, sha256 } from "./evidence.mjs";

// Disk-backed reachability and ordered chunks. The index is disposable; chunks
// are verified against the original store, never treated as new proof receipts.
export async function exportEvidenceSegments(
  store,
  root,
  directory,
  { signal, onChunk, minFreeBytes = 64 * 1024 * 1024 } = {},
) {
  if (!isHash(root)) throw Error("Invalid evidence root");
  await streamArtifact(
    path.join(store.root, "artifacts", root + ".json"),
    root,
  );
  await mkdir(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "export.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS meta(root TEXT);CREATE TABLE IF NOT EXISTS nodes(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,state INTEGER DEFAULT 0,bytes INTEGER,chunk TEXT);CREATE INDEX IF NOT EXISTS nodes_pending ON nodes(state,seq);",
  );
  try {
    const old = db.prepare("SELECT root FROM meta").get();
    if (old && old.root !== root)
      throw Error("Export directory belongs to another sealed root");
    if (!old) db.prepare("INSERT INTO meta VALUES(?)").run(root);
    await durableFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        schemaVersion: "lemma.evidence-segments.v1",
        status: "verifying",
        root,
      }),
    );
    db.prepare("INSERT OR IGNORE INTO nodes(id) VALUES(?)").run(root);
    // Reconcile acknowledged chunks before using their traversal state. A missing
    // or corrupted acknowledged chunk is not silently accepted as a good export.
    for (const row of db
      .prepare("SELECT * FROM nodes WHERE state=1 ORDER BY seq")
      .iterate()) {
      signal?.throwIfAborted();
      try {
        await streamArtifact(path.join(directory, row.chunk), row.id, {
          signal,
        });
      } catch (error) {
        throw Error(
          `Acknowledged export chunk is missing or corrupt: ${error.message}`,
        );
      }
    }
    let row;
    while (
      (row = db
        .prepare("SELECT * FROM nodes WHERE state=0 ORDER BY seq LIMIT 1")
        .get())
    ) {
      signal?.throwIfAborted();
      const space = await statfs(directory);
      if (space.bavail * space.bsize < minFreeBytes)
        throw Error(
          "Insufficient export disk space; committed chunks retained",
        );
      const chunk = row.id + ".json";
      const artifact = await copyArtifactFile(
        path.join(store.root, "artifacts", chunk),
        path.join(directory, chunk),
        row.id,
        { signal },
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const id of artifact.inputs) {
          if (!isHash(id)) throw Error("Invalid evidence dependency");
          db.prepare("INSERT OR IGNORE INTO nodes(id) VALUES(?)").run(id);
        }
        db.prepare("UPDATE nodes SET state=1,bytes=?,chunk=? WHERE id=?").run(
          artifact.bytes,
          chunk,
          row.id,
        );
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      await onChunk?.({ id: row.id, bytes: artifact.bytes, seq: row.seq });
    }
    const inventory = path.join(directory, "chunks.jsonl"),
      tmp = inventory + ".tmp";
    const output = await open(tmp, "w", 0o600);
    let count = 0,
      bytes = 0;
    try {
      for (const r of db
        .prepare("SELECT id,bytes,chunk FROM nodes ORDER BY seq")
        .iterate()) {
        await output.writeFile(JSON.stringify(r) + "\n");
        count++;
        bytes += r.bytes;
      }
      await output.sync();
    } finally {
      await output.close();
    }
    await rename(tmp, inventory);
    await syncDirectory(directory);
    // Streaming digest avoids retaining an unbounded manifest array.
    const { createReadStream } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256");
    for await (const b of createReadStream(inventory)) hash.update(b);
    const result = {
      schemaVersion: "lemma.evidence-segments.v1",
      status: "complete",
      root,
      count,
      bytes,
      inventory: "chunks.jsonl",
      inventorySha256: hash.digest("hex"),
    };
    const done = path.join(directory, "manifest.json");
    await durableFile(done, JSON.stringify(result));
    return result;
  } finally {
    db.close();
  }
}

export async function* walkEvidence(
  store,
  root,
  { signal, indexRoot, metadataOnly = false } = {},
) {
  const directory = await mkdtemp(
    path.join(indexRoot || os.tmpdir(), "lemma-export-"),
  );
  const db = new DatabaseSync(path.join(directory, "walk.sqlite"));
  db.exec(
    "CREATE TABLE queue(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,seen INTEGER DEFAULT 0);CREATE INDEX queue_pending ON queue(seen,seq)",
  );
  db.prepare("INSERT INTO queue(id) VALUES(?)").run(root);
  try {
    let row;
    while (
      (row = db
        .prepare("SELECT * FROM queue WHERE seen=0 ORDER BY seq LIMIT 1")
        .get())
    ) {
      signal?.throwIfAborted();
      const a = metadataOnly
        ? await streamArtifact(
            path.join(store.root, "artifacts", row.id + ".json"),
            row.id,
            { signal },
          )
        : await store.get(row.id);
      db.exec("BEGIN");
      try {
        for (const id of a.inputs)
          db.prepare("INSERT OR IGNORE INTO queue(id) VALUES(?)").run(id);
        db.prepare("UPDATE queue SET seen=1 WHERE id=?").run(row.id);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      yield a;
    }
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyEvidenceSegments(directory, { signal } = {}) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  );
  if (
    manifest.schemaVersion !== "lemma.evidence-segments.v1" ||
    manifest.status !== "complete" ||
    manifest.inventory !== "chunks.jsonl" ||
    !isHash(manifest.root)
  )
    throw Error("Export is not a complete supported manifest");
  const { createReadStream } = await import("node:fs"),
    { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(
    path.join(directory, "chunks.jsonl"),
    { signal },
  ))
    hash.update(bytes);
  if (hash.digest("hex") !== manifest.inventorySha256)
    throw Error("Export inventory digest mismatch");
  let count = 0,
    total = 0;
  const store = {
    get: async (id) => {
      const a = await streamArtifact(path.join(directory, id + ".json"), id, {
        signal,
      });
      count++;
      total += a.bytes;
      return a;
    },
  };
  for await (const _ of walkEvidence(store, manifest.root, { signal })) {
  }
  if (count !== manifest.count || total !== manifest.bytes)
    throw Error("Export root reachability differs from manifest");
  return manifest;
}
