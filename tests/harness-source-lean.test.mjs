import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DeepProofHarness } from "../server/deep-harness.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
import { createContract } from "../server/contracts.mjs";
import { MATHLIB_COMMIT } from "../shared/library-profiles.mjs";

test(
  "real SDK reads pinned Mathlib offline without external inspection, rejects traversal and retains a native certificate",
  { timeout: 120000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lemma-pinned-source-"));
    const store = new EvidenceStore(dir);
    await store.init();
    const source = await store.put("explicit_scripted_source_fixture", {
      text: "fixture",
    });
    const contract = createContract(
      {
        text: "fixture",
        artifact: source,
        paperSha256: sha256("source fixture"),
        pageIndex: 0,
      },
      {
        label: "fixture",
        quote: "fixture",
        statement: "fixture",
        assumptions: [],
        leanTarget: "∀ n : Nat, n = n",
      },
    );
    let calls = 0;
    const call = (id, name, args) => ({
      message: {
        content: null,
        tool_calls: [
          { id, function: { name, arguments: JSON.stringify(args) } },
        ],
      },
      record: { scripted: true },
    });
    const harness = new DeepProofHarness({
      store,
      model: async (_config, request) => {
        calls++;
        const last = request.messages.filter((m) => m.role === "tool").at(-1);
        const value = last ? JSON.parse(last.content) : null;
        if (calls === 1)
          return call("source", "read_library_source", {
            module: "Mathlib.Analysis.Convex.Function",
            lineCount: 20,
          });
        if (calls === 2) {
          assert.equal(value.revision, MATHLIB_COMMIT);
          assert.equal(
            value.acquisition,
            "local_immutable_git_object_no_network",
          );
          assert.match(value.sourceSha256, /^[a-f0-9]{64}$/);
          assert.equal(value.endLine, 20);
          assert.match(value.scope, /not_import_availability/);
          return call("denied", "read_library_source", {
            module: "../.env.local",
          });
        }
        assert.match(value.error, /module name/);
        return {
          message: {
            content: JSON.stringify({
              mode: "proof",
              proof: "by intro n; rfl",
              route: "original",
            }),
          },
          record: { scripted: true },
        };
      },
    });
    try {
      const result = await harness.run({
        config: { model: "explicit-scripted-source-only" },
        contract,
        inputs: [source],
        goal: "Explicit source tool fixture; this is not a real paper performance result.",
        maxCalls: 4,
      });
      assert.equal(result.check.status, "verified");
      const bundle = await store.bundle(result.record.harnessRoot);
      const receipt = bundle.artifacts.find(
        (a) =>
          a.kind === "harness:tool" && a.payload.name === "read_library_source",
      );
      assert.equal(receipt.payload.value.revision, MATHLIB_COMMIT);
      assert(
        !bundle.artifacts.some(
          (a) =>
            a.kind === "harness:tool" && a.payload.name === "inspect_library",
        ),
      );
      assert.equal(result.record.modelCalls, 3);
      assert.equal(calls, 3);
    } finally {
      await harness.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
