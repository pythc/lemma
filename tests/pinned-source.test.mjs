import test from "node:test";
import assert from "node:assert/strict";
import {
  readPinnedMathlibSource,
  sourceWindow,
} from "../server/library-source.mjs";
import { moduleManifest } from "../server/domain-library.mjs";
import { MATHLIB_COMMIT } from "../shared/library-profiles.mjs";
import { sha256 } from "../server/evidence.mjs";
import { readExternalLibrarySource } from "../server/external-libraries.mjs";

test("pinned source is available offline with the exact Git identity and explicit paging", async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error("Network is forbidden in this fixture");
  };
  try {
    const module = "Mathlib.Analysis.Convex.Function";
    const first = await readPinnedMathlibSource(module, { lineCount: 12 });
    assert.equal(first.revision, MATHLIB_COMMIT);
    assert.equal(first.acquisition, "local_immutable_git_object_no_network");
    assert.equal(
      first.sourceSha256,
      (await moduleManifest([module]))[0].sourceSha256,
    );
    assert.equal(first.startLine, 1);
    assert.equal(first.endLine, 12);
    assert.equal(first.nextLine, 13);
    assert.equal(first.excerptSha256, sha256(first.text));
    const second = await readPinnedMathlibSource(module, {
      startLine: first.nextLine,
      lineCount: 12,
    });
    assert.equal(second.sourceSha256, first.sourceSha256);
    assert.equal(second.startLine, 13);
    assert.notEqual(second.text, first.text);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test("source windows preserve full identity, endpoints and trailing newline without claiming verification", () => {
  const text = "one\ntwo\nthree\n";
  const a = sourceWindow(text, { lineCount: 2 });
  const b = sourceWindow(text, { startLine: a.nextLine, lineCount: 2 });
  assert.equal(a.text + "\n" + b.text, text);
  assert.equal(b.nextLine, null);
  assert.equal(a.sourceSha256, b.sourceSha256);
  assert.match(a.scope, /not_import_availability_or_proof_certificate/);
  for (const options of [
    { startLine: 0 },
    { startLine: 99 },
    { lineCount: 0 },
    { lineCount: 401 },
    { lineCount: 1.5 },
  ])
    assert.throws(() => sourceWindow(text, options));
  assert.throws(() => sourceWindow("x".repeat(64001)), /too large/);
});

test("source inspection rejects paths, commands, foreign modules and cancelled reads", async () => {
  for (const module of [
    "../.env.local",
    "Mathlib/Analysis/Convex/Function",
    "Mathlib.Analysis;cat",
    "Std.Data",
    "Mathlib..Basic",
    "Mathlib.$HOME",
  ])
    await assert.rejects(readPinnedMathlibSource(module), /module name/);
  await assert.rejects(
    readPinnedMathlibSource("Mathlib.Analysis.Convex.Function", {
      signal: AbortSignal.abort(Error("cancelled fixture")),
    }),
    /cancelled fixture/,
  );
});

test("external source reads require immutable identities and bound response bytes before exposing content", async () => {
  const before = globalThis.fetch;
  let calls = 0,
    oversize = false,
    invalidEncoding = false;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url.hostname, "raw.githubusercontent.com");
    assert.equal(options.redirect, "error");
    assert(!options.headers.Authorization);
    return new Response(
      invalidEncoding
        ? new Uint8Array([255])
        : oversize
          ? "x".repeat(1000001)
          : "-- controlled library source\n",
    );
  };
  try {
    const info = { repo: "fixture/library", revision: "a".repeat(40) };
    const value = await readExternalLibrarySource(info, "Fixture.Module");
    assert.equal(value.revision, info.revision);
    assert.equal(value.text, "-- controlled library source\n");
    assert.equal(value.sourceBytesSha256, sha256(Buffer.from(value.text)));
    await assert.rejects(
      readExternalLibrarySource(
        { ...info, revision: "main" },
        "Fixture.Module",
      ),
      /Immutable/,
    );
    await assert.rejects(
      readExternalLibrarySource(info, "../.env.local"),
      /module/,
    );
    assert.equal(calls, 1, "invalid identities must not dispatch a request");
    oversize = true;
    await assert.rejects(
      readExternalLibrarySource(info, "Fixture.Module"),
      /download limit/,
    );
    oversize = false;
    invalidEncoding = true;
    await assert.rejects(
      readExternalLibrarySource(info, "Fixture.Module"),
      /UTF-8/,
    );
  } finally {
    globalThis.fetch = before;
  }
});
