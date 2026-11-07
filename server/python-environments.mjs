import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digest, sha256 } from "./evidence.mjs";
import { acquireFileLease } from "./file-lease.mjs";
const exec = promisify(execFile),
  root = fileURLToPath(
    new URL("../.tools/numeric-environments/", import.meta.url),
  );
let base;
export async function basePython() {
  if (base) return base;
  for (const name of ["/opt/homebrew/bin/python3.12", "/usr/bin/python3"])
    try {
      const binary = await realpath(name);
      const { stdout } = await exec(
        binary,
        [
          "-I",
          "-c",
          "import sys,json; print(json.dumps({'prefix':sys.base_prefix,'version':sys.version.split()[0]}))",
        ],
        { timeout: 10000 },
      );
      base = { binary, ...JSON.parse(stdout) };
      base.prefix = await realpath(base.prefix);
      base.binarySha256 = sha256(await readFile(binary));
      return base;
    } catch {}
  throw Error("No isolated Python runtime available");
}
async function tree(dir) {
  const files = {};
  async function walk(folder, rel = "") {
    for (const e of await readdir(folder, { withFileTypes: true })) {
      const name = path.join(rel, e.name);
      if (e.isSymbolicLink())
        throw Error("Package environment contains an unexpected symlink");
      if (e.isDirectory()) await walk(path.join(folder, e.name), name);
      else files[name] = sha256(await readFile(path.join(folder, e.name)));
    }
  }
  await walk(dir);
  return digest(files);
}
export function pinnedPackages(packages) {
  if (!Array.isArray(packages) || !packages.length || packages.length > 50)
    throw Error("packages must contain 1..50 exact name/version pairs");
  const result = packages
    .map((p) => {
      if (
        !p ||
        typeof p.name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(p.name) ||
        typeof p.version !== "string" ||
        !/^[0-9][A-Za-z0-9.!+_-]{0,80}$/.test(p.version)
      )
        throw Error(
          "Use exact package name/version pairs; URLs, ranges and installer flags are not package identities",
        );
      return {
        name: p.name.toLowerCase().replace(/[-_.]+/g, "-"),
        version: p.version,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(result.map((p) => p.name)).size !== result.length)
    throw Error("Duplicate package names");
  return result;
}
export async function resolvePythonEnvironment(id) {
  const py = await basePython();
  if (!id) return py;
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
    throw Error("environmentId must be the exact prepared environment hash");
  const dir = path.join(root, id),
    manifest = JSON.parse(
      await readFile(path.join(dir, "environment.json"), "utf8"),
    );
  if (
    digest({
      schemaVersion: "lemma.python-environment.v1",
      packages: manifest.packages,
      binarySha256: py.binarySha256,
    }) !== id ||
    manifest.contentSha256 !== (await tree(path.join(dir, "venv/lib")))
  )
    throw Error("Prepared Python environment identity changed");
  const prefix = await realpath(path.join(dir, "venv"));
  if (
    manifest.configSha256 !==
      sha256(await readFile(path.join(prefix, "pyvenv.cfg"))) ||
    py.binarySha256 !==
      sha256(await readFile(await realpath(path.join(prefix, "bin/python"))))
  )
    throw Error("Prepared Python interpreter identity changed");
  return {
    ...py,
    binary: path.join(prefix, "bin/python"),
    prefix,
    basePrefix: py.prefix,
    environmentId: id,
    packages: manifest.packages,
    contentSha256: manifest.contentSha256,
  };
}
export async function numericInventory(id) {
  const py = await resolvePythonEnvironment(id);
  const { stdout } = await exec(
    py.binary,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      "import importlib.metadata as m,json,sys; print(json.dumps(sorted([{'name':d.metadata['Name'],'version':d.version} for d in m.distributions(path=[sys.argv[1]])],key=lambda d:d['name'])))",
      path.join(
        py.prefix,
        "lib",
        "python" + py.version.split(".").slice(0, 2).join("."),
        "site-packages",
      ),
    ],
    { timeout: 10000, maxBuffer: 128000 },
  );
  return {
    version: py.version,
    environmentId: id || null,
    packages: JSON.parse(stdout),
    scope: "isolated_runtime_inventory_not_a_computation",
  };
}
export async function preparePythonEnvironment(packages, { signal } = {}) {
  const list = pinnedPackages(packages),
    py = await basePython(),
    id = digest({
      schemaVersion: "lemma.python-environment.v1",
      packages: list,
      binarySha256: py.binarySha256,
    });
  await mkdir(root, { recursive: true });
  const lease = await acquireFileLease(path.join(root, id + ".lock"), "write", {
    signal,
  });
  let temporary;
  try {
    const target = path.join(root, id);
    try {
      await access(path.join(target, "environment.json"));
      return { ...(await resolvePythonEnvironment(id)), reused: true };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    temporary = await mkdtemp(path.join(root, ".preparing-"));
    const { runBounded } = await import("./lean.mjs");
    const execute = async (command, args) => {
      const r = await runBounded(command, args, {
        cwd: temporary,
        signal,
        timeoutMs: 300000,
        maxMemoryMiB: 1024,
        maxOutput: 200000,
      });
      if (r.exitCode !== 0 || r.termination)
        throw Error(
          `Python environment preparation failed: ${r.termination || r.stderr.slice(-3000)}`,
        );
    };
    await execute(py.binary, [
      "-I",
      "-m",
      "venv",
      path.join(temporary, "venv"),
    ]);
    const bin = path.join(temporary, "venv/bin/python"),
      wheels = path.join(temporary, "wheels");
    await execute(bin, [
      "-I",
      "-m",
      "pip",
      "--isolated",
      "download",
      "--index-url",
      "https://pypi.org/simple",
      "--only-binary=:all:",
      "--no-deps",
      "--dest",
      wheels,
      ...list.map((p) => `${p.name}==${p.version}`),
    ]);
    await execute(bin, [
      "-I",
      "-m",
      "pip",
      "--isolated",
      "install",
      "--no-index",
      "--no-deps",
      "--no-compile",
      "--find-links",
      wheels,
      ...list.map((p) => `${p.name}==${p.version}`),
    ]);
    const wheelHashes = {};
    for (const file of await readdir(wheels))
      wheelHashes[file] = sha256(await readFile(path.join(wheels, file)));
    const manifest = {
      schemaVersion: "lemma.python-environment.v1",
      configSha256: sha256(
        await readFile(path.join(temporary, "venv/pyvenv.cfg")),
      ),
      packages: list,
      binarySha256: py.binarySha256,
      contentSha256: await tree(path.join(temporary, "venv/lib")),
      wheelHashes,
      installer: "pypi_wheels_exact_versions_no_dependency_resolution",
    };
    await writeFile(
      path.join(temporary, "environment.json"),
      JSON.stringify(manifest),
    );
    lease.assertHeld();
    await rename(temporary, target);
    temporary = null;
    return {
      ...(await resolvePythonEnvironment(id)),
      wheelHashes,
      reused: false,
    };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await lease.release();
  }
}
