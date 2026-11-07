import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contentTree } from "../server/toolchain-tree.mjs";
import { digest, sha256 } from "../server/evidence.mjs";
test("bounded full-byte tree hashing preserves ordered historical identity and detects mutations and unsupported entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sixth-tree-"));
  try {
    await mkdir(root + "/z");
    await mkdir(root + "/a");
    const files = [];
    for (const dir of ["z", "a"])
      for (let i = 0; i < 20; i++) {
        const name = String(i).padStart(2, "0"),
          bytes = Buffer.alloc(1024 * (i + 1), i);
        await writeFile(root + "/" + dir + "/" + name, bytes);
        files.push({ path: dir + "/" + name, sha256: sha256(bytes) });
      }
    const result = await contentTree(root, ["z", "a"], { includeFiles: true });
    assert.deepEqual(result.files, files);
    assert.equal(result.sha256, digest(files));
    await writeFile(root + "/a/00", "changed");
    assert.notEqual(
      (await contentTree(root, ["z", "a"])).sha256,
      result.sha256,
    );
    await symlink(root + "/a/00", root + "/a/link");
    await assert.rejects(contentTree(root, ["z", "a"]), /不支持/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
