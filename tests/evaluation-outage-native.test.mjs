import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, readFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
for (const outcome of ["http_failure", "unknown"])
  test(
    `development evaluator stops subsequent cases after actual ${outcome}`,
    { timeout: 60000 },
    async () => {
      const base = path.resolve(
        process.env.LEMMA_TEST_EVIDENCE_DIR ||
          "evidence/math-preparation-native",
      );
      await mkdir(base, { recursive: true });
      const dir = await mkdtemp(path.join(base, "evaluation-outage-"));
      const ledger = path.join(dir, "ledger");
      await mkdir(ledger);
      await writeFile(
        path.join(ledger, "ledger.json"),
        JSON.stringify({
          maxCalls: 200,
          caps: { translationDev: 24 },
          entries: [],
        }),
      );
      let requests = 0;
      const server = createServer(async (req, res) => {
        for await (const _ of req) {
        }
        requests++;
        if (outcome === "unknown") {
          res.destroy();
          return;
        }
        res.writeHead(503, { "content-type": "application/json" });
        res.end('{"error":"controlled unavailable"}');
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const fd = await open(path.join(dir, "process.log"), "wx");
      try {
        const code = await new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "scripts/evaluate-translation-development.mjs",
              dir,
              path.join(dir, "evaluation"),
              "evaluation/sets/math-preparation-development/inputs.json",
            ],
            {
              env: {
                ...process.env,
                LEMMA_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
                LEMMA_MODEL: "scripted-controlled-fixture",
                LEMMA_MODEL_API_KEY: "local-fixture",
                LEMMA_EXPERIMENT_LEDGER: ledger,
                LEMMA_EXPERIMENT_COHORT: "translationDev",
              },
              stdio: ["ignore", fd.fd, fd.fd],
            },
          );
          child.once("error", reject);
          child.once("close", resolve);
        });
        assert.equal(code, 0);
        const result = JSON.parse(
          await readFile(path.join(dir, "evaluation/result.json")),
        );
        assert.equal(requests, 1);
        assert.equal(result.passed, false);
        assert(result.halt);
        assert.equal(result.rows.length, 1);
        assert.equal(result.notStarted.length, 5);
        assert.equal(
          JSON.parse(await readFile(path.join(ledger, "ledger.json"))).entries
            .length,
          1,
        );
      } finally {
        await fd.close();
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    },
  );
