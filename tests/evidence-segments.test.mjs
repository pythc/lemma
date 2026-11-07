import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvidenceStore } from "../server/evidence.mjs";
import {
  exportEvidenceSegments,
  walkEvidence,
  verifyEvidenceSegments,
} from "../server/evidence-stream.mjs";
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "segments-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new EvidenceStore(path.join(dir, "store"));
  await store.init();
  let root = await store.put("base", { raw: "source" });
  for (let i = 0; i < 25; i++) root = await store.put("event", { i }, [root]);
  return { dir, store, root, out: path.join(dir, "out") };
}
test("interrupted export resumes committed chunks without executing anything", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(
    exportEvidenceSegments(f.store, f.root, f.out, {
      onChunk: () => {
        if (++calls === 9) throw Error("simulated disconnect");
      },
    }),
    /disconnect/,
  );
  let resumed = 0;
  const done = await exportEvidenceSegments(f.store, f.root, f.out, {
    onChunk: () => resumed++,
  });
  assert.equal(done.count, 26);
  assert.equal(resumed, 17);
  const ids = [];
  for await (const a of walkEvidence(f.store, f.root)) ids.push(a.id);
  assert.equal(new Set(ids).size, 26);
  assert.equal(
    JSON.parse(await readFile(path.join(f.out, "manifest.json"))).status,
    "complete",
  );
  assert.equal((await verifyEvidenceSegments(f.out)).count, 26);
});
test("corrupted acknowledged chunk and wrong root fail closed", async (t) => {
  const f = await fixture(t);
  await exportEvidenceSegments(f.store, f.root, f.out);
  await writeFile(path.join(f.out, f.root + ".json"), "corrupt");
  await assert.rejects(
    exportEvidenceSegments(f.store, f.root, f.out),
    /corrupt/,
  );
  assert.notEqual(
    JSON.parse(await readFile(path.join(f.out, "manifest.json"))).status,
    "complete",
  );
  const other = await f.store.put("other", {});
  await assert.rejects(
    exportEvidenceSegments(f.store, other, f.out),
    /another sealed root/,
  );
});
test("disk-space refusal preserves source and does not publish completion", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    exportEvidenceSegments(f.store, f.root, f.out, {
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    }),
    /disk space/,
  );
  assert.notEqual(
    JSON.parse(await readFile(path.join(f.out, "manifest.json"))).status,
    "complete",
  );
  assert.equal((await f.store.get(f.root)).id, f.root);
});
