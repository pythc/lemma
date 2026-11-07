import { readFile, readdir, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digest, isHash, sha256 } from "./evidence.mjs";
import { contentTree, toolchainTree } from "./toolchain-tree.mjs";

export const ENV_ROOT = fileURLToPath(
  new URL("../.tools/environments/", import.meta.url),
);
export const DEFAULT_ENVIRONMENT = "lean-4.35.0";
export function validateEnvironmentDescriptor(e) {
  if (
    !e ||
    !/^lean-\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(e.id) ||
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(e.version) ||
    e.id !== `lean-${e.version}` ||
    !isHash(e.receiptSha256) ||
    !isHash(e.distributionSha256) ||
    !isHash(e.librarySha256) ||
    typeof e.libraryRevision !== "string"
  )
    throw Error("Invalid execution environment");
  if (
    Object.keys(e).some(
      (k) =>
        ![
          "id",
          "version",
          "receiptSha256",
          "distributionSha256",
          "librarySha256",
          "libraryRevision",
        ].includes(k),
    )
  )
    throw Error("Unexpected execution environment field");
  return e;
}
export async function resolveEnvironment(e) {
  validateEnvironmentDescriptor(e);
  const directory = path.join(ENV_ROOT, e.id);
  if ((await lstat(directory)).isSymbolicLink())
    throw Error("Environment root must not be a symlink");
  const receipt = JSON.parse(
    await readFile(path.join(directory, "receipt.json"), "utf8"),
  );
  if (
    digest(receipt) !== e.receiptSha256 ||
    receipt.version !== e.version ||
    receipt.platform !== process.platform ||
    receipt.arch !== process.arch
  )
    throw Error("Environment receipt changed or host mismatch");
  const inside = async (relative) => {
    if (
      typeof relative !== "string" ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).includes("..")
    )
      throw Error("Invalid environment path");
    const full = await realpath(path.join(directory, relative));
    if (!full.startsWith((await realpath(directory)) + path.sep))
      throw Error("Environment path escapes root");
    return full;
  };
  const toolRoot = await inside(receipt.toolRoot);
  const distribution = await toolchainTree(toolRoot);
  if (
    distribution.sha256 !== e.distributionSha256 ||
    distribution.sha256 !== receipt.distribution.sha256
  )
    throw Error("Environment distribution changed");
  const binary = path.join(toolRoot, "bin/lean");
  if (sha256(await readFile(binary)) !== receipt.binarySha256)
    throw Error("Environment executable changed");
  const searchPaths = await Promise.all(
    (receipt.libraryPaths || []).map(inside),
  );
  const libraryTrees = await Promise.all(
    searchPaths.map((p) => contentTree(p, ["."])),
  );
  const librarySha256 = digest(libraryTrees.map((t) => t.sha256));
  if (
    librarySha256 !== e.librarySha256 ||
    receipt.librarySha256 !== librarySha256 ||
    receipt.libraryRevision !== e.libraryRevision
  )
    throw Error("Environment library changed");
  return { toolRoot, binary, searchPaths, receipt, identity: e };
}
export async function environmentCatalog() {
  let files;
  try {
    files = await readdir(ENV_ROOT);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const results = [];
  for (const name of files.filter((n) =>
    /^lean-\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(n),
  )) {
    try {
      const receipt = JSON.parse(
        await readFile(path.join(ENV_ROOT, name, "receipt.json"), "utf8"),
      );
      const descriptor = validateEnvironmentDescriptor({
        id: name,
        version: receipt.version,
        receiptSha256: digest(receipt),
        distributionSha256: receipt.distribution.sha256,
        librarySha256: receipt.librarySha256,
        libraryRevision: receipt.libraryRevision,
      });
      results.push({
        descriptor,
        profiles: receipt.profiles,
        ready: true,
        verification: "receipt_only_execution_rehashes_all_content",
      });
    } catch (e) {
      results.push({ id: name, ready: false, reason: e.message });
    }
  }
  return results;
}
