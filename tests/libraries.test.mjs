import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  rename,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { analysisLibraryStatus, LIBRARY_ROOTS } from "../server/libraries.mjs";
import { contentTree } from "../server/toolchain-tree.mjs";
import {
  MATHLIB_COMMIT,
  MATHLIB_MANIFEST_SHA256,
  libraryProfile,
} from "../shared/library-profiles.mjs";

test("library integrity rejects changed cache files and a path redirected outside the installed library", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "lemma-library-integrity-"),
  );
  const root = path.join(parent, "mathlib");
  try {
    for (const relative of LIBRARY_ROOTS)
      await mkdir(path.join(root, relative), { recursive: true });
    await writeFile(
      path.join(root, "lake-manifest.json"),
      await readFile(
        new URL("../fixtures/mathlib-lake-manifest.json", import.meta.url),
      ),
    );
    for (const name of libraryProfile("analysis-continuity-v1").imports) {
      const file = path.join(
        root,
        ".lake/build/lib/lean",
        name.replaceAll(".", "/") + ".olean",
      );
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        "DISPOSABLE INTEGRITY FIXTURE - NOT A LEAN LIBRARY",
      );
    }
    const content = await contentTree(root, LIBRARY_ROOTS);
    await writeFile(
      path.join(parent, "mathlib-library.json"),
      JSON.stringify({
        schemaVersion: "lemma.library.v1",
        commit: MATHLIB_COMMIT,
        manifestSha256: MATHLIB_MANIFEST_SHA256,
        roots: LIBRARY_ROOTS,
        content,
      }),
    );
    assert.equal(
      (await analysisLibraryStatus({ root, verify: true })).ready,
      true,
      "This only tests a locally attested fingerprint, not compiler validity; real kernel tests are separate.",
    );
    const file = path.join(
      root,
      ".lake/build/lib/lean/Mathlib/Tactic/Linarith.olean",
    );
    await writeFile(file, "MODIFIED");
    assert.equal(
      (await analysisLibraryStatus({ root, verify: true })).ready,
      false,
    );
    await writeFile(file, "DISPOSABLE INTEGRITY FIXTURE - NOT A LEAN LIBRARY");
    const original = path.join(root, LIBRARY_ROOTS[0]);
    await rename(original, original + "-saved");
    const outside = path.join(parent, "outside");
    await mkdir(outside);
    await symlink(outside, original);
    assert.equal((await analysisLibraryStatus({ root })).ready, false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
