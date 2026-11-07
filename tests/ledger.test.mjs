// These fixture checkers test ledger bookkeeping. Real mathematical acceptance is in ledger-lean.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  EvidenceStore,
  digest,
  sha256,
  unpackPaperBundle,
} from "../server/evidence.mjs";
import { ReviewPipeline } from "../server/pipeline.mjs";
import { PaperLedger, replayPaperBundle } from "../server/paper-ledger.mjs";
import { ledgerReport } from "../server/ledger-model.mjs";
import { createApp } from "../server/index.mjs";

const quote = "For every natural number n, n + 0 = n.",
  definition = "Definition. The variable n denotes a natural number.";
async function fixture() {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman);
  const page = pdf.addPage([612, 792]);
  page.drawText(quote, { x: 30, y: 700, font });
  page.drawText(definition, { x: 30, y: 650, font });
  pdf.addPage([612, 792]);
  const bytes = Buffer.from(await pdf.save());
  return {
    pdfBase64: bytes.toString("base64"),
    paperSha256: sha256(bytes),
    mode: "manual",
    pageIndex: 0,
    proposal: {
      label: "T1",
      quote,
      statement: "自然数右加零不变",
      assumptions: ["n 为自然数"],
      leanTarget: "∀ n : Nat, n + 0 = n",
    },
  };
}
const checker = async (contract, proof, { mode }) => ({
  status: "verified",
  targetHash: contract.targetHash,
  mode,
  exitCode: 0,
  axioms: [],
  sourceSha256: sha256(proof),
  environment: { ready: true, binarySha256: "a".repeat(64), fixture: true },
  parser: { sourceSha256: "b".repeat(64) },
});
async function harness(action) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "lemma-ledger-test-"));
  try {
    const store = new EvidenceStore(folder),
      pipeline = new ReviewPipeline({
        store,
        checker,
        targetChecker: async (c) => ({
          status: "well_typed",
          targetHash: c.targetHash,
          reason: "Synthetic type-check fixture; real Lean tests are separate.",
        }),
        getConfig: async () => null,
      });
    await pipeline.init();
    const ledger = new PaperLedger({ store, pipeline });
    await ledger.init();
    const input = await fixture();
    const create = () =>
      ledger.create(input.paperSha256, {
        pdfBase64: input.pdfBase64,
        title: "单主定理与依赖",
        description: "人工登记机制测试，不是研究论文",
      });
    const change = (view, operation, payload) =>
      ledger.mutate(input.paperSha256, {
        expectedRevision: view.revision,
        operation,
        payload,
      });
    const run = async (mode = "proof", data = input) => {
      const started = await pipeline.start(data);
      const wait = async (status) => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const value = await store.getRun(started.id);
          if (value.status === status && !pipeline.active.has(value.id))
            return value;
          if (["blocked", "cancelled"].includes(value.status))
            throw new Error(value.error);
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("Fixture pipeline timed out");
      };
      const pending = await wait("awaiting_confirmation");
      await pipeline.approve(started.id, {
        targetHash: pending.contract.targetHash,
        semanticArtifact: pending.semanticArtifact,
        resolutions: pending.semanticReview.issues.map((i) => ({
          issueId: i.id,
          decision: "confirmed_with_reason",
          reason:
            "Test-only review of the explicitly authored reference statement and source.",
        })),
        confirmed: true,
        proof: "by intro n; rfl",
        proofMode: mode,
      });
      return wait("completed");
    };
    await action({ store, pipeline, ledger, input, create, change, run });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("ledger binds all actual PDF pages, preserves missing-text pages and rejects invented or duplicate anchors", async () => {
  await harness(async ({ ledger, input, create, change }) => {
    await assert.rejects(
      ledger.create("a".repeat(64), {
        pdfBase64: input.pdfBase64,
        title: "x",
        description: "x",
      }),
      /摘要/,
    );
    let view = await create();
    assert.deepEqual(view.pagesWithoutText, [1]);
    assert.equal(view.pageCount, 2);
    await assert.rejects(
      change(view, "add_entry", {
        type: "condition",
        label: "C",
        pageIndex: 1,
        quote,
        statement: "空页",
      }),
      /引句/,
    );
    await assert.rejects(
      change(view, "add_entry", {
        type: "condition",
        label: "C",
        pageIndex: 0,
        quote,
        statement: "x",
        verified: true,
      }),
      /字段/,
    );
    view = await change(view, "add_entry", {
      type: "definition",
      label: "D",
      pageIndex: 0,
      quote: definition,
      statement: "自然数变量",
    });
    await assert.rejects(
      change(view, "add_entry", {
        type: "definition",
        label: "D2",
        pageIndex: 0,
        quote: definition,
        statement: "重复",
      }),
      /重复/,
    );
    assert.equal(view.report.registeredEntries, 1);
    assert.equal(view.report.counts.pending, 1);
    assert.equal(view.report.wholePaperVerified, false);
  });
});

test("dependency changes invalidate retained evidence transitively; exclusion never removes the registered denominator", async () => {
  await harness(async ({ create, change, run }) => {
    let view = await create();
    const result = await run();
    view = await change(view, "adopt_run", {
      runId: result.id,
      type: "claim",
      asMain: true,
    });
    const main = view.snapshot.entries[0].id;
    assert.equal(view.report.mains[0].closed, true);
    view = await change(view, "add_entry", {
      type: "definition",
      label: "D",
      pageIndex: 0,
      quote: definition,
      statement: "自然数变量",
    });
    const leaf = view.snapshot.entries[1].id;
    await assert.rejects(
      change(view, "set_dependencies", {
        entryId: main,
        dependsOn: ["missing"],
        reason: "故障",
      }),
      /不存在/,
    );
    view = await change(view, "set_dependencies", {
      entryId: main,
      dependsOn: [leaf],
      reason: "记录必要定义",
    });
    assert.equal(view.report.items[0].state, "stale");
    assert.equal(view.snapshot.bindings.length, 1);
    view = await change(view, "link_run", { entryId: main, runId: result.id });
    assert.equal(view.report.items[0].state, "proved");
    assert.equal(view.report.mains[0].closed, false);
    assert.ok(view.report.mains[0].blockedIds.includes(leaf));
    view = await change(view, "edit_entry", {
      entryId: leaf,
      label: "D",
      pageIndex: 0,
      quote: definition,
      statement: "明确变量的作用域",
      reason: "澄清定义",
    });
    assert.equal(view.report.items[0].state, "stale");
    view = await change(view, "exclude", {
      entryId: leaf,
      reason: "本轮无法提供定义映射",
    });
    assert.equal(view.report.registeredEntries, 2);
    assert.equal(view.report.counts.excluded, 1);
    assert.equal(view.report.mains[0].closed, false);
    await assert.rejects(
      change(view, "link_run", { entryId: leaf, runId: result.id }),
      /定义或文献/,
    );
  });
});

test("same-target opposite fixture outcomes remain a conflict; foreign PDF and altered targets cannot attach", async () => {
  await harness(async ({ create, change, run, input }) => {
    let view = await create();
    const yes = await run(),
      no = await run("counterexample");
    view = await change(view, "adopt_run", {
      runId: yes.id,
      type: "claim",
      asMain: true,
    });
    const id = view.snapshot.entries[0].id;
    view = await change(view, "link_run", { entryId: id, runId: no.id });
    assert.equal(view.report.items[0].state, "conflict");
    assert.equal(view.report.counts.conflict, 1);
    assert.equal(view.snapshot.bindings.length, 2);
    const otherTarget = await run("proof", {
      ...input,
      proposal: { ...input.proposal, leanTarget: "True" },
    });
    await assert.rejects(
      change(view, "link_run", { entryId: id, runId: otherTarget.id }),
      /固定目标不同/,
    );
    const pdf = await PDFDocument.load(Buffer.from(input.pdfBase64, "base64"));
    pdf.setTitle("different bytes");
    const bytes = Buffer.from(await pdf.save());
    const foreign = await run("proof", {
      ...input,
      pdfBase64: bytes.toString("base64"),
      paperSha256: sha256(bytes),
    });
    await assert.rejects(
      change(view, "link_run", { entryId: id, runId: foreign.id }),
      /论文快照/,
    );
  });
});

test("cycles block dependency closure even with fixture proof evidence", async () => {
  await harness(async ({ create, change, run }) => {
    let view = await create();
    const result = await run();
    view = await change(view, "adopt_run", {
      runId: result.id,
      type: "claim",
      asMain: true,
    });
    const id = view.snapshot.entries[0].id;
    view = await change(view, "set_dependencies", {
      entryId: id,
      dependsOn: [id],
      reason: "循环故障样本",
    });
    view = await change(view, "link_run", { entryId: id, runId: result.id });
    assert.equal(view.report.items[0].state, "proved");
    assert.equal(view.report.mains[0].closed, false);
    assert.deepEqual(view.report.mains[0].cycleIds, [id]);
  });
});

test("revision CAS, mutation reservation and archive failure preserve the last durable ledger", async () => {
  await harness(async ({ create, change, ledger, store, input }) => {
    const initial = await create();
    const payload = {
      type: "definition",
      label: "D",
      pageIndex: 0,
      quote: definition,
      statement: "自然数变量",
    };
    const attempts = await Promise.allSettled([
      change(initial, "add_entry", payload),
      change(initial, "add_entry", payload),
    ]);
    assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
    const view = await ledger.get(input.paperSha256);
    await assert.rejects(change(initial, "add_entry", payload), /冲突/);
    await assert.rejects(
      change(view, "delete_entry", { entryId: view.snapshot.entries[0].id }),
      /不支持/,
    );
    const put = store.put.bind(store);
    store.put = (kind, ...args) => {
      if (kind === "paper_ledger_report")
        throw new Error("fixture disk failure");
      return put(kind, ...args);
    };
    await assert.rejects(
      change(view, "exclude", {
        entryId: view.snapshot.entries[0].id,
        reason: "磁盘故障样本",
      }),
      /disk failure/,
    );
    assert.equal((await ledger.get(input.paperSha256)).revision, view.revision);
  });
});

test("paper bundle stores source bytes once, preserves history and rejects resealed deletion before invoking a checker", async () => {
  await harness(async ({ create, change, ledger, input, run, pipeline }) => {
    let view = await create();
    const result = await run();
    view = await change(view, "adopt_run", {
      runId: result.id,
      type: "claim",
      asMain: true,
    });
    view = await change(view, "add_entry", {
      type: "definition",
      label: "D",
      pageIndex: 0,
      quote: definition,
      statement: "自然数变量",
    });
    const bundle = await ledger.bundle(input.paperSha256);
    assert.equal(bundle.pdfs.length, 1);
    assert.ok(bundle.artifacts.filter((a) => a.pdfRef).length >= 2);
    const replay = await replayPaperBundle(bundle, view.root, (b, r) =>
      pipeline.replayReserved(b, r),
    );
    assert.equal(replay.reproduced, true);
    assert.equal(replay.report.counts.pending, 1);
    const changed = structuredClone(bundle);
    changed.pdfs[0].base64 = "invalid";
    await assert.rejects(
      replayPaperBundle(changed, view.root, () => {
        throw new Error("must not run");
      }),
      /PDF/,
    );
    const expanded = unpackPaperBundle(bundle),
      root = expanded.artifacts.find((a) => a.id === expanded.root),
      revision = expanded.artifacts.find((a) => a.id === root.payload.revision);
    revision.payload.entries = [];
    revision.payload.mainIds = [];
    revision.payload.bindings = [];
    revision.inputs = [
      revision.payload.sourceArtifact,
      revision.payload.previousRevision,
      revision.payload.previousReport,
    ];
    const { id: oldRevision, ...revisionBody } = revision;
    revision.id = digest(revisionBody);
    root.inputs = [revision.id];
    root.payload.revision = revision.id;
    root.payload.report = ledgerReport(revision.payload, new Map());
    const { id: oldRoot, ...rootBody } = root;
    root.id = digest(rootBody);
    expanded.root = root.id;
    const malicious = {
      schemaVersion: "lemma.paper-evidence.v1",
      root: root.id,
      pdfs: bundle.pdfs,
      artifacts: expanded.artifacts.map((a) => {
        if (!a.payload.pdfBase64) return a;
        const { pdfBase64, ...payload } = a.payload;
        return { ...a, payload, pdfRef: a.payload.paperSha256 };
      }),
    };
    await assert.rejects(
      replayPaperBundle(malicious, malicious.root, () => {
        throw new Error("must not run");
      }),
      /被删除/,
    );
  });
});

test("empty ledger replay validates source and structure without claiming machine evidence was reproduced", async () => {
  await harness(async ({ create, ledger, input }) => {
    const view = await create(),
      bundle = await ledger.bundle(input.paperSha256);
    const result = await replayPaperBundle(bundle, view.root, () => {
      throw new Error("no checks expected");
    });
    assert.equal(result.sourceReextracted, true);
    assert.equal(result.reportMatched, true);
    assert.equal(result.reproduced, false);
    assert.equal(result.wholePaperVerified, false);
  });
});

test("loopback ledger API enforces source, revision and status authority through its public routes", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "lemma-ledger-api-"));
  const { server } = await createApp({
    dataRoot: folder,
    configProvider: async () => null,
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const input = await fixture(),
      url = `http://127.0.0.1:${server.address().port}/api/papers/${input.paperSha256}/ledger`;
    const post = (suffix, body, extra = {}) =>
      fetch(url + suffix, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...extra },
        body: JSON.stringify(body),
      });
    assert.equal(await (await fetch(url)).json(), null);
    const request = {
      pdfBase64: input.pdfBase64,
      title: "API 范围",
      description: "本机接口与账本权限机制测试",
    };
    assert.equal(
      (await post("/create", request, { Origin: "https://unrelated.example" }))
        .status,
      403,
    );
    const created = await post("/create", request);
    assert.equal(created.status, 201);
    const view = await created.json();
    const payload = {
      type: "constructor",
      label: "invalid",
      pageIndex: 0,
      quote,
      statement: "invalid inherited type",
    };
    assert.equal(
      (
        await post("", {
          expectedRevision: view.revision,
          operation: "add_entry",
          payload,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post("", {
          expectedRevision: view.revision,
          operation: "add_entry",
          payload: { ...payload, type: "condition" },
          verified: true,
        })
      ).status,
      400,
    );
    const added = await post("", {
      expectedRevision: view.revision,
      operation: "add_entry",
      payload: { ...payload, type: "condition" },
    });
    assert.equal(added.status, 200);
    assert.equal(
      (
        await post("", {
          expectedRevision: view.revision,
          operation: "add_entry",
          payload: { ...payload, type: "condition" },
        })
      ).status,
      400,
    );
    const bundle = await (await fetch(url + "/bundle")).json();
    assert.equal(bundle.pdfs.length, 1);
    const replay = await (await post("/replay", {})).json();
    assert.equal(replay.sourceReextracted, true);
    assert.equal(replay.reproduced, false);
    assert.equal(replay.report.counts.pending, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});

test("review-discovered definitions enter the ledger as pending, with source and revision checks", async () => {
  await harness(async ({ create, change, run, store }) => {
    let view = await create();
    const result = await run();
    result.pendingObligations = [
      {
        type: "definition",
        label: "D-source",
        pageIndex: 0,
        quote: definition,
        statement:
          "The original definition still needs a mathematical interpretation review.",
      },
    ];
    await store.saveRun(result);
    view = await change(view, "import_review_obligations", {
      runId: result.id,
    });
    assert.equal(view.snapshot.entries.length, 1);
    assert.equal(view.report.items[0].state, "pending");
    assert.equal(view.snapshot.entries[0].target, null);
    assert.equal(view.report.wholePaperVerified, false);
    await assert.rejects(
      change(view, "import_review_obligations", { runId: result.id }),
      /已登记/,
    );
    result.pendingObligations[0].quote =
      "invented definition not present in PDF";
    await store.saveRun(result);
    await assert.rejects(
      change(view, "import_review_obligations", { runId: result.id }),
      /引句/,
    );
  });
});
