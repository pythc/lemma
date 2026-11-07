import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DeepProofHarness,
  harnessModelAdapter,
} from "../server/deep-harness.mjs";
import { EvidenceStore, sha256, inspectBundle } from "../server/evidence.mjs";
import { runNumericExperiment } from "../server/numeric-execution.mjs";

test(
  "real SDK executes source, native declaration and Python tools before any paper target exists",
  { timeout: 180000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-review-tools-")),
      store = new EvidenceStore(dir);
    await store.init();
    const text = "A complete generic source statement and its conclusion.",
      paperSha256 = sha256(text);
    const sourceArtifact = await store.put("explicit_scripted_source_fixture", {
      paperSha256,
      pages: [{ index: 0, text }],
    });
    let calls = 0;
    const invoke = async (_config, req) => {
      calls++;
      const last = req.messages.filter((m) => m.role === "tool").at(-1);
      const v = last ? JSON.parse(last.content) : null;
      const tool = (name, args) => ({
        message: {
          content: null,
          tool_calls: [
            {
              id: `fixture-${calls}`,
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        record: { scripted: true },
      });
      if (calls === 1) return tool("read_source", { pageIndex: 0 });
      if (calls === 2) {
        assert.equal(v.text, text);
        return tool("inspect_modules", {
          modules: [],
          names: ["Nat.add_comm"],
        });
      }
      if (calls === 3) {
        assert.equal(v.status, "well_typed", JSON.stringify(v));
        assert.equal(v.verified, false);
        return tool("run_python", {
          code: "from fractions import Fraction\nprint(sum(Fraction(1, 2**i) for i in range(5)))",
        });
      }
      assert.equal(v.exitCode, 0, JSON.stringify(v));
      assert.equal(v.stdout.trim(), "31/16");
      return {
        message: {
          content: JSON.stringify({
            status: "unresolved",
            result:
              "A finite computation was executed; no theorem has been proved.",
          }),
        },
        record: { scripted: true },
      };
    };
    const harness = new DeepProofHarness({ store, model: invoke });
    try {
      const model = harnessModelAdapter({ store, model: invoke, harness });
      const result = await model(
        { model: "explicit-scripted-review-tools-only" },
        {
          role: "RDP",
          system: "Explicit tool plumbing fixture, not mathematical accuracy.",
          input: {
            context: {
              paperSha256,
              pages: [{ pageIndex: 0, text }],
              supplements: [],
            },
          },
          sourceIdentity: { paperSha256, sourceArtifact },
        },
      );
      assert.equal(result.check, null);
      assert.equal(result.record.modelCalls, 4);
      assert.deepEqual(
        result.record.toolReceipts.map((x) => x.name),
        ["read_source", "inspect_modules", "run_python"],
      );
      assert.equal(result.record.toolReceipts.at(-1).exitCode, 0);
      const bundle = await store.bundle(result.record.harnessRoot);
      inspectBundle(bundle, result.record.harnessRoot);
      assert.ok(!bundle.artifacts.some((a) => a.kind === "proof:candidate"));
    } finally {
      await harness.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "finite computation sandbox denies host reads and network, limits output and supports cancellation",
  { timeout: 90000 },
  async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "lemma-experiment-isolation-"),
    );
    try {
      for (const code of [
        "print(open('/etc/hosts').read())",
        "import socket\nsocket.create_connection(('1.1.1.1',443),timeout=2)",
      ]) {
        const r = await runNumericExperiment(dir, code);
        assert.notEqual(r.exitCode, 0);
        assert.equal(r.verified, false);
      }
      const controller = new AbortController();
      const task = runNumericExperiment(dir, "while True: pass", {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 400);
      const r = await task;
      assert.equal(r.termination, "cancelled");
      const memory = await runNumericExperiment(
        dir,
        "import time\na=bytearray(45*1024*1024)\ntime.sleep(4)",
        { maxMemoryMiB: 30 },
      );
      assert.equal(memory.termination, "memory_limit");
      const output = await runNumericExperiment(dir, "print('x'*400000)");
      assert.equal(output.termination, "output_limit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "SDK-wrapped unknown provider outcomes retain their receipt and are not retried",
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-stage-unknown-")),
      store = new EvidenceStore(dir);
    await store.init();
    let calls = 0;
    const h = new DeepProofHarness({
      store,
      model: async () => {
        calls++;
        throw Object.assign(Error("transport interrupted"), {
          modelRecord: {
            role: "HARNESS_TOOL_MODEL",
            error: { code: "model_timeout" },
            http: null,
          },
        });
      },
    });
    try {
      let error;
      try {
        await h.run({
          config: { model: "explicit-timeout-fixture" },
          goal: "unknown outcome fixture",
          toolProfile: "review",
          maxCalls: 8,
        });
      } catch (e) {
        error = e;
      }
      assert.equal(calls, 1);
      assert.equal(error.modelRecord.error.code, "model_timeout");
      const report = await store.get(error.harnessRoot);
      assert.equal(report.payload.unknownExternalOutcome, true);
    } finally {
      await h.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "unchanged deterministic tool failures execute once and stop the model loop instead of burning its full budget",
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(
        path.join(os.tmpdir(), "lemma-stage-stagnation-"),
      ),
      store = new EvidenceStore(dir);
    await store.init();
    let calls = 0;
    const h = new DeepProofHarness({
      store,
      model: async () => ({
        message: {
          content: null,
          tool_calls: [
            {
              id: `repeat-${++calls}`,
              function: {
                name: "read_source",
                arguments: JSON.stringify({ pageIndex: 999 }),
              },
            },
          ],
        },
        record: { scripted: true },
      }),
    });
    try {
      let error;
      try {
        await h.run({
          config: { model: "explicit-stagnation-fixture" },
          goal: "tool loop fixture",
          toolProfile: "review",
          maxCalls: 32,
        });
      } catch (e) {
        error = e;
      }
      assert.equal(calls, 4);
      assert.match(error.message, /No progress/);
      const bundle = await store.bundle(error.harnessRoot);
      assert.equal(
        bundle.artifacts.filter((a) => a.kind === "harness:tool_failure")
          .length,
        1,
      );
      assert.equal(
        bundle.artifacts.filter((a) => a.kind === "harness:tool_cache_hit")
          .length,
        3,
      );
      assert.equal(
        bundle.artifacts.find((a) => a.id === error.harnessRoot).payload
          .unknownExternalOutcome,
        false,
      );
    } finally {
      await h.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
