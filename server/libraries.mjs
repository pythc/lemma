import { readGeneration } from "./library-generation.mjs";
import { readFile, access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { sharedContentTree as contentTree } from "./toolchain-tree.mjs";
import { sha256 } from "./evidence.mjs";
import { libraryAccess } from "./library-access.mjs";
import {
  readLibrarySnapshot,
  sealLibrarySnapshot,
  restoreHistoricalSnapshot,
} from "./library-snapshot.mjs";
import {
  libraryProfile,
  LIBRARY_PROFILES,
  MATHLIB_COMMIT,
  MATHLIB_MANIFEST_SHA256,
} from "../shared/library-profiles.mjs";

export const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const MATHLIB_ROOT = path.join(APP_ROOT, ".tools/mathlib4-4.35.0");
export const SNAPSHOT_ROOT = path.join(APP_ROOT, ".tools/library-snapshots");
const requestedSnapshot = new AsyncLocalStorage();
export const withLibrarySnapshot = (id, action) =>
  requestedSnapshot.run(id, action);
export const MATHLIB_PACKAGES = Object.freeze([
  "plausible",
  "LeanSearchClient",
  "importGraph",
  "proofwidgets",
  "aesop",
  "Qq",
  "batteries",
  "Cli",
]);
export const LIBRARY_ROOTS = Object.freeze([
  ".lake/build/lib/lean",
  ...MATHLIB_PACKAGES.filter((p) => p !== "Cli").map(
    (p) => `.lake/packages/${p}/.lake/build/lib/lean`,
  ),
]);
// Search paths come only from this fixed list, never from a model, target or saved evidence.
export function analysisLibraryStatus(options = {}) {
  return libraryAccess.read(
    () => analysisLibraryStatusReserved(options),
    options,
  );
}
async function analysisLibraryStatusReserved({
  verify = false,
  root = MATHLIB_ROOT,
} = {}) {
  try {
    const manifest = await readFile(path.join(root, "lake-manifest.json"));
    const saved = JSON.parse(
      await readFile(path.join(root, "../mathlib-library.json"), "utf8"),
    );
    if (
      saved.schemaVersion !== "lemma.library.v1" ||
      sha256(manifest) !== MATHLIB_MANIFEST_SHA256 ||
      saved.commit !== MATHLIB_COMMIT ||
      saved.manifestSha256 !== MATHLIB_MANIFEST_SHA256 ||
      JSON.stringify(saved.roots) !== JSON.stringify(LIBRARY_ROOTS)
    )
      throw new Error("库版本或路径不匹配");
    const canonicalRoot = await realpath(root);
    for (const relative of LIBRARY_ROOTS) {
      const folder = await realpath(path.join(root, relative));
      if (folder !== path.join(canonicalRoot, relative))
        throw new Error("库路径包含符号链接");
    }
    for (const module of libraryProfile("analysis-continuity-v1").imports)
      await access(
        path.join(
          root,
          ".lake/build/lib/lean",
          module.replaceAll(".", "/") + ".olean",
        ),
      );
    if (!/^[a-f0-9]{64}$/.test(saved.content?.sha256))
      throw new Error("库指纹缺失");
    if (verify) {
      const actual = await contentTree(root, LIBRARY_ROOTS);
      if (actual.sha256 !== saved.content.sha256)
        throw Object.assign(new Error("库内容摘要不匹配"), {
          code: "library_digest_mismatch",
          details: { expected: saved.content.sha256, actual: actual.sha256 },
        });
      const after = await readFile(
        path.join(root, "../mathlib-library.json"),
        "utf8",
      );
      if (JSON.stringify(JSON.parse(after)) !== JSON.stringify(saved))
        throw Object.assign(new Error("校验期间库发布清单发生变化"), {
          code: "library_publication_changed",
        });
    }
    return {
      ready: true,
      commit: MATHLIB_COMMIT,
      manifestSha256: MATHLIB_MANIFEST_SHA256,
      content: saved.content,
      contentVerified: verify,
      dependencies: JSON.parse(manifest).packages.map((p) => ({
        name: p.name,
        revision: p.rev,
        url: p.url,
      })),
    };
  } catch (error) {
    return {
      ready: false,
      reason: `实分析库未通过身份检查：${error.message}`,
      code:
        error.code === "ENOENT"
          ? "library_missing"
          : error.code || "library_identity_mismatch",
      ...(error.details ? { details: error.details } : {}),
    };
  }
}
export async function profileStatuses(stdReady) {
  const analysis = await analysisLibraryStatus();
  return Promise.all(
    LIBRARY_PROFILES.map(async (p) => ({
      ...p,
      ...(p.id === "std-v1"
        ? { ready: stdReady === true }
        : await profileModules(p, analysis)),
    })),
  );
}
async function profileModules(profile, status, root = MATHLIB_ROOT) {
  if (!status.ready) return status;
  try {
    await Promise.all(
      profile.imports.map((name) =>
        access(
          path.join(
            root,
            ".lake/build/lib/lean",
            name.replaceAll(".", "/") + ".olean",
          ),
        ),
      ),
    );
    return status;
  } catch {
    return {
      ...status,
      ready: false,
      reason: "所选数学方向的固定模块尚未安装。",
    };
  }
}
export function libraryEnvironment(...args) {
  return libraryAccess.read(() => libraryEnvironmentReserved(...args));
}
async function libraryEnvironmentReserved(
  profileId,
  domainContext = null,
  externalLibraries = [],
) {
  const profile = libraryProfile(profileId);
  if (externalLibraries.length) {
    try {
      const { verifyExternalLibrary, EXTERNAL_ROOT } =
        await import("./external-libraries.mjs");
      const base = await libraryEnvironment(
        profileId === "std-v1" ? "analysis-continuity-v1" : profileId,
        domainContext,
      );
      if (!base.ready) return base;
      const receipts = [];
      for (const e of externalLibraries) {
        const r = await verifyExternalLibrary(e.id);
        if (
          r.tree.sha256 !== e.treeSha256 ||
          JSON.stringify(r.modules) !== JSON.stringify(e.modules)
        )
          throw Error("External library identity mismatch");
        receipts.push(r);
      }
      return {
        ...base,
        externalLibraries: receipts,
        searchPaths: [
          ...base.searchPaths,
          ...externalLibraries.map((e) =>
            path.join(EXTERNAL_ROOT, e.id, "build"),
          ),
        ],
      };
    } catch (e) {
      return { ready: false, searchPaths: [], reason: e.message };
    }
  }
  if (profile.id === "std-v1" && !domainContext?.modules.length)
    return {
      ready: true,
      profile: profile.id,
      revision: profile.revision,
      searchPaths: [],
    };
  try {
    const options = {
      snapshotRoot: SNAPSHOT_ROOT,
      roots: LIBRARY_ROOTS,
      commit: MATHLIB_COMMIT,
      manifestSha256: MATHLIB_MANIFEST_SHA256,
    };
    const expected =
      requestedSnapshot.getStore() ||
      (await readGeneration(path.join(APP_ROOT, ".tools/mathlib-generations")))
        ?.snapshotId;
    let snapshot;
    if (expected) {
      try {
        snapshot = await readLibrarySnapshot(expected, options);
      } catch (e) {
        if (e.code !== "library_snapshot_missing") throw e;
        snapshot = await restoreHistoricalSnapshot(expected, {
          ...options,
          sourceRoot: MATHLIB_ROOT,
          historyRoot: path.join(APP_ROOT, ".tools/domain-cache-history"),
        });
      }
    } else {
      const current = await analysisLibraryStatus();
      if (!current.ready) return { ...current, searchPaths: [] };
      snapshot = await sealLibrarySnapshot({
        ...options,
        sourceRoot: MATHLIB_ROOT,
        identity: current,
      });
    }
    if (domainContext?.modules.length) {
      const { verifyDomainModules } = await import("./domain-library.mjs");
      await verifyDomainModules(domainContext.modules, {
        root: snapshot.directory,
      });
    }
    const manifest = JSON.parse(
      await readFile(
        path.join(snapshot.directory, "lake-manifest.json"),
        "utf8",
      ),
    );
    const status = await profileModules(
      {
        ...profile,
        imports: [
          ...profile.imports.filter((n) => n !== "Std"),
          ...(domainContext?.modules || []).map((m) => m.name),
        ],
      },
      {
        ready: true,
        commit: MATHLIB_COMMIT,
        manifestSha256: MATHLIB_MANIFEST_SHA256,
        content: snapshot.descriptor.content,
        contentVerified: true,
        dependencies: manifest.packages.map((p) => ({
          name: p.name,
          revision: p.rev,
          url: p.url,
        })),
        snapshot: {
          schemaVersion: snapshot.descriptor.schemaVersion,
          id: snapshot.descriptor.id,
        },
      },
      snapshot.directory,
    );
    return {
      ...status,
      profile: profile.id,
      revision: profile.revision,
      searchPaths: status.ready ? snapshot.searchPaths : [],
    };
  } catch (error) {
    return {
      ready: false,
      searchPaths: [],
      reason: error.message,
      code: error.code || "library_snapshot_invalid",
      ...(error.details ? { details: error.details } : {}),
    };
  }
}

// Publication identity changes when the fixed official cache is extended. It
// invalidates deterministic failure caches without trusting mutable model text.
export async function libraryPublicationIdentity() {
  try {
    const generation = await readGeneration(
      path.join(APP_ROOT, ".tools/mathlib-generations"),
    );
    const value = JSON.parse(
      await readFile(
        path.join(APP_ROOT, ".tools/mathlib-library.json"),
        "utf8",
      ),
    );
    return {
      revision: MATHLIB_COMMIT,
      contentSha256: value.content?.sha256 || null,
      generationId: generation?.snapshotId || null,
    };
  } catch {
    return { revision: MATHLIB_COMMIT, contentSha256: null };
  }
}
