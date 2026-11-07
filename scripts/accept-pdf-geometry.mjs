// Actual PDF parsing, evidence storage/replay and local HTTP failure behavior.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { extractPaper, extractPageGeometry } from "../server/pdf.mjs";
import {
  validateMathematicalSource,
  mathematicalDiscrepancies,
  MATH_DIFFERENCE_POLICY,
} from "../server/math-extraction.mjs";
import {
  EvidenceStore,
  digest,
  sha256,
  inspectBundle,
} from "../server/evidence.mjs";
import { createApp } from "../server/index.mjs";
const [out, ...inputs] = process.argv.slice(2);
await mkdir(out, { recursive: false });
const store = new EvidenceStore(path.join(out, "native-store"));
await store.init();
const report = {
  scope: "native_geometry_and_local_HTTP_not_model_quality",
  inputs: [],
  passed: false,
  externalModelCalls: 0,
};
try {
  for (const file of inputs) {
    const bytes = await readFile(file),
      base64 = bytes.toString("base64"),
      source = await extractPaper(base64),
      row = { file, paperSha256: sha256(bytes), pages: [] };
    report.inputs.push(row);
    for (const p of source.pages) {
      const first = await extractPageGeometry(base64, p.index, {
        visibility: true,
      });
      const second = await extractPageGeometry(base64, p.index, {
        visibility: true,
      });
      assert.equal(
        digest(first),
        digest(second),
        "Repeated document instances must retain stable geometry",
      );
      const evidence = {
        schemaVersion: "lemma.math-source.v2",
        differencePolicy: MATH_DIFFERENCE_POLICY,
        paperSha256: source.paperSha256,
        pages: [
          {
            geometry: first,
            parser: { status: "not_requested" },
            issues: mathematicalDiscrepancies(first, null),
          },
        ],
      };
      const pageSource = {
        ...source,
        pageIndex: p.index,
        text: p.text,
        mathEvidence: evidence,
      };
      const root = await store.put("geometry_native_source", pageSource);
      const bundle = await store.bundle(root);
      inspectBundle(bundle, root);
      const replay = await validateMathematicalSource(pageSource);
      assert(replay.geometryReproduced);
      row.pages.push({
        index: p.index,
        root,
        geometryHash: digest(first),
        unresolved: first.visibility.items.filter(
          (i) => i.status === "unresolved",
        ).length,
        replayed: true,
      });
    }
    assert.equal(sha256(await readFile(file)), row.paperSha256);
  }
  let calls = 0;
  const provider = createServer((req, res) => {
    calls++;
    res.writeHead(500);
    res.end("{}");
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  const config = {
    endpoint: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
    key: "local-test",
    model: "unused-fixture",
    concurrency: 1,
    timeoutMs: 1000,
  };
  const app = await createApp({
    dataRoot: path.join(out, "http-store"),
    configProvider: async () => config,
    semanticConfigProvider: async () => config,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  try {
    const pdf = Buffer.from(
      "%PDF-1.7\nintentionally invalid local negative test",
    );
    const api = `http://127.0.0.1:${app.server.address().port}`;
    const res = await fetch(api + "/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orchestration: "adaptive",
        paperSha256: sha256(pdf),
        pdfBase64: pdf.toString("base64"),
        reviewIntent: "自主选择一个原文命题核查。",
      }),
    });
    assert.equal(res.status, 202);
    const { id } = await res.json();
    const deadline = Date.now() + 45000;
    let run;
    do {
      run = await app.store.getRun(id);
      if (!app.adaptive.active.has(id)) break;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < deadline);
    assert.equal(app.adaptive.active.has(id), false);
    assert.equal(calls, 0);
    assert(run.failureRoot);
    assert.equal(run.tasks.find((t) => t.kind === "import").attempts.length, 1);
    const response = await fetch(`${api}/api/reviews/${id}/bundle`);
    assert.equal(response.status, 200);
    const bundle = await response.json();
    inspectBundle(bundle, run.failureRoot);
    await writeFile(out + "/failure-bundle.json", JSON.stringify(bundle));
    await writeFile(out + "/failure-run.json", JSON.stringify(run, null, 2));
    report.localHTTP = {
      status: run.status,
      providerCalls: calls,
      failureRoot: run.failureRoot,
      importAttempts: 1,
      integrity: true,
    };
  } finally {
    await app.adaptive.close();
    await app.harness.close();
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    provider.closeAllConnections();
    await new Promise((r) => provider.close(r));
  }
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  await writeFile(out + "/report.json", JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      passed: report.passed,
      error: report.error,
      inputs: report.inputs.map((x) => ({
        file: x.file,
        pages: x.pages.length,
      })),
      localHTTP: report.localHTTP,
    }),
  );
}
