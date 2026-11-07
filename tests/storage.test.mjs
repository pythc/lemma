import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  annotationsFor,
  saveAnnotation,
  savePaper,
  activePaper,
  annotationComments,
  appendAnnotationComment,
  readerChatFor,
  rememberReaderChat,
} from "../src/storage.js";
import { createAnnotation } from "../src/domain.js";

const anchor = {
  pageIndex: 0,
  rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.1 }],
  quote: "first claim",
};

test("switching papers preserves notes without leaking them to the other document", async () => {
  const a = { id: "storage-paper-a", pageCount: 1, isDemo: false },
    b = { id: "storage-paper-b", pageCount: 1, isDemo: false };
  await savePaper(a);
  const note = createAnnotation(a, anchor, "Keep me", "Actual user note");
  await saveAnnotation(note);
  await savePaper(b);
  assert.deepEqual(await annotationsFor(b.id), []);
  assert.equal((await activePaper()).id, b.id);
  assert.equal((await annotationsFor(a.id))[0].body, "Actual user note");
});

test("concurrent annotation comments append atomically and stay isolated by paper and note", async () => {
  await savePaper({ id: "comments-a", pageCount: 1 });
  await savePaper({ id: "comments-b", pageCount: 1 });
  await Promise.all([appendAnnotationComment("comments-a", "note", "First"), appendAnnotationComment("comments-a", "note", "Second")]);
  assert.equal((await annotationComments("comments-a", "note")).length, 2);
  assert.deepEqual(await annotationComments("comments-b", "note"), []);
  assert.deepEqual(await annotationComments("comments-a", "other"), []);
  await assert.rejects(appendAnnotationComment("comments-a", "note", " "), /评论/);
  await rememberReaderChat("comments-a", "passage", [{ id: "pending-job", status: "running" }]);
  assert.equal((await readerChatFor("comments-a", "passage"))[0].id, "pending-job");
  assert.deepEqual(await readerChatFor("comments-b", "passage"), []);
});
test("reopening and reseeding a document does not overwrite human review state", async () => {
  const p = { id: "storage-demo", pageCount: 1, isDemo: true };
  const note = createAnnotation(p, anchor, "Claim", "Reason");
  await savePaper(p, [note]);
  await saveAnnotation({ ...note, status: "human_reviewed" });
  await savePaper(p, [note]);
  assert.equal((await annotationsFor(p.id))[0].status, "human_reviewed");
});
test("version mismatch is rejected before an annotation enters storage", async () => {
  const p = { id: "storage-version", pageCount: 1 };
  await savePaper(p);
  const note = createAnnotation(p, anchor, "Claim", "Reason");
  await assert.rejects(
    saveAnnotation({ ...note, paperSha256: "different-version" }),
    /版本不匹配/,
  );
  assert.deepEqual(await annotationsFor(p.id), []);
});
