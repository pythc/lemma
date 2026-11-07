import { access, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  APP_ROOT,
  MATHLIB_ROOT,
  LIBRARY_ROOTS,
  MATHLIB_PACKAGES,
  analysisLibraryStatus,
} from "../server/libraries.mjs";
import { leanStatus } from "../server/lean.mjs";
import {
  MATHLIB_COMMIT,
  MATHLIB_MANIFEST_SHA256,
  libraryProfile,
  LIBRARY_PROFILES,
} from "../shared/library-profiles.mjs";
import { sha256 } from "../server/evidence.mjs";
import { contentTree } from "../server/toolchain-tree.mjs";
import { libraryAccess } from "../server/library-access.mjs";
const exec = promisify(execFile);
const tool = path.join(APP_ROOT, ".tools/lean-4.35.0-darwin_aarch64/bin");
const env = {
  ...process.env,
  PATH: tool + path.delimiter + process.env.PATH,
  MATHLIB_CACHE_DIR: path.join(APP_ROOT, ".tools/mathlib-cache"),
  LEAN_PATH: "",
};
const run = (command, args, cwd = APP_ROOT) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
      detached: true,
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      reject(
        new Error(
          "Library preparation exceeded 15 minutes; keep the checkout and resume explicitly.",
        ),
      );
    }, 900000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`));
    });
  });
const git = async (cwd, ...args) =>
  (await exec("git", args, { cwd, env, timeout: 30000 })).stdout.trim();
await libraryAccess.write(async () => {
  if (!(await leanStatus({ verifyLibraries: true })).ready)
    throw new Error(
      "Install and verify the pinned Lean distribution first with npm run setup:lean.",
    );
  await mkdir(path.join(APP_ROOT, ".tools"), { recursive: true });
  try {
    await access(MATHLIB_ROOT);
  } catch {
    await run("git", [
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--branch",
      "v4.35.0",
      "https://github.com/leanprover-community/mathlib4.git",
      MATHLIB_ROOT,
    ]);
  }
  if (
    (await git(MATHLIB_ROOT, "rev-parse", "HEAD")) !== MATHLIB_COMMIT ||
    (await git(MATHLIB_ROOT, "status", "--porcelain"))
  )
    throw new Error(
      "The mathlib checkout differs from the pinned clean revision; no files were reset.",
    );
  const manifest = await readFile(
    path.join(MATHLIB_ROOT, "lake-manifest.json"),
  );
  if (
    sha256(manifest) !== MATHLIB_MANIFEST_SHA256 ||
    (
      await readFile(path.join(MATHLIB_ROOT, "lean-toolchain"), "utf8")
    ).trim() !== "leanprover/lean4:v4.35.0"
  )
    throw new Error(
      "The official dependency manifest or Lean version differs.",
    );
  async function checkDependency(pkg, allowMissing = false) {
    if (!MATHLIB_PACKAGES.includes(pkg.name))
      throw new Error("Unexpected dependency package.");
    const folder = path.join(MATHLIB_ROOT, ".lake/packages", pkg.name);
    try {
      await access(folder);
    } catch (e) {
      if (allowMissing && e.code === "ENOENT") return;
      throw e;
    }
    if (
      (await git(folder, "rev-parse", "HEAD")) !== pkg.rev ||
      (await git(folder, "status", "--porcelain"))
    )
      throw new Error(
        `Dependency ${pkg.name} differs from the pinned source; no reset was attempted.`,
      );
  }
  for (const pkg of JSON.parse(manifest).packages)
    await checkDependency(pkg, true);
  const requiredModules = [
    ...new Set(
      LIBRARY_PROFILES.filter((p) => p.id !== "std-v1").flatMap(
        (p) => p.imports,
      ),
    ),
  ];
  const modulesReady = (
    await Promise.all(
      requiredModules.map(async (name) => {
        try {
          await access(
            path.join(
              MATHLIB_ROOT,
              ".lake/build/lib/lean",
              name.replaceAll(".", "/") + ".olean",
            ),
          );
          return true;
        } catch {
          return false;
        }
      }),
    )
  ).every(Boolean);
  if (
    (await analysisLibraryStatus({ verify: true })).ready &&
    modulesReady &&
    !process.argv.includes("--refresh")
  ) {
    console.log(
      "Pinned analysis library is already installed and its contents match the recorded fingerprint.",
    );
    process.exit(0);
  }
  await run(
    path.join(tool, "lake"),
    ["exe", "cache", "get!", ...requiredModules],
    MATHLIB_ROOT,
  );
  const dependencies = [];
  for (const pkg of JSON.parse(manifest).packages) {
    await checkDependency(pkg);
    dependencies.push({ name: pkg.name, revision: pkg.rev, url: pkg.url });
  }
  const content = await contentTree(MATHLIB_ROOT, LIBRARY_ROOTS);
  const metadata = path.join(APP_ROOT, ".tools/mathlib-library.json");
  const temporary = `${metadata}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify(
      {
        schemaVersion: "lemma.library.v1",
        commit: MATHLIB_COMMIT,
        manifestSha256: MATHLIB_MANIFEST_SHA256,
        roots: LIBRARY_ROOTS,
        dependencies,
        content,
        acquisition: "pinned_official_source_and_official_prebuilt_cache",
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  await rename(temporary, metadata);
  console.log(
    `Pinned analysis library ready: ${content.fileCount} compiled files, ${content.sha256}`,
  );
});
