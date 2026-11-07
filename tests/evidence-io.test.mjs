import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { EvidenceStore, inspectBundle } from "../server/evidence.mjs";
import {
  writeEvidenceFile,
  readEvidenceFile,
  sendEvidence,
} from "../server/evidence-io.mjs";

test("stream and legacy downloads preserve every artifact and shared ancestry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-evidence-io-"));
  try {
    const store = new EvidenceStore(dir);
    await store.init();
    const shared = await store.put("source", { text: "源文\n".repeat(2000) });
    const a = await store.put("a", { value: 1 }, [shared]);
    const b = await store.put("b", { value: 2 }, [shared]);
    const root = await store.put("report", { result: "partial" }, [a, b]);
    const expected = (await store.bundle(root)).artifacts
      .map((a) => a.id)
      .sort();
    for (const format of ["json", "ndjson"]) {
      const file = path.join(dir, `out.${format}`);
      await writeEvidenceFile(file, store, root, format);
      const bundle = await readEvidenceFile(file);
      assert.deepEqual(bundle.artifacts.map((a) => a.id).sort(), expected);
      assert.equal(inspectBundle(bundle, root).root.id, root);
      const chunks = [];
      const response = new Writable({
        highWaterMark: 8,
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk));
          setImmediate(done);
        },
      });
      response.writeHead = (status, headers) => {
        assert.equal(status, 200);
        assert.match(headers["Content-Disposition"], /attachment/);
      };
      const done = finished(response);
      await sendEvidence(response, store, root, { format });
      await done;
      const downloaded = path.join(dir, `download.${format}`);
      await writeFile(downloaded, Buffer.concat(chunks));
      assert.equal((await readEvidenceFile(downloaded)).root, root);
    }
    let writes = 0;
    const canceled = new Writable({
      highWaterMark: 8,
      write(_chunk, _encoding, done) {
        if (++writes === 2) this.destroy();
        setImmediate(done);
      },
    });
    canceled.writeHead = () => {};
    await assert.rejects(
      () => sendEvidence(canceled, store, root, { format: "ndjson" }),
      /取消/,
    );
    const file = path.join(dir, "out.ndjson");
    const original = await readFile(file, "utf8");
    await writeFile(
      file,
      original.replace('"result":"partial"', '"result":"verified"'),
    );
    await assert.rejects(() => readEvidenceFile(file), /修改|摘要/);
    await writeFile(
      file,
      original.slice(0, original.lastIndexOf("\n", original.length - 2)),
    );
    await assert.rejects(() => readEvidenceFile(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed export preserves the prior file and rejects a missing root before HTTP headers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-evidence-failure-"));
  try {
    const store = new EvidenceStore(dir);
    await store.init();
    const file = path.join(dir, "out.ndjson");
    await writeFile(file, "prior");
    await assert.rejects(() => writeEvidenceFile(file, store, "a".repeat(64)));
    assert.equal(await readFile(file, "utf8"), "prior");
    let sent = false;
    await assert.rejects(() =>
      sendEvidence(
        {
          writeHead() {
            sent = true;
          },
        },
        store,
        "a".repeat(64),
      ),
    );
    assert.equal(sent, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
