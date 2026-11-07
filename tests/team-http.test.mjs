import { finishFixture, assessFixture } from "./helpers/team-stop-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createApp } from "../server/index.mjs";
import { resultKey } from "../src/reading-flow.js";
import { TeamResources } from "../server/resources/team-resources.mjs";
test("customer HTTP upload, real PDF extraction, tool delegation, independent acceptance, source and bundle", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-team-http-"));
  let app;
  const executor = {
    run: async (ctx) => {
      const session = app.team.sessions.get(ctx.token),
        run = app.team.runs.get(session.runId),
        a = run.tasks.find((t) => t.id === session.actorId);
      async function call(name, args = {}) {
        const res = await fetch(ctx.endpoint + "/call", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ctx.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name, arguments: args }),
        });
        const value = await res.json();
        if (!res.ok) throw Error(value.error);
        return value;
      }
      if (a.role === "main") {
        if (run.tasks.length === 1) {
          const env = await call("inspect_execution_environment", {
            imports: ["Std"],
          });
          assert.equal(env.lean.modules[0].status, "toolchain_import");
          const history = await call("read_execution_history", {});
          assert.ok(Array.isArray(history.entries));
          const p = await call("read_source");
          assert.match(p.pages[0].text, /Integration fixture/);
          const next = await call("create_task", {
            title: "Read source",
            goal: "Read actual source",
            criteria: "Source-backed report",
          });
          await call("yield_work", { taskIds: [next.taskId] });
        } else
          await finishFixture(call, run, {
            summary: "Source extraction integration passed",
            limitations: ["Fixture only"],
          });
      } else if (a.role === "task")
        await call("submit_task", {
          summary: "Source read",
          resultKind: "report",
          artifactIds: [],
          targetIds: [],
          limitations: [],
        });
      else
        await assessFixture(call, run, a, {
          verdict: "pass",
          explanation: "Read original independently",
          issues: [],
          replayIds: [],
        });
      return { model: "test-adapter", reasoningEffort: "high" };
    },
  };
  app = await createApp({
    dataRoot: dir,
    origins: ["http://127.0.0.1:4184"],
    teamOptions: {
      executor,
      resources: new TeamResources({ maxTurns: 15, maxRunMs: 60000 }),
    },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.team.close();
    await app.harness.close();
    await app.adaptive.close();
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("Integration fixture: source extraction.", { font });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const rejectedOrigin = await fetch(base + "/api/reviews", {
    method: "POST",
    headers: { Origin: "https://untrusted.example" },
    body: "{}",
  });
  assert.equal(rejectedOrigin.status, 403);
  const response = await fetch(base + "/api/reviews", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:4184",
    },
    body: JSON.stringify({
      orchestration: "team",
      pdfBase64: Buffer.from(await pdf.save()).toString("base64"),
    }),
  });
  assert.equal(response.status, 202);
  const started = await response.json();
  assert.equal(started.engine, "team-v1");
  let done;
  for (let i = 0; i < 200; i++) {
    done = await (await fetch(`${base}/api/reviews/${started.id}`)).json();
    if (done.root && !app.team.active.get(done.id).jobs.size) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(done.root);
  assert.equal(done.tasks.length, 4);
  assert.deepEqual(done.machineChecks, []);
  assert.ok(resultKey(done, done.paperSha256));
  const source = await (
    await fetch(`${base}/api/reviews/${done.id}/source`)
  ).json();
  assert.equal(source.paperSha256, done.paperSha256);
  const listing = await (
    await fetch(`${base}/api/reviews?paper=${done.paperSha256}`)
  ).json();
  assert.equal(listing.items[0].engine, "team-v1");
  const bundle = await fetch(`${base}/api/reviews/${done.id}/bundle`);
  assert.equal(bundle.status, 200);
});
