import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateToolCall, TEAM_TOOLS } from "../server/team/tool-catalog.mjs";
import {
  validateToolArguments,
  assertSupportedSchema,
} from "../server/team/tool-arguments.mjs";
import {
  registerReference,
  resolveReference,
  resolveArguments,
  referenceProjection,
} from "../server/team/references.mjs";
import {
  sourceSpan,
  selectSource,
  targetSourceArguments,
} from "../server/team/source-spans.mjs";
import { checkedReservation } from "../server/environment-reservation.mjs";
import { LibraryAccess } from "../server/library-access.mjs";
import {
  readGeneration,
  publishGeneration,
  generationBuild,
  generationCapacity,
  guardedGeneration,
  quarantineGeneration,
} from "../server/library-generation.mjs";
import { withEnvironmentBorrow } from "../server/environment-borrows.mjs";
import { cp, symlink, readlink, readdir } from "node:fs/promises";
import { sharedContentTree } from "../server/toolchain-tree.mjs";
import { timingBreakdown, intervalUnionMs } from "../shared/timing-metrics.mjs";
import { operationLabel } from "../shared/tool-operation-view.mjs";
const source = {
  paperSha256: "a".repeat(64),
  pages: [
    { index: 0, text: "Heading\n\nA𝛼\u0000B implies C.\n\nrepeat repeat" },
    { index: 1, text: "Second page premise" },
  ],
};
const proposal = {
  label: "Example",
  statement: "Synthetic claim",
  assumptions: [],
  leanTarget: "True",
};
const legacy = {
  proposal: { ...proposal, quote: "Heading" },
  kind: "lemma",
  pageIndex: 0,
  sourceSpans: [{ pageIndex: 0, quote: "Heading" }],
};
const code = (c) => (e) => e.code === c;
async function temp(t) {
  const p = await mkdtemp(path.join(os.tmpdir(), "lemma-contract-"));
  t.after(() => rm(p, { recursive: true, force: true }));
  return p;
}
test("generation copy preserves pinned relative symlinks, disk pressure cancels and cleanup is recoverable", async (t) => {
  const root = await temp(t),
    source = path.join(root, "source"),
    copy = path.join(root, "copy");
  await mkdir(source);
  await writeFile(path.join(source, "original"), "source");
  await symlink("original", path.join(source, "link"));
  await cp(source, copy, { recursive: true, verbatimSymlinks: true });
  assert.equal(await readlink(path.join(copy, "link")), "original");
  const name = "staging-11111111-1111-1111-1111-111111111111",
    stage = path.join(root, name);
  await mkdir(stage);
  let checks = 0,
    started = false;
  await assert.rejects(
    guardedGeneration(
      root,
      stage,
      async (signal) => {
        started = true;
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
      {
        pollMs: 10,
        check: async () => {
          if (++checks > 1)
            throw Object.assign(Error("full"), {
              code: "environment_storage_full",
            });
          return { availableBytes: 3e9, requiredBytes: 2e9 };
        },
      },
    ),
    { code: "environment_storage_full" },
  );
  assert.equal(started, true);
  assert.equal(await readGeneration(root), null);
  await assert.rejects(quarantineGeneration(root, name), /terminal receipt/);
  await writeFile(
    path.join(stage, "failure.json"),
    JSON.stringify({ code: "environment_storage_full" }),
  );
  const moved = await quarantineGeneration(root, name);
  assert.equal(moved.snapshotsRemoved, 0);
  assert.equal(
    JSON.parse(await readFile(path.join(moved.destination, "failure.json")))
      .code,
    "environment_storage_full",
  );
});
test("environment borrows are recorded and released on error without deleting snapshots", async (t) => {
  const root = await temp(t),
    identity = "a".repeat(64);
  await assert.rejects(
    withEnvironmentBorrow(
      identity,
      "operation-a",
      "b".repeat(64),
      async () => {
        const active = JSON.parse(
          await readFile(path.join(root, identity, "operation-a.json")),
        );
        assert.equal(active.status, "borrowed");
        throw Error("native failed");
      },
      { borrowRoot: root },
    ),
    /native failed/,
  );
  const released = JSON.parse(
    await readFile(path.join(root, identity, "operation-a.json")),
  );
  assert.equal(released.status, "released");
  assert.equal(released.retention, "all_snapshots_retained_no_gc");
});
test("published schemas execute unions, aggregate fields and reject unsupported constraints", () => {
  for (const tool of TEAM_TOOLS) assertSupportedSchema(tool.inputSchema);
  assert.throws(
    () => assertSupportedSchema({ type: "string", format: "imaginary" }),
    /unsupported/,
  );
  validateToolArguments(
    { oneOf: [{ required: ["a"] }, { required: ["b"] }] },
    { a: 1 },
  );
  assert.throws(() =>
    validateToolArguments(
      { oneOf: [{ required: ["a"] }, { required: ["b"] }] },
      { a: 1, b: 2 },
    ),
  );
  assert.throws(
    () =>
      validateToolArguments(
        {
          type: "object",
          properties: { x: { type: "integer", minimum: 0 } },
          required: ["y"],
          additionalProperties: false,
        },
        { x: -1, z: true },
      ),
    (e) => e.fieldErrors.length === 3,
  );
  validateToolCall("propose_target", legacy);
  assert.throws(
    () => validateToolCall("propose_target", { ...legacy, profile: "mathlib" }),
    code("profile_unsupported"),
  );
  const { pageIndex, ...missing } = legacy;
  assert.throws(
    () => validateToolCall("propose_target", missing),
    code("source_locator_missing"),
  );
  const modern = {
    proposal,
    kind: "lemma",
    source: {
      locator: { kind: "selection", ref: "selection" },
      coverage: [{ selectionId: "selection" }],
    },
  };
  validateToolCall("propose_target", modern);
  assert.throws(() =>
    validateToolCall("propose_target", { ...modern, pageIndex: 0 }),
  );
  assert.throws(() =>
    validateToolCall("propose_target", {
      ...modern,
      source: {
        locator: { kind: "selection", ref: "s", quote: "extra" },
        coverage: [],
      },
    }),
  );
});
test("refs retain full immutable identity across persistence, reordering and different actors; wrong run/type rejected", () => {
  const r = {},
    hash = "b".repeat(64),
    ref = registerReference(r, "selection", hash);
  const other = registerReference(r, "target", "target-v1");
  const navigation = referenceProjection(r, {
    workspaceOption: {
      tool: "workspace_create",
      arguments: { title: "Draft", fromArtifact: hash },
    },
  });
  validateToolCall(
    navigation.workspaceOption.tool,
    navigation.workspaceOption.arguments,
  );
  assert.equal(navigation.workspaceOption.arguments.fromArtifact, ref);
  assert.equal(navigation.workspaceOption.arguments.refs, undefined);
  const copy = JSON.parse(JSON.stringify(r));
  copy.references.reverse();
  assert.equal(resolveReference(copy, ref, "selection"), hash);
  assert.equal(registerReference(copy, "selection", hash), ref);
  assert.throws(
    () => resolveReference(copy, other, "selection"),
    code("reference_invalid"),
  );
  assert.throws(
    () => resolveReference({}, ref, "selection"),
    code("reference_invalid"),
  );
  assert.equal(resolveReference(copy, hash, "artifact"), hash);
  const schema = validateToolCall("propose_target", {
    proposal,
    kind: "lemma",
    source: {
      locator: { kind: "selection", ref },
      coverage: [{ selectionId: ref }],
    },
  });
  const args = resolveArguments(copy, schema, {
    proposal,
    kind: "lemma",
    source: {
      locator: { kind: "selection", ref },
      coverage: [{ selectionId: ref }],
    },
  });
  assert.equal(args.source.locator.ref, hash);
  assert.equal(args.source.coverage[0].selectionId, hash);
  assert.equal(
    referenceProjection(copy, { selectionId: hash }).refs.selectionId,
    ref,
  );
  assert.equal(schema.properties.proposal["x-reference"], undefined);
});
test("source handles preserve control/non-BMP characters, exact bounds and independent coverage", async () => {
  const selected = selectSource(source, { pageIndex: 0, paragraphIndex: 1 });
  assert.equal(selected.quote, "A𝛼\u0000B implies C.");
  assert.equal(
    selectSource(source, { text: "𝛼\u0000" }, selected).quote,
    "𝛼\u0000",
  );
  assert.throws(
    () => selectSource(source, { pageIndex: 0, text: "repeat" }),
    code("source_ambiguous"),
  );
  assert.equal(
    selectSource(source, { pageIndex: 0, text: "repeat", occurrence: 1 }).start,
    source.pages[0].text.lastIndexOf("repeat"),
  );
  assert.throws(
    () => sourceSpan(source, 0, 0, source.pages[0].text.length + 1),
    code("source_range_invalid"),
  );
  const resolve = async (x) => (x.selectionId ? selected : x);
  const good = await targetSourceArguments(
    source,
    {
      proposal,
      source: {
        locator: { kind: "selection", ref: "s" },
        coverage: [
          { selectionId: "s" },
          { pageIndex: 1, quote: "Second page premise" },
        ],
      },
    },
    resolve,
  );
  assert.equal(good.proposal.quote, selected.quote);
  assert.equal(good.sourceSpans.length, 2);
  await assert.rejects(
    targetSourceArguments(
      source,
      {
        proposal: { ...proposal, quote: "fake" },
        source: {
          locator: { kind: "literal", pageIndex: 0, quote: "Heading" },
          coverage: [],
        },
      },
      resolve,
    ),
    code("source_selection_conflict"),
  );
  await assert.rejects(
    targetSourceArguments(
      source,
      { proposal: { ...proposal, quote: "Heading" }, sourceSpans: [] },
      resolve,
    ),
    code("source_locator_missing"),
  );
});
test("reservation detects a same-length preserved-mtime mutation before publishing any result", async (t) => {
  const root = await temp(t);
  await mkdir(path.join(root, "bin"));
  const f = path.join(root, "bin", "lean");
  await writeFile(f, "first");
  const before = await stat(f);
  let executions = 0,
    verifications = 0,
    published = false;
  const verify = async () => {
    verifications++;
    return {
      library: { snapshotId: "s" },
      bytes: await sharedContentTree(root, ["bin"]),
    };
  };
  await assert.rejects(
    checkedReservation(
      {},
      verify,
      async () => {
        executions++;
        await writeFile(f, "other");
        await utimes(f, before.atime, before.mtime);
        return "unsafe";
      },
      { access: new LibraryAccess() },
    ).then(() => {
      published = true;
    }),
    code("environment_changed"),
  );
  assert.equal(executions, 1);
  assert.equal(verifications, 2);
  assert.equal(published, false);
});
test("shared verification cancellation never cancels another consumer and does not cache changed bytes", async (t) => {
  const root = await temp(t);
  await mkdir(path.join(root, "lib"));
  await writeFile(
    path.join(root, "lib", "x"),
    Buffer.alloc(8 * 1024 * 1024, 1),
  );
  const a = new AbortController();
  const first = sharedContentTree(root, ["lib"], { signal: a.signal });
  const second = sharedContentTree(root, ["lib"]);
  a.abort(Error("one caller stopped"));
  await assert.rejects(first);
  const old = await second;
  await writeFile(
    path.join(root, "lib", "x"),
    Buffer.alloc(8 * 1024 * 1024, 2),
  );
  assert.notEqual((await sharedContentTree(root, ["lib"])).sha256, old.sha256);
});
test("isolated generation build does not block old readers; publication is atomic and parent-bound", async (t) => {
  const root = await temp(t);
  const one = "1".repeat(64),
    two = "2".repeat(64),
    three = "3".repeat(64);
  await publishGeneration(root, { snapshotId: one, parentSnapshotId: null });
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let begun;
  const started = new Promise((r) => {
    begun = r;
  });
  const build = generationBuild(root, async () => {
    begun();
    await gate;
    return publishGeneration(root, { snapshotId: two, parentSnapshotId: one });
  });
  await started;
  assert.equal((await readGeneration(root)).snapshotId, one);
  release();
  await build;
  assert.equal((await readGeneration(root)).snapshotId, two);
  await assert.rejects(
    publishGeneration(root, { snapshotId: three, parentSnapshotId: one }),
    /changed/,
  );
  await assert.rejects(
    generationBuild(root, async () => {
      throw Error("cache download failed");
    }),
    /download/,
  );
  assert.equal((await readGeneration(root)).snapshotId, two);
  await assert.rejects(
    generationCapacity(root, Number.MAX_SAFE_INTEGER),
    code("environment_storage_full"),
  );
});
test("reservation publication waits for managed readers, without occupying a native execution slot", async () => {
  const access = new LibraryAccess();
  let release;
  const gate = new Promise((r) => (release = r));
  let acquired;
  const ready = new Promise((r) => (acquired = r));
  let wrote = false;
  const read = checkedReservation(
    {},
    async () => ({ identity: 1 }),
    async () => {
      acquired();
      await gate;
    },
    { access },
  );
  await ready;
  const write = access.write(() => {
    wrote = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(wrote, false);
  release();
  await read;
  await write;
  assert.equal(wrote, true);
});
test("nested timing and UI keep diagnostics, parameter rejects and unknown results distinct", () => {
  const spans = [
    { id: "p", startedAtMs: 0, endedAtMs: 100, elapsedMs: 100 },
    { id: "a", parentId: "p", startedAtMs: 10, endedAtMs: 80, elapsedMs: 70 },
    { id: "b", parentId: "p", startedAtMs: 50, endedAtMs: 90, elapsedMs: 40 },
  ];
  assert.equal(intervalUnionMs(spans), 100);
  assert.equal(timingBreakdown(spans)[0].exclusiveMs, 20);
  assert.match(
    operationLabel({
      status: "failed",
      error: { dispatchState: "not_dispatched" },
    }),
    /未执行/,
  );
  assert.match(
    operationLabel({ status: "completed", resultSummary: { exitCode: 1 } }),
    /诊断编译返回失败/,
  );
  assert.match(operationLabel({ status: "unknown" }), /未自动重试/);
  assert.match(
    operationLabel({ status: "completed", resultSummary: { exitCode: 0 } }),
    /不是论文证明/,
  );
});
