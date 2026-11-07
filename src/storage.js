import { reviewOutcome } from "../shared/review-outcome.mjs";
import { openDB } from "idb";
import { validateAnchor } from "./domain.js";

const dbPromise = () =>
  openDB("lemma-review-v1", 1, {
    upgrade(db) {
      db.createObjectStore("papers", { keyPath: "id" });
      const notes = db.createObjectStore("annotations", { keyPath: "id" });
      notes.createIndex("paperId", "paperId");
      db.createObjectStore("settings");
    },
  });

export async function savePaper(paper, notes = []) {
  for (const note of notes) {
    if (note.paperId !== paper.id || note.paperSha256 !== paper.id)
      throw new Error("批注与论文版本不一致。");
    validateAnchor(note.anchor, paper.pageCount);
  }
  const db = await dbPromise();
  const tx = db.transaction(["papers", "annotations", "settings"], "readwrite");
  await tx.objectStore("papers").put(paper);
  for (const note of notes) {
    if (!(await tx.objectStore("annotations").get(note.id)))
      await tx.objectStore("annotations").put(note);
  }
  await tx.objectStore("settings").put(paper.id, "activePaper");
  await tx.done;
}

export async function listPapers() {
  return (await dbPromise()).getAll("papers");
}
export async function activePaper() {
  const db = await dbPromise();
  const id = await db.get("settings", "activePaper");
  return id ? db.get("papers", id) : undefined;
}
export async function annotationsFor(id) {
  return (await dbPromise()).getAllFromIndex("annotations", "paperId", id);
}
export async function saveAnnotation(note) {
  const db = await dbPromise();
  const tx = db.transaction(["papers", "annotations"], "readwrite");
  const paper = await tx.objectStore("papers").get(note.paperId);
  if (!paper || note.paperSha256 !== paper.id) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new Error("论文版本不匹配，批注未保存。");
  }
  try {
    validateAnchor(note.anchor, paper.pageCount);
  } catch (error) {
    tx.abort();
    await tx.done.catch(() => {});
    throw error;
  }
  await tx.objectStore("annotations").put(note);
  await tx.done;
}

export async function reviewRunFor(paperId) {
  return (await dbPromise()).get("settings", `review:${paperId}`);
}
export async function rememberReview(paperId, runId) {
  return (await dbPromise()).put("settings", runId, `review:${paperId}`);
}

export async function annotationComments(paperId, noteId) {
  return (await dbPromise())
    .get("settings", `comments:${paperId}:${noteId}`)
    .then((v) => v || []);
}
export async function appendAnnotationComment(paperId, noteId, text) {
  const body = String(text || "").trim();
  if (!body || body.length > 5000)
    throw new Error("评论须为 1 至 5000 个字符。");
  const db = await dbPromise();
  const tx = db.transaction(["papers", "settings"], "readwrite");
  if (!(await tx.objectStore("papers").get(paperId))) {
    tx.abort();
    await tx.done.catch(() => {});
    throw new Error("论文尚未保存。");
  }
  const key = `comments:${paperId}:${noteId}`;
  const comments = (await tx.objectStore("settings").get(key)) || [];
  comments.push({
    id: crypto.randomUUID(),
    body,
    author: "我",
    createdAt: new Date().toISOString(),
  });
  await tx.objectStore("settings").put(comments, key);
  await tx.done;
  return comments;
}
export async function readerChatFor(paperId, contextKey) {
  return (await dbPromise())
    .get("settings", `chat:${paperId}:${contextKey}`)
    .then((v) => v || []);
}
export async function rememberReaderChat(paperId, contextKey, jobs) {
  return (await dbPromise()).put(
    "settings",
    jobs,
    `chat:${paperId}:${contextKey}`,
  );
}

// Separate from the server's semantic approval. Bound to the immutable result root.
export async function resultAcknowledgements(paperId) {
  return (await dbPromise())
    .get("settings", `result-seen:${paperId}`)
    .then((v) => v || {});
}
export async function acknowledgeResult(paperId, run) {
  if (
    !paperId ||
    !run ||
    run.paperSha256 !== paperId ||
    !reviewOutcome(run).hasReport ||
    !run.root
  )
    throw new Error("评审尚未结束，不能展示结果。");
  const db = await dbPromise();
  const tx = db.transaction("settings", "readwrite");
  const key = `result-seen:${paperId}`;
  const values = (await tx.store.get(key)) || {};
  values[`${run.id}:${run.root}`] = true;
  await tx.store.put(values, key);
  await tx.done;
  return values;
}
