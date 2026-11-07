import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvidenceStore, digest } from "../server/evidence.mjs";
import { inspectSourceProofAbsence } from "../server/source-proof-absence.mjs";
import { resolveContextAnchor } from "../server/context.mjs";
import { DeepProofHarness } from "../server/deep-harness.mjs";
import { executionContext } from "../server/execution-context.mjs";

test("absence evidence preserves missing source proof and rejects missing observations, altered anchors and partial context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "absence-"));
  const store = new EvidenceStore(dir);
  await store.init();
  try {
    const contract = {
      targetHash: "target",
      paperSha256: "paper",
      pageIndex: 0,
      quote: "Theorem: true.",
    };
    const context = {
      paperSha256: "paper",
      pages: [{ pageIndex: 0, text: contract.quote }],
      supplements: [],
      omittedPages: [],
    };
    const contractArtifact = await store.put("contract", contract),
      contextArtifact = await store.put("context", context);
    const auditArtifact = await store.put(
      "task:R06",
      {
        model: { provider: "explicit scripted fixture" },
        status: "source_proof_missing",
        anchor: resolveContextAnchor(
          { pageIndex: 0, quote: contract.quote },
          context,
        ),
      },
      [contractArtifact, contextArtifact],
    );
    const decisionArtifact = await store.put(
      "adaptive:assess_target",
      {
        model: { provider: "explicit second scripted fixture" },
        value: { sourceProof: "missing", targetHash: contract.targetHash },
      },
      [contractArtifact, contextArtifact],
    );
    const root = await store.put(
      "source_proof_absence",
      {
        ...contract,
        contractArtifact,
        contextArtifact,
        auditArtifact,
        decisionArtifact,
      },
      [contractArtifact, contextArtifact, auditArtifact, decisionArtifact],
    );
    const bundle = await store.bundle(root);
    const original = new Map(bundle.artifacts.map((a) => [a.id, a]));
    assert.deepEqual(inspectSourceProofAbsence(original, root, contract), {
      status: "source_proof_missing",
      authority: "two_agent_source_observations_not_mathematical_proof",
      reproduced: true,
      revalidated: false,
    });
    for (const mutate of [
      (m) => (m.get(decisionArtifact).payload.value.sourceProof = "unknown"),
      (m) => m.get(contextArtifact).payload.omittedPages.push(1),
      (m) => (m.get(contextArtifact).payload.paperSha256 = "other-paper"),
      (m) => m.get(decisionArtifact).inputs.splice(0),
      (m) => m.get(decisionArtifact).inputs.splice(1, 1),
      (m) =>
        (m.get(auditArtifact).payload.anchor.quote =
          "fabricated proof absence"),
      (m) => m.get(auditArtifact).inputs.splice(0),
      (m) => m.get(root).inputs.splice(0),
    ]) {
      const changed = structuredClone(original);
      mutate(changed);
      assert.throws(() => inspectSourceProofAbsence(changed, root, contract));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("real SDK read-source reuse is linked and scoped to exact context and owner; a failed lookup is never cached as success", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reuse-")),
    store = new EvidenceStore(dir);
  await store.init();
  let calls = 0,
    pageIndex = 0;
  const h = new DeepProofHarness({
    store,
    model: async (_c, r) => {
      calls++;
      return {
        message:
          calls % 2
            ? {
                content: null,
                tool_calls: [
                  {
                    id: "read-" + calls,
                    function: {
                      name: "read_source",
                      arguments: JSON.stringify({ pageIndex }),
                    },
                  },
                ],
              }
            : { content: '{"status":"inspected"}' },
        record: {
          role: r.role,
          finishReason: calls % 2 ? "tool_calls" : "stop",
        },
      };
    },
  });
  const cfg = {
    endpoint: "https://example.test/v1/chat/completions",
    key: "fixture",
    model: "fake",
    timeoutMs: 5000,
    concurrency: 1,
    maxOutputTokens: 1000,
  };
  const owner = { id: "same-owner" };
  const invoke = async (text) =>
    executionContext.run({ run: owner }, () =>
      h.run({
        config: cfg,
        goal: "Explicit fixture: read immutable source",
        toolProfile: "review",
        taskContext: {
          input: {
            context: { pages: [{ pageIndex: 0, text }], supplements: [] },
          },
        },
        maxCalls: 2,
      }),
    );
  try {
    const a = await invoke("original text"),
      b = await invoke("original text");
    const bBundle = await store.bundle(b.record.harnessRoot);
    assert(bBundle.artifacts.some((a) => a.kind === "harness:lookup_reuse"));
    const reuse = bBundle.artifacts.find(
      (a) => a.kind === "harness:lookup_reuse",
    );
    assert.equal(
      (await store.get(reuse.payload.reusedFrom)).payload.value.text,
      "original text",
    );
    assert.equal(reuse.payload.executed, false);
    const changed = await invoke("new text");
    assert(
      !(await store.bundle(changed.record.harnessRoot)).artifacts.some(
        (a) => a.kind === "harness:lookup_reuse",
      ),
    );
    owner.id = "other-owner";
    const other = await invoke("original text");
    assert(
      !(await store.bundle(other.record.harnessRoot)).artifacts.some(
        (a) => a.kind === "harness:lookup_reuse",
      ),
    );
    pageIndex = 99;
    const failure = await invoke("original text");
    assert(
      !(await store.bundle(failure.record.harnessRoot)).artifacts.some(
        (a) => a.kind === "harness:lookup_reuse",
      ),
    );
    assert.equal(calls, 10);
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});
