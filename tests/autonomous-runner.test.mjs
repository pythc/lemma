import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

test("offline continuation refuses a live store before crash recovery or model dispatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-live-store-"));
  const store = path.join(root, "store"),
    id = randomUUID();
  const file = path.join(store, "runs", id + ".json");
  await mkdir(path.dirname(file), { recursive: true });
  const bytes = JSON.stringify({
    id,
    status: "running",
    note: "owned by another process",
  });
  await writeFile(file, bytes);
  try {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          "scripts/continue-autonomous-source.mjs",
          store,
          id,
          path.join(root, "out"),
          "--verify-only",
        ],
        { cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 15000 },
      ),
      (error) => {
        assert.match(error.stderr, /Store contains an unfinished review/);
        return true;
      },
    );
    assert.equal(
      await readFile(file, "utf8"),
      bytes,
      "live state must not be marked interrupted",
    );
    assert.deepEqual(
      await readdir(store),
      ["runs"],
      "no checkpoint database or evidence writes may occur",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a continuation budget is explicit and cannot exceed shared limits or mutate an input store before validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-invalid-budget-"));
  try {
    for (const flag of [
      "--model-calls=0",
      "--model-calls=257",
      "--model-calls=NaN",
    ]) {
      await assert.rejects(
        promisify(execFile)(
          process.execPath,
          [
            "scripts/continue-autonomous-source.mjs",
            path.join(root, "store"),
            randomUUID(),
            path.join(root, "out"),
            flag,
          ],
          {
            cwd: fileURLToPath(new URL("../", import.meta.url)),
            timeout: 15000,
          },
        ),
        (error) =>
          /Invalid (model call limit|continuation option)/.test(error.stderr),
      );
      assert.deepEqual(await readdir(root), []);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
