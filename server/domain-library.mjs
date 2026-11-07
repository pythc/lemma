import { cp, chmod, readdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import {
  readGeneration,
  publishGeneration,
  generationBuild,
  guardedGeneration,
} from "./library-generation.mjs";
import {
  readLibrarySnapshot,
  sealLibrarySnapshot,
} from "./library-snapshot.mjs";
import { nativeSpan } from "./native-timing.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  rename,
  access,
  mkdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  APP_ROOT,
  MATHLIB_ROOT,
  LIBRARY_ROOTS,
  MATHLIB_PACKAGES,
  SNAPSHOT_ROOT,
  analysisLibraryStatus,
} from "./libraries.mjs";
import {
  MATHLIB_COMMIT,
  MATHLIB_MANIFEST_SHA256,
} from "../shared/library-profiles.mjs";
import { moduleName, DOMAIN_LIMITS } from "./domain-schema.mjs";
import { sha256, digest } from "./evidence.mjs";
import { contentTree } from "./toolchain-tree.mjs";
import { libraryAccess } from "./library-access.mjs";
const exec = promisify(execFile);
const git = async (args, signal, cwd = MATHLIB_ROOT) =>
  (
    await exec("/usr/bin/git", args, {
      cwd,
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    })
  ).stdout;
export async function moduleManifest(names, { signal } = {}) {
  if (
    !Array.isArray(names) ||
    names.length > DOMAIN_LIMITS.modules ||
    new Set(names).size !== names.length
  )
    throw new Error("补充模块清单无效。");
  const modules = [];
  for (const name of names) {
    moduleName(name);
    const file = name.replaceAll(".", "/") + ".lean";
    const source = await git(["show", `${MATHLIB_COMMIT}:${file}`], signal);
    modules.push({ name, file, sourceSha256: sha256(source) });
  }
  return modules;
}
export async function verifyDomainModules(modules, { signal, root } = {}) {
  root ||= await currentDomainRoot();
  if (
    digest(
      await moduleManifest(
        modules.map((m) => m.name),
        { signal },
      ),
    ) !== digest(modules)
  )
    throw new Error("补充模块与固定数学库源码不一致。");
  for (const m of modules)
    await access(
      path.join(
        root,
        ".lake/build/lib/lean",
        m.name.replaceAll(".", "/") + ".olean",
      ),
    );
}
// Rank declaration sites before references, then share the result budget across
// every query. A broad early query must not hide later missing definitions.
export function selectSearchCandidates(groups, limit = 40, offset = 0) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 80)
    throw new Error("检索结果预算须为 1 至 80。");
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw Error("Invalid search offset");
  const score = (candidate, query) => {
    const name = candidate.snippet
      .match(
        /^\s*(?:(?:protected|noncomputable|private|unsafe)\s+)*(?:def|abbrev|theorem|lemma|structure|class)\s+([^\s:({]+)/,
      )?.[1]
      ?.replace(/^_root_\./, "")
      .toLowerCase();
    return name === query.toLowerCase()
      ? 3
      : name?.includes(query.toLowerCase())
        ? 2
        : name
          ? 1
          : 0;
  };
  const queues = groups.map(({ query, candidates }) => {
    // Pagination retains all candidates, including later sites in one file.
    return [...candidates].sort(
      (a, b) =>
        score(b, query) - score(a, query) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line,
    );
  });
  const seen = new Set(),
    selected = [];
  while (selected.length < offset + limit + 1) {
    let added = false;
    for (
      let i = 0;
      i < queues.length && selected.length < offset + limit + 1;
      i++
    ) {
      let candidate;
      while ((candidate = queues[i].shift())) {
        const key = `${candidate.file}:${candidate.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(candidate);
        added = true;
        break;
      }
    }
    if (!added) break;
  }
  const page = selected.slice(offset, offset + limit);
  const pageKeys = new Set(page.map((c) => `${c.file}:${c.line}`));
  return {
    selected: page,
    truncated: selected.length > offset + limit,
    queryCoverage: groups.map(({ query, candidates }) => ({
      query,
      candidates: candidates.length,
      returned: candidates.filter((c) => pageKeys.has(`${c.file}:${c.line}`))
        .length,
    })),
  };
}
export async function searchMathlib(
  queries,
  { signal, limit = 40, offset = 0 } = {},
) {
  if (
    !Array.isArray(queries) ||
    queries.length > 8 ||
    queries.some(
      (q) =>
        typeof q !== "string" ||
        !q.trim() ||
        q.length > 100 ||
        /[\r\n\0]/.test(q),
    )
  )
    throw new Error("检索词最多八个，每个不超过一百字符。");
  const groups = [];
  for (const query of queries) {
    let output = "";
    try {
      output = await git(
        [
          "grep",
          "-n",
          "-i",
          "-F",
          "-e",
          query,
          MATHLIB_COMMIT,
          "--",
          "Mathlib",
        ],
        signal,
      );
    } catch (e) {
      if (e.code !== 1) throw e;
    }
    const candidates = output
      .trim()
      .split("\n")
      .flatMap((line) => {
        const match = line.match(/^[^:]+:(Mathlib\/[^:]+\.lean):(\d+):(.*)$/);
        return match
          ? [{ file: match[1], line: Number(match[2]), snippet: match[3] }]
          : [];
      });
    groups.push({ query, candidates });
  }
  const { selected, truncated, queryCoverage } = selectSearchCandidates(
    groups,
    limit,
    offset,
  );
  const searchRoot = await currentDomainRoot();
  const sources = new Map(),
    matches = [];
  for (const candidate of selected) {
    const { file, line, snippet } = candidate;
    if (!sources.has(file))
      sources.set(
        file,
        await git(["show", `${MATHLIB_COMMIT}:${file}`], signal),
      );
    const source = sources.get(file),
      module = file.slice(0, -5).replaceAll("/", ".");
    let installed = true;
    try {
      await access(
        path.join(
          searchRoot,
          ".lake/build/lib/lean",
          file.slice(0, -5) + ".olean",
        ),
      );
    } catch {
      installed = false;
    }
    matches.push({
      module,
      file,
      line,
      snippet: snippet.slice(0, 1000),
      excerpt: source
        .split("\n")
        .slice(Math.max(0, line - 3), line + 8)
        .join("\n"),
      sourceSha256: sha256(source),
      installed,
      url: `https://github.com/leanprover-community/mathlib4/blob/${MATHLIB_COMMIT}/${file}#L${line}`,
    });
  }
  return {
    schemaVersion: "lemma.library-search.v1",
    status: queries.length ? "searched" : "not_requested",
    revision: MATHLIB_COMMIT,
    queries,
    matches,
    truncated,
    offset,
    nextOffset: truncated ? offset + matches.length : null,
    queryCoverage,
    selection: "declaration_priority_round_robin_per_query",
    scope: "entire_pinned_mathlib_source_literal_search",
    note: queries.length
      ? "文本检索候选，不是定理可用性或语义等价判定；零命中不表示数学库没有相应结果。"
      : "本次没有检索词，直接核对方案中指定的模块；未执行全文检索。",
  };
}

async function cleanSources(signal, root = MATHLIB_ROOT) {
  const manifest = await readFile(path.join(root, "lake-manifest.json"));
  if (sha256(manifest) !== MATHLIB_MANIFEST_SHA256)
    throw new Error("依赖清单被修改。");
  for (const [folder, revision] of [
    [root, MATHLIB_COMMIT],
    ...JSON.parse(manifest).packages.map((p) => {
      if (!MATHLIB_PACKAGES.includes(p.name)) throw new Error("未知依赖包。");
      return [path.join(root, ".lake/packages", p.name), p.rev];
    }),
  ]) {
    if (
      (await git(["rev-parse", "HEAD"], signal, folder)).trim() !== revision ||
      (await git(["status", "--porcelain"], signal, folder)).trim()
    )
      throw new Error("数学库或其依赖源码不再是固定的干净版本，不会自动覆盖。");
  }
}
export function assertCacheExtension(beforeFiles, afterFiles) {
  const byPath = new Map(afterFiles.map((f) => [f.path, f.sha256]));
  if (beforeFiles.some((f) => byPath.get(f.path) !== f.sha256))
    throw new Error(
      "官方缓存获取修改了已有编译文件；保留现场并停止，不自动接受新环境。",
    );
}
const generationRoot = path.join(APP_ROOT, ".tools/mathlib-generations");
const snapshotOptions = {
  snapshotRoot: SNAPSHOT_ROOT,
  roots: LIBRARY_ROOTS,
  commit: MATHLIB_COMMIT,
  manifestSha256: MATHLIB_MANIFEST_SHA256,
};
export async function currentDomainRoot() {
  const generation = await readGeneration(generationRoot);
  return generation
    ? (await readLibrarySnapshot(generation.snapshotId, snapshotOptions))
        .directory
    : MATHLIB_ROOT;
}
export async function ensureDomainModules(modules, options = {}) {
  if (!modules.length) return { status: "ready", acquisition: "none", modules };
  // Reads retain their old snapshot while an independent generation is built.
  const existing = async () => {
    const generation = await readGeneration(generationRoot);
    if (!generation)
      return libraryAccess.read(
        () =>
          ensureDomainModulesReserved(modules, { ...options, acquire: false }),
        options,
      );
    const snapshot = await readLibrarySnapshot(generation.snapshotId, {
      ...snapshotOptions,
      signal: options.signal,
    });
    try {
      await verifyDomainModules(modules, {
        ...options,
        root: snapshot.directory,
      });
    } catch (error) {
      if (error.code === "ENOENT")
        throw Object.assign(
          Error("Requested modules absent from this generation"),
          { code: "domain_modules_missing" },
        );
      throw error;
    }
    return {
      status: "ready",
      acquisition: "existing_pinned_generation",
      modules,
      before: snapshot.descriptor.content,
      after: snapshot.descriptor.content,
      generationId: generation.snapshotId,
    };
  };
  try {
    return await existing();
  } catch (e) {
    if (e.code !== "domain_modules_missing" || options.acquire === false)
      throw e;
  }
  return generationBuild(
    generationRoot,
    async () => {
      try {
        return await existing();
      } catch (e) {
        if (e.code !== "domain_modules_missing") throw e;
      }
      const previous = await readGeneration(generationRoot);
      const stage = path.join(generationRoot, `staging-${randomUUID()}`),
        root = path.join(stage, "mathlib4-4.35.0");
      await mkdir(stage, { recursive: true });
      const outerOptions = options;
      try {
        const { result, snapshot } = await guardedGeneration(
          generationRoot,
          stage,
          async (signal) => {
            const options = { ...outerOptions, signal };
            await nativeSpan("environment.generation_clone", () =>
              libraryAccess.read(async () => {
                await cleanSources(options.signal);
                await cp(MATHLIB_ROOT, root, {
                  recursive: true,
                  mode: constants.COPYFILE_FICLONE,
                  verbatimSymlinks: true,
                });
                let metadata = JSON.parse(
                  await readFile(
                    path.join(APP_ROOT, ".tools/mathlib-library.json"),
                    "utf8",
                  ),
                );
                if (previous) {
                  const snapshot = await readLibrarySnapshot(
                    previous.snapshotId,
                    {
                      ...snapshotOptions,
                      signal: options.signal,
                    },
                  );
                  for (const rel of LIBRARY_ROOTS) {
                    await rm(path.join(root, rel), {
                      recursive: true,
                      force: true,
                    });
                    await cp(
                      path.join(snapshot.directory, rel),
                      path.join(root, rel),
                      { recursive: true, mode: constants.COPYFILE_FICLONE },
                    );
                  }
                  metadata = {
                    ...metadata,
                    content: snapshot.descriptor.content,
                  };
                }
                // Only a private staging tree is writable by the official cache command.
                async function writable(dir) {
                  for (const e of await readdir(dir, { withFileTypes: true })) {
                    const f = path.join(dir, e.name);
                    if (e.isDirectory()) await writable(f);
                    else if (e.isFile()) await chmod(f, 0o644);
                    else throw Error("Non-regular compiled generation entry");
                  }
                }
                for (const rel of LIBRARY_ROOTS)
                  await writable(path.join(root, rel));
                await writeFile(
                  path.join(stage, "mathlib-library.json"),
                  JSON.stringify(metadata),
                );
              }, options),
            );
            const result = await ensureDomainModulesReserved(modules, {
              ...options,
              stagingRoot: root,
            });
            const identity = await analysisLibraryStatus({
              verify: true,
              root,
            });
            if (!identity.ready) throw Error(identity.reason);
            const snapshot = await sealLibrarySnapshot({
              ...snapshotOptions,
              sourceRoot: root,
              identity,
              signal: options.signal,
            });
            return { result, snapshot };
          },
          options,
        );
        await libraryAccess.write(
          () =>
            publishGeneration(
              generationRoot,
              {
                snapshotId: snapshot.descriptor.id,
                parentSnapshotId: previous?.snapshotId || null,
                modules,
                acquisition: result,
              },
              options,
            ),
          options,
        );
        await writeFile(
          path.join(stage, "published.json"),
          JSON.stringify({
            snapshotId: snapshot.descriptor.id,
            sourceRoot: root,
          }),
        );
        // Keep audit files; the validated snapshot owns the compiled bytes. Never GC snapshots used by archives.
        await rm(root, { recursive: true, force: true });
        return {
          ...result,
          acquisition: "isolated_pinned_generation",
          generationId: snapshot.descriptor.id,
        };
      } catch (e) {
        await writeFile(
          path.join(stage, "failure.json"),
          JSON.stringify({
            error: e.message,
            code: e.code || null,
            at: new Date().toISOString(),
          }),
        ).catch(() => {});
        throw e;
      }
    },
    options,
  );
}
async function ensureDomainModulesReserved(
  modules,
  { signal, acquire = true, stagingRoot = null } = {},
) {
  const root = stagingRoot || MATHLIB_ROOT;
  const metadata = path.join(root, "../mathlib-library.json");
  if (
    digest(
      await moduleManifest(
        modules.map((m) => m.name),
        { signal },
      ),
    ) !== digest(modules)
  )
    throw new Error("模块来源摘要不符。");
  if (!modules.length) return { status: "ready", acquisition: "none", modules };
  const before = await analysisLibraryStatus({ verify: true, root });
  if (!before.ready) throw new Error(before.reason);
  const missing = [];
  for (const m of modules)
    try {
      await access(
        path.join(
          root,
          ".lake/build/lib/lean",
          m.name.replaceAll(".", "/") + ".olean",
        ),
      );
    } catch {
      missing.push(m.name);
    }
  if (!missing.length)
    return {
      status: "ready",
      acquisition: "existing_pinned_cache",
      modules,
      before: before.content,
      after: before.content,
    };
  if (!acquire)
    throw Object.assign(new Error(`模块尚未安装：${missing.join(", ")}`), {
      code: "domain_modules_missing",
    });
  const lock = path.join(root, "../domain-cache.lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error(
      "数学库缓存补全被其他进程占用，或上次补全中断；请先核对缓存状态。",
    );
  }
  let release = false,
    acquisitionStarted = false;
  try {
    await cleanSources(signal, root);
    const original = await readFile(metadata, "utf8");
    const tree = await contentTree(root, LIBRARY_ROOTS, {
      includeFiles: true,
    });
    if (tree.sha256 !== before.content.sha256)
      throw new Error("缓存在准备期间发生变化。");
    await writeFile(
      path.join(lock, "before.json"),
      JSON.stringify({
        metadata: JSON.parse(original),
        files: tree.files,
        missing,
      }),
      { mode: 0o600 },
    );
    const { runBounded, binary, leanStatus } = await import("./lean.mjs");
    if (!(await leanStatus({ verifyLibraries: true })).ready)
      throw new Error("Lean 工具链身份检查失败。");
    const client = path.join(lock, "curl-client");
    await mkdir(client);
    await writeFile(
      path.join(client, ".curlrc"),
      'connect-timeout = 30\nmax-time = 300\nparallel-max = 8\nproto = "=https"\n',
      { mode: 0o600 },
    );
    acquisitionStarted = true;
    const transfers = [];
    for (const backend of ["official_cdn", "official_azure_fallback"]) {
      if (signal?.aborted) break;
      const result = await runBounded(
        path.join(path.dirname(binary), "lake"),
        ["exe", "cache", "get", ...missing],
        {
          cwd: root,
          signal,
          timeoutMs: backend === "official_cdn" ? 900000 : 1800000,
          maxOutput: 524288,
          env: {
            PATH: `${path.dirname(binary)}:/usr/bin:/bin:/usr/sbin:/sbin`,
            HOME: process.env.HOME,
            LANG: "C.UTF-8",
            LEAN_PATH: "",
            CURL_HOME: client,
            MATHLIB_CACHE_DIR: path.join(APP_ROOT, ".tools/mathlib-cache"),
            ...(backend === "official_azure_fallback"
              ? { MATHLIB_CACHE_DEBUG_USE_LEGACY: "1" }
              : {}),
          },
        },
      );
      transfers.push({ backend, ...result });
      if (result.exitCode === 0 && !result.termination) break;
    }
    const command = {
      ...(transfers.at(-1) || {
        exitCode: null,
        termination: "cancelled",
        stdout: "",
        stderr: "",
      }),
      transfers,
    };
    await writeFile(path.join(lock, "command.json"), JSON.stringify(command), {
      mode: 0o600,
    });
    await cleanSources(undefined, root);
    const afterTree = await contentTree(root, LIBRARY_ROOTS, {
      includeFiles: true,
    });
    assertCacheExtension(tree.files, afterTree.files);
    const { files, ...content } = afterTree;
    const acquisition = {
      status:
        command.exitCode === 0 && !command.termination ? "ready" : "incomplete",
      acquisition: "pinned_official_cache_append",
      modules,
      requested: missing,
      before: before.content,
      after: content,
      command,
    };
    const saved = {
      ...JSON.parse(original),
      content,
      lastExpansion: {
        id: randomUUID(),
        requested: missing,
        before: before.content,
        recordedAt: new Date().toISOString(),
      },
    };
    const tmp = `${metadata}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(saved, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(tmp, metadata);
    // Even a partial official download can only extend the cache. Retain its audit
    // record and permit a bounded retry; never claim requested modules are ready.
    const audit = path.join(root, "../domain-cache-history");
    await mkdir(audit, { recursive: true });
    await rename(lock, path.join(audit, saved.lastExpansion.id));
    release = true;
    if (acquisition.status !== "ready") {
      const error = new Error(
        `固定版本缓存获取未完成：${command.termination || command.exitCode}。可在新任务中继续补全。`,
      );
      error.domainRecord = acquisition;
      throw error;
    }
    await verifyDomainModules(modules, { signal, root });
    return acquisition;
  } catch (e) {
    if (!release && !acquisitionStarted) {
      await rm(lock, { recursive: true, force: true });
      release = true;
    }
    if (!release)
      e.message += " 缓存审计记录保留在 .tools/domain-cache.lock；未重置文件。";
    throw e;
  }
}
