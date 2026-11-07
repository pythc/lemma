import {
  mkdir,
  readFile,
  writeFile,
  realpath,
  access,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { APP_ROOT, MATHLIB_ROOT, libraryEnvironment } from "./libraries.mjs";
import { MATHLIB_COMMIT } from "../shared/library-profiles.mjs";
import { digest, sha256 } from "./evidence.mjs";
import { contentTree } from "./toolchain-tree.mjs";
import { ResourcePool } from "./resource-pool.mjs";
import { randomUUID } from "node:crypto";

export const EXTERNAL_ROOT = path.join(APP_ROOT, ".tools/external-libraries");
export const LIBRARY_CATALOG = Object.freeze([
  {
    repo: "leanprover-community/physlib",
    branch: "master",
    scope:
      "Mathematical physics, calculus, integration, linear algebra, quantum information",
  },
  {
    repo: "fpvandoorn/carleson",
    branch: "master",
    scope: "Harmonic analysis, Fourier convergence, metric measure spaces",
  },
  {
    repo: "RemyDegenne/brownian-motion",
    branch: "master",
    scope: "Probability, Gaussian processes, Brownian motion",
  },
  {
    repo: "teorth/pfr",
    branch: "master",
    scope: "Additive combinatorics, Shannon entropy, Ruzsa inequalities",
  },
  {
    repo: "YaelDillies/apap",
    branch: "master",
    scope: "Discrete convolution, Fourier, almost periodicity",
  },
  {
    repo: "AlexKontorovich/PrimeNumberTheoremAnd",
    branch: "main",
    scope: "Analytic number theory, prime number theorem",
  },
  {
    repo: "leanprover/cslib",
    branch: "main",
    scope: "Theoretical computer science",
  },
]);
const installs = new ResourcePool(1);
const repoName = (x) => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x))
    throw Error("Invalid GitHub repository");
  return x;
};
export const moduleName = (x) => {
  if (!/^[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/.test(x))
    throw Error("Invalid Lean module");
  return x;
};
async function get(url, signal, max = 32 * 1024 * 1024) {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    ![
      "raw.githubusercontent.com",
      "codeload.github.com",
      "api.github.com",
    ].includes(u.hostname)
  )
    throw Error("Untrusted library endpoint");
  const r = await fetch(u, {
    signal: AbortSignal.any([
      signal || new AbortController().signal,
      AbortSignal.timeout(120000),
    ]),
    redirect: "error",
    headers: { "User-Agent": "Lemma-library-discovery" },
  });
  if (!r.ok) throw Error(`Library fetch HTTP ${r.status}`);
  const chunks = [];
  let size = 0;
  for await (const b of r.body) {
    size += b.length;
    if (size > max) throw Error("Library download limit");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
export async function readExternalLibrarySource(info, module, { signal } = {}) {
  repoName(info.repo);
  moduleName(module);
  if (!/^[a-f0-9]{40}$/.test(info.revision))
    throw Error("Immutable source revision required");
  const bytes = await get(
    `https://raw.githubusercontent.com/${info.repo}/${info.revision}/${module.replaceAll(".", "/")}.lean`,
    signal,
    1000000,
  );
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes))
    throw Error("Library source must be valid UTF-8");
  return {
    repo: info.repo,
    revision: info.revision,
    module,
    text,
    sourceBytesSha256: sha256(bytes),
  };
}
export async function discoverLibraries(query, { signal } = {}) {
  const words = String(query)
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  const catalog = LIBRARY_CATALOG.map((c) => ({
    ...c,
    score: words.filter((w) =>
      (c.scope + " " + c.repo).toLowerCase().includes(w),
    ).length,
  })).sort((a, b) => b.score - a.score);
  let remote = [],
    remoteError = null;
  try {
    const d = JSON.parse(
      await get(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(String(query).slice(0, 180) + " language:Lean")}&per_page=8`,
        signal,
        1000000,
      ),
    );
    remote = (d.items || []).map((x) => ({
      repo: x.full_name,
      branch: x.default_branch,
      scope: x.description || "",
      url: x.html_url,
    }));
  } catch (e) {
    if (signal?.aborted) throw e;
    remoteError = e.message;
  }
  return {
    catalog,
    remote,
    remoteError,
    scope: "candidate_discovery_not_library_acceptance",
  };
}
export async function inspectLibrary(repo, { signal, revision } = {}) {
  repoName(repo);
  const { runBounded } = await import("./lean.mjs");
  if (!revision) {
    const r = await runBounded(
      "/usr/bin/git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "ls-remote",
        `https://github.com/${repo}.git`,
        "HEAD",
      ],
      {
        signal,
        timeoutMs: 120000,
        env: {
          PATH: "/usr/bin:/bin",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          HOME: "/var/empty",
        },
      },
    );
    revision = r.stdout.match(/^([a-f0-9]{40})\s/)?.[1];
    if (!revision) throw Error("Cannot resolve immutable repository commit");
  }
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw Error("Immutable commit required");
  const raw = (f) =>
    `https://raw.githubusercontent.com/${repo}/${revision}/${f}`;
  const toolchain = (await get(raw("lean-toolchain"), signal, 4096))
    .toString()
    .trim();
  const manifestBytes = await get(raw("lake-manifest.json"), signal, 1000000);
  const manifest = JSON.parse(manifestBytes);
  const mathlib = manifest.packages?.find((p) => p.name === "mathlib");
  const readme = await get(raw("README.md"), signal, 300000).catch(() =>
    Buffer.alloc(0),
  );
  const index = await get(raw("Physlib.lean"), signal, 300000).catch(() =>
    Buffer.alloc(0),
  );
  const compatible =
    toolchain === "leanprover/lean4:v4.35.0" && mathlib?.rev === MATHLIB_COMMIT;
  return {
    repo,
    revision,
    toolchain,
    mathlibRevision: mathlib?.rev || null,
    manifestSha256: sha256(manifestBytes),
    compatible,
    reason: compatible
      ? null
      : "Lean or mathlib revision differs; no implicit toolchain replacement",
    readme: readme.toString(),
    moduleIndex: index.toString(),
    scope: "metadata_only_not_compiled",
  };
}

export async function libraryVersions(repo, { signal, match = "4.35" } = {}) {
  repoName(repo);
  const { runBounded } = await import("./lean.mjs");
  const r = await runBounded(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "ls-remote",
      "--tags",
      `https://github.com/${repo}.git`,
    ],
    {
      signal,
      timeoutMs: 120000,
      maxOutput: 2000000,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/var/empty",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (r.exitCode !== 0 || r.termination)
    throw Error("Cannot list repository versions");
  return {
    repo,
    versions: r.stdout
      .split("\n")
      .map((line) => line.match(/^([a-f0-9]{40})\s+refs\/tags\/(.+)$/))
      .filter(Boolean)
      .map((x) => ({ revision: x[1], tag: x[2] }))
      .filter((x) => !match || x.tag.includes(match))
      .slice(-100),
    scope: "tag_discovery_only_each_commit_requires_compatibility_inspection",
  };
}
export function safeArchiveEntries(bytes) {
  let total = 0,
    count = 0;
  const files = unzipSync(bytes, {
    filter: (f) => {
      if (
        ++count > 30000 ||
        (total += f.originalSize) > 256 * 1024 * 1024 ||
        f.originalSize > 16 * 1024 * 1024
      )
        throw Error("Archive expansion limit");
      return !f.name.endsWith("/");
    },
  });
  const out = [];
  for (const [name, data] of Object.entries(files)) {
    if (
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").some((x) => x === "..")
    )
      throw Error("Unsafe archive path");
    const rel = name.split("/").slice(1).join("/");
    if (
      !rel ||
      !(
        /\.lean$/.test(rel) ||
        [
          "lean-toolchain",
          "lake-manifest.json",
          "LICENSE",
          "README.md",
        ].includes(rel)
      )
    )
      continue;
    out.push([rel, data]);
  }
  return out;
}
export async function installLibrary(info, modules, { signal } = {}) {
  return installs.run(
    async () => {
      if (!info.compatible || !modules.length || modules.length > 24)
        throw Error("Incompatible library or invalid module selection");
      modules = [...new Set(modules.map(moduleName))].sort();
      // Re-fetch by immutable revision: callers cannot forge the compatibility decision.
      const checked = await inspectLibrary(info.repo, {
        revision: info.revision,
        signal,
      });
      if (!checked.compatible || checked.manifestSha256 !== info.manifestSha256)
        throw Error("Library identity changed");
      const id = digest({ repo: info.repo, revision: info.revision, modules });
      const dir = path.join(EXTERNAL_ROOT, id);
      try {
        return await verifyExternalLibrary(id);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const stage = path.join(EXTERNAL_ROOT, `${id}.${randomUUID()}.partial`);
      await mkdir(stage, { recursive: true, mode: 0o700 });
      const source = path.join(stage, "src"),
        build = path.join(stage, "build");
      await mkdir(source, { recursive: true });
      await mkdir(build, { recursive: true });
      const zip = await get(
        `https://codeload.github.com/${repoName(info.repo)}/zip/${info.revision}`,
        signal,
      );
      for (const [rel, data] of safeArchiveEntries(zip)) {
        const dest = path.join(source, rel);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, data, { mode: 0o600 });
      }
      const visited = new Set(),
        visiting = new Set(),
        ordered = [],
        mathlib = new Set();
      async function visit(m) {
        if (visited.has(m)) return;
        if (visiting.has(m)) throw Error("Cyclic external imports");
        visiting.add(m);
        let text;
        try {
          text = await readFile(
            path.join(source, m.replaceAll(".", "/") + ".lean"),
            "utf8",
          );
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
          if (m.startsWith("Mathlib.")) mathlib.add(m);
          else if (!/^(Lean|Std|Batteries|Aesop|Qq|Plausible)(\.|$)/.test(m))
            throw Error(`Unsupported external dependency: ${m}`);
          visiting.delete(m);
          visited.add(m);
          return;
        }
        for (const line of text.split("\n")) {
          const v = line.match(
            /^\s*(?:(?:public|private|meta)\s+)*import\s+([A-Za-z0-9_.\s]+?)(?:\s*--.*)?$/,
          );
          if (v)
            for (const n of v[1]
              .trim()
              .split(/\s+/)
              .filter((n) => n !== "all"))
              await visit(moduleName(n));
        }
        visiting.delete(m);
        visited.add(m);
        ordered.push(m);
      }
      for (const m of modules) await visit(m);
      if (!ordered.length) throw Error("No external source modules selected");
      const { ensureDomainModules, moduleManifest } =
        await import("./domain-library.mjs");
      if (mathlib.size)
        await ensureDomainModules(
          await moduleManifest([...mathlib], { signal }),
          { signal },
        );
      const base = await libraryEnvironment("analysis-continuity-v1");
      if (!base.ready) throw Error(base.reason);
      const { binary, runBounded, sandboxProfile } = await import("./lean.mjs");
      const canonical = await realpath(stage),
        checks = [];
      for (const m of ordered) {
        signal?.throwIfAborted();
        const rel = m.replaceAll(".", "/");
        await mkdir(path.dirname(path.join(build, rel)), { recursive: true });
        const r = await runBounded(
          "/usr/bin/sandbox-exec",
          [
            "-p",
            sandboxProfile(canonical, base.searchPaths),
            binary,
            "-M",
            "4096",
            "-R",
            source,
            "-o",
            path.join(build, rel + ".olean"),
            path.join(source, rel + ".lean"),
          ],
          {
            cwd: source,
            env: {
              PATH: path.dirname(binary),
              HOME: canonical,
              TMPDIR: canonical,
              LANG: "C.UTF-8",
              LEAN_PATH: [build, ...base.searchPaths].join(path.delimiter),
            },
            signal,
            timeoutMs: 1200000,
          },
        );
        checks.push({ module: m, ...r });
        if (r.exitCode !== 0 || r.termination) {
          await writeFile(
            path.join(stage, "failure.json"),
            JSON.stringify({ info: checked, checks }),
          );
          throw Error(
            `External build failed: ${m}: ${(r.stdout + r.stderr).slice(-3000)}`,
          );
        }
      }
      const tree = await contentTree(stage, ["src", "build"]);
      const compiledSources = await Promise.all(
        ordered.map(async (module) => {
          const sourceText = await readFile(
            path.join(source, module.replaceAll(".", "/") + ".lean"),
            "utf8",
          );
          return { module, source: sourceText, sha256: sha256(sourceText) };
        }),
      );
      const receipt = {
        schemaVersion: "lemma.external-library.v1",
        id,
        repo: info.repo,
        revision: info.revision,
        modules,
        toolchain: checked.toolchain,
        mathlibRevision: checked.mathlibRevision,
        sourceArchiveSha256: sha256(zip),
        sourceManifestSha256: checked.manifestSha256,
        tree,
        compiledSources,
        checks,
        status: "compiled_not_all_theorems_audited",
      };
      await writeFile(
        path.join(stage, "receipt.json"),
        JSON.stringify(receipt),
        { mode: 0o600 },
      );
      const { rename } = await import("node:fs/promises");
      await rename(stage, dir);
      return receipt;
    },
    { signal },
  );
}
export async function verifyExternalLibrary(id) {
  if (!/^[a-f0-9]{64}$/.test(id))
    throw Error("Invalid external environment identity");
  const dir = path.join(EXTERNAL_ROOT, id);
  if ((await realpath(dir)) !== dir)
    throw Error("External library path was redirected");
  const r = JSON.parse(await readFile(path.join(dir, "receipt.json"), "utf8"));
  if (
    r.id !== id ||
    digest({ repo: r.repo, revision: r.revision, modules: r.modules }) !== id ||
    r.toolchain !== "leanprover/lean4:v4.35.0" ||
    r.mathlibRevision !== MATHLIB_COMMIT ||
    (await contentTree(dir, ["src", "build"])).sha256 !== r.tree.sha256
  )
    throw Error("External library contents changed");
  return r;
}
