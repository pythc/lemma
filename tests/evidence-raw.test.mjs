import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { streamArtifact, copyArtifactFile } from "../server/evidence-raw.mjs";
import {
  exportEvidenceSegments,
  verifyEvidenceSegments,
} from "../server/evidence-stream.mjs";
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raw-evidence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new EvidenceStore(path.join(dir, "store"));
  await store.init();
  return { dir, store };
}
test("large payload and split envelope preserve original bytes without decoding payload", async (t) => {
  const f = await fixture(t),
    inputs = Array.from({ length: 1100 }, (_, i) => sha256(String(i)));
  const id = await f.store.put(
    "large",
    {
      text: "x".repeat(32 * 1024 * 1024),
      quoted: ',"payload":',
      unicode: "中文",
    },
    inputs,
  );
  const file = path.join(f.store.root, "artifacts", id + ".json"),
    out = path.join(f.dir, "copy.json");
  const header = await copyArtifactFile(file, out, id);
  assert.equal(header.inputs.length, 1100);
  assert.equal(header.kind, "large");
  assert.equal(sha256(await readFile(out)), id);
  await assert.rejects(
    streamArtifact(file, id, { maxHeaderBytes: 65536 }),
    /envelope/,
  );
  const controller = new AbortController();
  await assert.rejects(
    streamArtifact(file, id, {
      signal: controller.signal,
      onChunk: () => controller.abort(),
    }),
    /abort/i,
  );
});
test("corrupt bytes never publish a destination and remove the temporary object", async (t) => {
  const f = await fixture(t),
    id = sha256("valid"),
    source = path.join(f.dir, "source"),
    destination = path.join(f.dir, "out");
  await writeFile(source, '{"inputs":[],"kind":"test","payload":null}');
  await assert.rejects(copyArtifactFile(source, destination, id), /digest/);
  assert.deepEqual((await readdir(f.dir)).sort(), ["source", "store"]);
});
test("process death after a committed large export chunk resumes without dropping its graph", async (t) => {
  const f = await fixture(t),
    leaf = await f.store.put("large", { text: "z".repeat(12 * 1024 * 1024) }),
    root = await f.store.put("report", {}, [leaf]);
  const out = path.join(f.dir, "export");
  const child = fork(
    new URL("./helpers/export-crash.mjs", import.meta.url),
    [f.store.root, root, out],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  t.after(() => child.kill("SIGKILL"));
  await once(child, "message");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const result = await exportEvidenceSegments(f.store, root, out);
  assert.equal(result.count, 2);
  assert.equal((await verifyEvidenceSegments(out)).root, root);
});
