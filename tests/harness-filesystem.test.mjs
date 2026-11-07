import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProofFilesystemBackend } from "../server/harness-filesystem.mjs";

test("SDK virtual and shell physical paths refer to one isolated workspace", async () => {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "lemma-fs-alias-")),
  );
  try {
    const backend = new ProofFilesystemBackend(dir);
    assert.equal(
      (await backend.write(path.join(dir, "Probe.lean"), "-- test")).error,
      undefined,
    );
    assert.equal(
      await readFile(path.join(dir, "Probe.lean"), "utf8"),
      "-- test",
    );
    assert.equal(
      (await backend.edit("/Probe.lean", "-- test", "-- edited")).error,
      undefined,
    );
    assert.equal(
      await readFile(path.join(dir, "Probe.lean"), "utf8"),
      "-- edited",
    );
    assert.equal(
      backend.resolvePath("/Probe.lean"),
      backend.resolvePath(path.join(dir, "Probe.lean")),
    );
    assert.equal(backend.resolvePath(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("workspace aliases retain traversal and symlink guards and cannot expose host files", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "lemma-fs-boundary-")),
  );
  const dir = path.join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir);
  const secret = path.join(root, "outside.txt");
  await writeFile(secret, "HOST_CANARY");
  try {
    const backend = new ProofFilesystemBackend(dir);
    assert.match(
      (await backend.write(secret, "overwrite")).error,
      /Outside proof workspace/,
    );
    assert.equal(await readFile(secret, "utf8"), "HOST_CANARY");
    assert.throws(
      () => backend.resolvePath(path.join(dir, "../outside.txt")),
      /traversal|Outside/,
    );
    await symlink(secret, path.join(dir, "escape.txt"));
    assert.match(
      JSON.stringify(await backend.read("/escape.txt")),
      /outside|Error/i,
    );
    assert.match(
      (await backend.write("/escape.txt", "overwrite")).error,
      /outside|symlink/i,
    );
    assert.equal(await readFile(secret, "utf8"), "HOST_CANARY");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("SDK mutations cannot replace fixed goals, tasks or compiled goal modules", async () => {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "lemma-fs-reserved-")),
  );
  try {
    const backend = new ProofFilesystemBackend(dir);
    for (const name of [
      "Task.json",
      "current-contract.json",
      "Goal.lean",
      "Goal.olean",
    ]) {
      await writeFile(path.join(dir, name), "FIXED");
      assert.match(
        (await backend.write(path.join(dir, name), "changed")).error,
        /Reserved/,
      );
      assert.match(
        (await backend.edit("/" + name, "FIXED", "changed")).error,
        /Reserved/,
      );
      assert.match((await backend.delete("/" + name)).error, /Reserved/);
      assert.equal(await readFile(path.join(dir, name), "utf8"), "FIXED");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
