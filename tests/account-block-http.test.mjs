import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { createApp } from "../server/index.mjs";
import { inspectBundle, sha256 } from "../server/evidence.mjs";

test(
  "HTTP 402 stops actual PDF review dispatch and exports an account-blocked incomplete report",
  { timeout: 60000 },
  async () => {
    const base = path.resolve(
      process.env.LEMMA_TEST_EVIDENCE_DIR ||
        "evidence/live-repair4/account-http",
    );
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(path.join(base, "account-"));
    let calls = 0;
    const provider = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      calls++;
      res.writeHead(402, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            type: "insufficient_balance_error",
            code: "invalid_request_error",
            message: "Controlled account failure",
          },
        }),
      );
    });
    await new Promise((r) => provider.listen(0, "127.0.0.1", r));
    const config = {
      endpoint: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
      model: "local-account-fixture",
      key: "local-fixture",
      timeoutMs: 3000,
    };
    const app = await createApp({
      dataRoot: path.join(dir, "store"),
      configProvider: async () => config,
      semanticConfigProvider: async () => config,
      documentExtractor: async (paper) => paper,
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    try {
      const pdf = await PDFDocument.create();
      pdf.addPage().drawText("Theorem. Every natural number equals itself.");
      const bytes = Buffer.from(await pdf.save());
      const origin = `http://127.0.0.1:${app.server.address().port}`;
      const response = await fetch(origin + "/api/reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orchestration: "adaptive",
          mode: "model",
          paperSha256: sha256(bytes),
          pdfBase64: bytes.toString("base64"),
          libraryProfile: "std-v1",
        }),
      });
      assert.equal(response.status, 202, await response.clone().text());
      const start = await response.json();
      let run;
      for (let i = 0; i < 1000; i++) {
        run = await app.store.getRun(start.id);
        if (!app.adaptive.active.has(run.id)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(run.status, "blocked", run.error);
      assert.equal(
        calls,
        1,
        "No diagnostics, coordinator, or reviewer after the first 402",
      );
      assert.equal(run.modelCalls, 1);
      assert.equal(run.infrastructureFailure.kind, "provider_account_blocked");
      assert.equal(run.conclusion.executionOutcome, "provider_account_blocked");
      assert.equal(run.conclusion.reviewComplete, false);
      assert.match(run.stopReason, /402.*账户或余额/);
      const bundle = await app.store.bundle(run.root);
      inspectBundle(bundle, run.root);
      assert(
        bundle.artifacts.some(
          (a) =>
            a.kind === "review_model_failure" &&
            a.payload.model.http.status === 402,
        ),
      );
      await writeFile(
        path.join(dir, "result.json"),
        JSON.stringify(
          {
            runId: run.id,
            status: run.status,
            root: run.root,
            calls,
            externalModelCalls: 0,
            conclusion: run.conclusion,
          },
          null,
          2,
        ),
      );
    } finally {
      await app.adaptive.close();
      await app.harness.close();
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      provider.closeAllConnections();
      await new Promise((r) => provider.close(r));
      console.log("Evidence:", dir);
    }
  },
);
