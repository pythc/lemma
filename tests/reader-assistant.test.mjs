import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { EvidenceStore, sha256, inspectBundle } from "../server/evidence.mjs";
import { ReaderAssistant } from "../server/reader-assistant.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { createApp } from "../server/index.mjs";
import { annotationsFromRuns, dependencyTasks, workflowTasks } from "../src/reader-model.js";

const quote = "For every natural number n, n + 0 = n.";
async function input() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.TimesRoman);
  pdf.addPage([612, 792]).drawText(quote + " This is the right identity law.", { x: 35, y: 700, size: 10, font });
  const bytes = Buffer.from(await pdf.save());
  return { pdfBase64: bytes.toString("base64"), paperSha256: sha256(bytes), pageIndex: 0, quote, question: "What does this mean?" };
}
function answer(extra = {}) { return { answer: "Adding zero leaves the natural number unchanged.", citations: [{ pageIndex: 0, quote }], reviewSuggestion: { recommended: true, reason: "A formal proof can check the statement." }, ...extra }; }
async function wait(assistant, id) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (!assistant.active.has(id)) return assistant.get(id);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Reader test timed out");
}
async function harness(fn, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-reader-test-"));
  const store = new EvidenceStore(root); await store.init();
  let calls = 0;
  const assistant = new ReaderAssistant({ store, getConfig: async () => ({ configured: true }), model: async () => { calls++; return { parsed: answer(), record: { testOnly: true } }; }, ...overrides });
  await assistant.init();
  try { await fn(assistant, store, () => calls); } finally { await rm(root, { recursive: true, force: true }); }
}

test("reader explanations validate actual PDF anchors and export immutable inputs without asserting proof", async () => {
  await harness(async (assistant, store, calls) => {
    const source = await input();
    const job = await wait(assistant, (await assistant.start(source)).id);
    assert.equal(job.status, "completed"); assert.equal(calls(), 1);
    assert.equal(job.response.epistemicStatus, "model_explanation_not_verification");
    const inspected = inspectBundle(await store.bundle(job.responseArtifact));
    assert.equal(inspected.root.kind, "reader_explanation");
    assert.ok([...inspected.artifacts.values()].some((a) => a.payload.paper?.paperSha256 === source.paperSha256));
    const resumed = new ReaderAssistant({ store, getConfig: async () => null }); await resumed.init();
    assert.equal((await resumed.get(job.id)).response.answer, job.response.answer);
  });
});
test("source mismatch and invented selections never call the model", async () => {
  await harness(async (assistant, store, calls) => {
    const source = await input();
    await assert.rejects(assistant.start({ ...source, paperSha256: "a".repeat(64) }), /摘要/);
    const job = await wait(assistant, (await assistant.start({ ...source, quote: "invented theorem" })).id);
    assert.equal(job.status, "blocked"); assert.match(job.error, /依据/); assert.equal(calls(), 0);
  });
});
test("invented AI citations block the answer and preserve raw final I/O for diagnosis", async () => {
  await harness(async (assistant, store) => {
    const job = await wait(assistant, (await assistant.start(await input())).id);
    assert.equal(job.status, "blocked"); assert.equal(job.response, null); assert.equal(job.responseArtifact, null);
    assert.equal((await store.get(job.modelArtifact)).kind, "reader_model_response");
  }, { model: async () => ({ parsed: answer({ citations: [{ pageIndex: 0, quote: "Not present" }] }), record: { testOnly: true } }) });
});
test("followup history is bound to the same source and selection", async () => {
  const inputs = [];
  await harness(async (assistant) => {
    const source = await input(), first = await wait(assistant, (await assistant.start(source)).id);
    const second = await wait(assistant, (await assistant.start({ ...source, question: "Why?", parentId: first.id })).id);
    assert.equal(second.status, "completed"); assert.equal(inputs[1].history.length, 1);
    assert.equal(inputs[1].history[0].trust, "previous_model_explanation");
    await assert.rejects(assistant.start({ ...source, quote: "This is the right identity law.", parentId: first.id }), /选区/);
  }, { model: async (_, call) => { inputs.push(call.input); return { parsed: answer(), record: { testOnly: true } }; } });
});
test("reader serializes submission, supports cancellation, and never retries a failed response", async () => {
  let count = 0, started;
  const entered = new Promise((r) => { started = r; });
  await harness(async (assistant) => {
    const source = await input(), job = await assistant.start(source);
    await assert.rejects(assistant.start(source), /执行中/);
    await entered; await assistant.cancel(job.id);
    const final = await wait(assistant, job.id);
    assert.equal(final.status, "cancelled"); assert.equal(final.response, null); assert.equal(count, 1);
  }, { model: async (_, { signal }) => { count++; started(); await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); } });
});
test("HTTP reader routes enforce local origins and return asynchronous jobs without using a real model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-reader-http-"));
  const app = await createApp({ dataRoot: root, configProvider: async () => ({ configured: true }), model: async () => ({ parsed: answer(), record: { testOnly: true } }) });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${app.server.address().port}/api/reader/chats`;
  try {
    const source = await input();
    const denied = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://outside.invalid" }, body: JSON.stringify(source) });
    assert.equal(denied.status, 403);
    const result = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(source) });
    assert.equal(result.status, 202); const job = await result.json(); await wait(app.reader, job.id);
    const fetched = await (await fetch(endpoint + "/" + job.id)).json(); assert.equal(fetched.status, "completed");
    assert.equal(app.pipeline.active.size, 0); assert.equal((await app.store.listRuns(source.paperSha256)).total, 0);
  } finally { await new Promise((resolve) => app.server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
test("focused review rejects changing the selected passage before a target or check is created", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-focused-review-"));
  const store = new EvidenceStore(root);
  let calls = 0, inspections = 0;
  const pipeline = new ReviewPipeline({ store, getConfig: async () => ({ configured: true }), model: async () => { calls++; return { parsed: { quote: "This is the right identity law.", label: "Wrong scope" }, record: { testOnly: true } }; }, targetChecker: async () => { inspections++; } });
  await pipeline.init();
  try {
    const source = await input(), run = await pipeline.start({ ...source, mode: "model", focusQuote: source.quote });
    const end = Date.now() + 8000;
    while (pipeline.active.has(run.id) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    const final = await store.getRun(run.id);
    assert.equal(final.status, "blocked"); assert.match(final.error, /论证范围/); assert.equal(final.contract, null);
    assert.equal(calls, 1); assert.equal(inspections, 0); assert.equal(final.focusQuote, quote);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("annotation projection preserves truth states, latest source version, and actual dependency edges", () => {
  const make = (id, createdAt, status, headline) => ({ id, paperSha256: "p", createdAt, status, contract: { pageIndex: 0, quote, label: "Claim", statement: quote }, tasks: [{ id: "a", role: "R03", status: "succeeded", output: "source" }, { id: "b", role: "R04", status: "running", inputs: ["source"] }], conclusion: headline ? { headline } : null });
  const old = make("old", "2026-10-16", "completed", "old result"), current = make("current", "2026-10-17", "blocked");
  const notes = annotationsFromRuns([old, current, { ...current, paperSha256: "other" }], "p");
  assert.equal(notes.length, 1); assert.equal(notes[0].runId, "current"); assert.equal(notes[0].dimensions.theorem, "未知");
  assert.equal(workflowTasks(current, ["R10"]).length, 0);
  assert.deepEqual(dependencyTasks(current, current.tasks[1]).map((t) => t.id), ["a"]);
});
