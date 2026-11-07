import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { TeamRuntime } from "../server/team/runtime.mjs";
import { TeamResources } from "../server/resources/team-resources.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function bridge(endpoint, token) {
  const proc = spawn(process.execPath, ["server/adapters/team-mcp.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      LEMMA_TEAM_ENDPOINT: endpoint,
      LEMMA_TEAM_TOKEN: token,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let seq = 0;
  const lines = readline.createInterface({ input: proc.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    pending.get(value.id)?.(value.result);
    pending.delete(value.id);
  });
  return {
    proc,
    call: (name, args = {}) =>
      new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        proc.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          }) + "\n",
        );
      }),
  };
}
test(
  "actual stdio MCP + HTTP: operation beyond five minutes remains retrievable without resubmission",
  { timeout: 350000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-operation-http-"));
    let invoked = 0;
    const runtime = new TeamRuntime({
      store: new EvidenceStore(dir),
      resources: new TeamResources(),
      executor: {
        run: async () => {
          throw Error("No model");
        },
      },
      extract: async () => ({
        paperSha256: sha256("transport only"),
        pageCount: 1,
        pages: [{ index: 0, text: "Engineering fixture" }],
      }),
      mathTools: {
        run: async (name, args, { signal }) => {
          invoked++;
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 310000);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(Error("Cancelled"));
              },
              { once: true },
            );
          });
          return { value: "one original result" };
        },
      },
    });
    runtime.pump = () => {};
    await runtime.init();
    const run = await runtime.start({ pdfBase64: "fixture" }),
      actor = runtime.runs.get(run.id).tasks[0];
    actor.status = "running";
    const token = "fixture-" + randomUUID();
    runtime.sessions.set(token, {
      runId: run.id,
      actorId: actor.id,
      signal: runtime.active.get(run.id).controller.signal,
      pending: new Set(),
    });
    const first = bridge(runtime.endpoint, token);
    let second;
    t.after(async () => {
      first.proc.kill();
      second?.proc.kill();
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    });
    const began = Date.now(),
      response = await first.call("lean_draft", { code: "transport fixture" });
    assert.equal(response.isError, undefined);
    const accepted = JSON.parse(response.content[0].text);
    assert.equal(accepted.status, "running");
    assert.ok(accepted.operationId);
    assert.ok(Date.now() - began < 10000);
    first.proc.kill(); // The caller is gone; the operation must retain its result.
    await delay(310500);
    second = bridge(runtime.endpoint, token);
    const recovered = await second.call("get_operation", {
      operationId: accepted.operationId,
    });
    assert.equal(recovered.isError, undefined, JSON.stringify(recovered));
    const result = JSON.parse(recovered.content[0].text);
    assert.equal(result.value, "one original result");
    assert.equal(result.operationId, accepted.operationId);
    assert.equal(invoked, 1);
    assert.ok(result.operationArtifactId);
  },
);
