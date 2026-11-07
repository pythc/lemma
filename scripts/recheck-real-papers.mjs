// Live acceptance runner. No automatic semantic approval, target rewriting, or
// gateway configuration changes. Local credentials never enter the evidence.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { modelConfig, callModel } from '../server/model.mjs';
import { EvidenceStore, sha256 } from '../server/evidence.mjs';
import { ReviewPipeline } from '../server/pipeline.mjs';
import { extractPaper } from '../server/pdf.mjs';

const root = process.cwd();
const label = process.env.LEMMA_RECHECK_LABEL || 'real-papers-20261017';
if (!/^[a-z0-9-]{1,80}$/.test(label)) throw new Error('Invalid evidence label');
const out = path.join(root, 'evidence', label);
const data = path.join(root, '.runtime/real-papers-20261017');
const storeRoot = path.join(root, '.runtime', label, 'store');
await mkdir(out, { recursive: true });
const save = (name, value) => writeFile(path.join(out, `${name}.json`), JSON.stringify(value, null, 2));
const config = await modelConfig(root);
const [action, key = 'probe'] = process.argv.slice(2);
if (action === 'stream-diagnostic') {
  const baseline = JSON.parse(await readFile(path.resolve(process.argv[4])));
  const request = { ...baseline.request, max_tokens: 65536, stream: true };
  const started = Date.now();
  const response = await fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
    body: JSON.stringify(request), signal: AbortSignal.timeout(config.timeoutMs) });
  let body = '', bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 200000) throw new Error('Diagnostic response exceeded 200 KB');
    body += Buffer.from(chunk).toString('utf8');
  }
  const events = body.split('\n').filter(x => x.startsWith('data: ')).map(x => x.slice(6));
  const chunks = events.filter(x => x !== '[DONE]').map(x => { try { return JSON.parse(x); } catch { return { malformed: x }; } });
  const content = chunks.map(x => x.choices?.[0]?.delta?.content || '').join('');
  let parsed = null, parseError = null;
  try { const c = content.trim(); parsed = JSON.parse(c.startsWith('<escape>') && c.endsWith('</escape>') ? c.slice(8,-9) : c); } catch(e) { parseError = e.message; }
  const value = { classification: 'diagnostic_only_stream_transport_comparison_not_product_acceptance', baselineFile: process.argv[4],
    recordedAt: new Date().toISOString(), status: response.status, elapsedMs: Date.now() - started, request, body: body.replaceAll(config.key, '[REDACTED]'),
    content, parsed, parseError, chunks: chunks.length, done: events.includes('[DONE]'), finishReasons: chunks.map(x => x.choices?.[0]?.finish_reason).filter(Boolean) };
  await save(`${key}-stream-65536`, value);
  console.log(JSON.stringify({status: value.status, chars: content.length, elapsedMs: value.elapsedMs, done: value.done, finishReasons: value.finishReasons, parseError, parsed}));
  process.exit(0);
}
if (action === 'compare-limit') {
  const baseline = JSON.parse(await readFile(path.resolve(process.argv[4])));
  const request = { ...baseline.request, max_tokens: 65536 };
  const started = Date.now();
  const response = await fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
    body: JSON.stringify(request), signal: AbortSignal.timeout(config.timeoutMs) });
  const body = (await response.text()).replaceAll(config.key, '[REDACTED]');
  let completion, parsed = null, parseError = null;
  try { completion = JSON.parse(body); const c = completion.choices?.[0]?.message?.content?.trim() || '';
    parsed = JSON.parse(c.startsWith('<escape>') && c.endsWith('</escape>') ? c.slice(8,-9) : c);
  } catch(e) { parseError = e.message; }
  const value = { classification: 'diagnostic_only_output_limit_comparison_not_product_acceptance', baselineFile: process.argv[4],
    recordedAt: new Date().toISOString(), status: response.status, elapsedMs: Date.now() - started, request, body, parsed, parseError };
  await save(`${key}-limit-65536`, value);
  console.log(JSON.stringify({status: response.status, chars: body.length, finish: completion?.choices?.[0]?.finish_reason, parseError, parsed}));
  process.exit(0);
}
let requestNumber = 0;
const observedModel = async (configuration, options) => {
  const number = ++requestNumber;
  try {
    const result = await callModel(configuration, options);
    await save(`${key}-${action}-model-${number}-${Date.now()}`, {
      captureType: 'validated_adapter_record_not_raw_http',
      recordedAt: new Date().toISOString(), record: result.record,
    });
    return result;
  } catch (error) {
    await save(`${key}-${action}-model-${number}-${Date.now()}`, {
      captureType: 'failed_adapter_record_not_raw_http',
      recordedAt: new Date().toISOString(), error: error.message, record: error.modelRecord || null,
    });
    throw error;
  }
};
if (action === 'probe') {
  const started = Date.now();
  try {
    const result = await observedModel(config, { role: 'connectivity_control', maxTokens: 8000,
      system: '接口诊断：准确返回输入中的标记，以及数字列表的和。', input: { marker: 'real-papers-20261017', values: [17, 23, 41] } });
    await save(key, { recordedAt: new Date().toISOString(), elapsedMs: Date.now() - started, ...result });
    console.log(JSON.stringify({ key, parsed: result.parsed, model: result.record.responseModel, effort: result.record.responseThinkingEffort, finish: result.record.finishReason }));
  } catch (e) {
    await save(key, { error: e.message, record: e.modelRecord || null, elapsedMs: Date.now() - started });
    console.log(JSON.stringify({ error: e.message }));
  }
  process.exit(0);
}
if (action === 'extract') {
  const bytes = await readFile(path.join(data, `${key}.pdf`));
  const paper = await extractPaper(bytes.toString('base64'));
  await save(`${key}-text`, { ...paper, pdfBase64: undefined });
  console.log(JSON.stringify({ key, hash: paper.paperSha256, pages: paper.pages.map(p => ({ index: p.index, chars: p.text.length, text: p.text })) }));
  process.exit(0);
}
const store = new EvidenceStore(storeRoot);
if (action === 'control-retry') {
  // Reuse an immutable historical target to isolate R04. This is explicitly a
  // synthetic control, not either real paper's acceptance result.
  await store.init();
  const original = new EvidenceStore(path.join(root, '.runtime'));
  const previous = await original.getRun('53e13fcd-57a3-401f-b728-c4ca71faab2a');
  const bundle = await original.bundle(previous.root);
  for (const a of bundle.artifacts) {
    if (await store.put(a.kind, a.payload, a.inputs) !== a.id) throw new Error('Artifact identity changed');
  }
  await store.saveRun(previous);
  await save(`${key}-reference`, { runId: previous.id, classification: 'historical_authored_example_R04_control_not_real_paper', dataRoot: store.root });
}
const pipeline = new ReviewPipeline({ store, getConfig: () => modelConfig(root), model: observedModel });
await pipeline.init();
let id;
if (action === 'prepare') {
  const bytes = await readFile(path.join(data, `${key}.pdf`));
  const pageIndex = Number(process.argv[4]);
  const run = await pipeline.start({ mode: 'model', proofStrategy: 'model', libraryProfile: 'analysis-continuity-v1',
    pdfBase64: bytes.toString('base64'), paperSha256: sha256(bytes), pageIndex });
  id = run.id;
  await save(`${key}-reference`, { runId: id, paperSha256: sha256(bytes), pageIndex, dataRoot: store.root, classification: 'real_paper_automatic_translation_no_seed' });
} else if (action === 'approve') {
  const approval = JSON.parse(await readFile(path.join(out, `${key}-approval.json`)));
  id = approval.runId;
  await pipeline.approve(id, approval.input);
} else if (action === 'retry' || action === 'control-retry') {
  const ref = JSON.parse(await readFile(path.join(out, `${key}-reference.json`)));
  const run = await pipeline.retryTranslation(ref.runId);
  id = run.id;
  await save(`${key}-reference`, { ...ref, runId: id, continuedFrom: ref.runId });
} else if (action === 'recover') {
  const ref = JSON.parse(await readFile(path.join(out, `${key}-reference.json`)));
  const input = process.argv[4]
    ? JSON.parse(await readFile(path.resolve(process.argv[4])))
    : { mode: 'model' };
  const run = await pipeline.recoverDomain(ref.runId, input);
  id = run.id;
  await save(`${key}-reference`, { ...ref, runId: id, continuedFrom: ref.runId });
} else if (action === 'replay') {
  const ref = JSON.parse(await readFile(path.join(out, `${key}-reference.json`)));
  const run = await store.getRun(ref.runId);
  await save(`${key}-replay`, await pipeline.replay(await store.bundle(run.root), run.root));
  console.log(JSON.stringify({ replay: key }));
  process.exit(0);
} else throw new Error('Expected probe, extract, prepare, approve, retry, recover or replay');
console.log(JSON.stringify({ started: id, key, action }));
let last = '';
while (pipeline.active.has(id)) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  const r = await store.getRun(id);
  const stage = r.tasks.at(-1)?.role + ':' + r.tasks.at(-1)?.status;
  if (stage !== last) { console.log(JSON.stringify({ stage, at: new Date().toISOString() })); last = stage; }
}
const run = await store.getRun(id);
await save(`${key}-${action}-${id}`, run);
await save(`${key}-latest`, run);
if (run.root) await save(`${key}-bundle-${id}`, await store.bundle(run.root));
console.log(JSON.stringify({ id, status: run.status, error: run.error, target: run.contract?.leanTarget, issues: run.semanticReview?.issues,
  type: run.semanticReview?.targetCheck?.status, conclusion: run.conclusion, attempts: run.attempts?.map(a => ({ number: a.number, status: a.status })) }));
