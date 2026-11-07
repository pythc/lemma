import { readFile, realpath, lstat, readdir, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { digest } from "./evidence.mjs";
const sha = async (file) => {
  const h = createHash("sha256");
  for await (const b of createReadStream(file)) h.update(b);
  return h.digest("hex");
};
async function dependencyTree(root) {
  const entries = [];
  async function visit(relative) {
    const full = path.join(root, relative),
      info = await lstat(full);
    if (info.isDirectory()) {
      for (const name of (await readdir(full)).sort())
        await visit(path.join(relative, name));
    } else if (info.isSymbolicLink())
      entries.push({ path: relative, link: await readlink(full) });
    else if (info.isFile()) entries.push({ path: relative });
    else throw Error("Unsupported validation dependency file");
  }
  await visit("");
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < entries.length) {
        const entry = entries[next++];
        if (!Object.hasOwn(entry, "link"))
          entry.sha256 = await sha(path.join(root, entry.path));
      }
    }),
  );
  return { sha256: digest(entries), entries: entries.length };
}
export async function validationRuntime(root = process.cwd()) {
  const dependencies = {};
  for (const name of [
    "jsonc-parser",
    "zod",
    "deepagents",
    "langchain",
    "@langchain/core",
    "@langchain/langgraph",
    "undici",
    "better-sqlite3",
  ]) {
    const file = path.join(root, "node_modules", name, "package.json");
    dependencies[name] = {
      version: JSON.parse(await readFile(file, "utf8")).version,
      packageSha256: await sha(file),
    };
  }
  const sqliteBinary = path.join(
    root,
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  );
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(":memory:");
  let sqlite;
  try {
    sqlite = db.prepare("select sqlite_version() as version, 1 as ok").get();
  } finally {
    db.close();
  }
  const identity = {
    node: process.version,
    abi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    nodeBinarySha256: await sha(process.execPath),
    packageLockSha256: await sha(path.join(root, "package-lock.json")),
    dependencyTree: await dependencyTree(path.join(root, "node_modules")),
    dependencies,
    sqliteBinarySha256: await sha(sqliteBinary),
    sqlite,
    versionFiles: {
      nvmrc: (await readFile(path.join(root, ".nvmrc"), "utf8")).trim(),
      nodeVersion: (
        await readFile(path.join(root, ".node-version"), "utf8")
      ).trim(),
    },
  };
  return {
    identity,
    identityHash: digest(identity),
    location: {
      node: await realpath(process.execPath),
      dependencies: await realpath(path.join(root, "node_modules")),
      dependenciesAreSymlink: (
        await lstat(path.join(root, "node_modules"))
      ).isSymbolicLink(),
    },
    command: process.argv,
  };
}
export async function verifyValidationRuntime(root = process.cwd()) {
  const expected = JSON.parse(
    await readFile(path.join(root, "evaluation/runtime.json"), "utf8"),
  );
  if (
    process.version !== expected.identity.node ||
    process.versions.modules !== expected.identity.abi
  )
    throw Error(
      `Registered validation runtime requires Node ${expected.identity.node} ABI ${expected.identity.abi}; current ${process.version} ABI ${process.versions.modules}. Use the registered executable; do not rebuild shared native dependencies.`,
    );
  const actual = await validationRuntime(root);
  if (actual.identityHash !== expected.identityHash)
    throw Error("Registered validation runtime/dependency bytes changed");
  return actual;
}
