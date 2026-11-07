import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { APP_ROOT, MATHLIB_ROOT } from "./libraries.mjs";
import { MATHLIB_COMMIT } from "../shared/library-profiles.mjs";
import { digest, sha256 } from "./evidence.mjs";
import {
  compilerDeclarations,
  sourceDeclarations,
} from "./declaration-names.mjs";

const exec = promisify(execFile),
  builds = new Map();
const schema = "lemma.premise-index.v2";
const PARSER_SHA256 = digest(
  await Promise.all(
    [
      import.meta.url,
      new URL("./declaration-names.mjs", import.meta.url).href,
    ].map(async (url) => ({
      file: path.basename(fileURLToPath(url)),
      sha256: sha256(await readFile(fileURLToPath(url))),
    })),
  ),
);
const ignored = new Set([
  "a",
  "an",
  "the",
  "of",
  "on",
  "in",
  "at",
  "to",
  "and",
  "or",
  "by",
  "fun",
  "function",
  "is",
  "has",
  "exists",
  "forall",
  "iff",
  "with",
  "lemma",
  "theorem",
  "def",
]);
const aliases = {
  subsequence: "subseq",
  subsequences: "subseq",
  sequence: "seq",
  sequences: "seq",
  sequential: "seq",
  compactness: "compact",
  monotone: "mono",
  monotonicity: "mono",
  continuity: "continuous",
  continuously: "continuous",
  absolutely: "absolute",
  uniformly: "uniform",
};
export function premiseTerms(value) {
  return [
    ...new Set(
      String(value)
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .match(/[a-z][a-z0-9]*/g)
        ?.map((s) => aliases[s] || s)
        .filter((s) => s.length > 1 && !ignored.has(s)) || [],
    ),
  ];
}
export function rankPremiseDeclarations(
  entries,
  queries,
  target = "",
  limit = 40,
) {
  const goalTerms = premiseTerms(target),
    byName = new Map(
      entries.map((entry) => [
        entry,
        premiseTerms(entry.name.split(".").at(-1)),
      ]),
    );
  const groups = queries.map((query) => {
    // Qualified names must match the declaration's specific term. A namespace
    // token alone (e.g. Complex in Complex.dilog) is not a useful candidate.
    const qualified =
      /^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)+$/.test(query);
    const terms = premiseTerms(qualified ? query.split(".").at(-1) : query);
    if (!terms.length) return [];
    return entries
      .flatMap((entry) => {
        const names = byName.get(entry),
          matchedTerms = terms.filter((t) => names.includes(t));
        const exact = entry.name === query;
        if (
          !exact &&
          (matchedTerms.length === 0 ||
            matchedTerms.length / terms.length < 0.5)
        )
          return [];
        const headerTerms = premiseTerms(entry.snippet);
        const typeOverlap = goalTerms.filter((t) =>
          headerTerms.includes(t),
        ).length;
        const score =
          (exact ? 1000 : 0) +
          (qualified &&
          entry.name.split(".").slice(0, -1).join(".") ===
            query.split(".").slice(0, -1).join(".")
            ? 150
            : 0) +
          (50 * matchedTerms.length) / terms.length +
          (25 * matchedTerms.length) / Math.max(1, names.length) +
          Math.min(15, typeOverlap * 3);
        return [
          {
            ...entry,
            score: Number(score.toFixed(3)),
            matchedTerms,
            matchKind: exact ? "exact_full_name" : "related_name_tokens",
            matchedQuery: query,
          },
        ];
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.name.length - b.name.length ||
          a.file.localeCompare(b.file) ||
          a.line - b.line,
      );
  });
  const selected = [],
    seen = new Set();
  while (selected.length < limit) {
    let added = false;
    for (const group of groups) {
      let entry;
      while ((entry = group.shift())) {
        const key = entry.file + ":" + entry.line + ":" + entry.name;
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(entry);
        added = true;
        break;
      }
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
}
async function index({ signal } = {}) {
  const parserHash = PARSER_SHA256;
  let compiledTreeHash = null;
  try {
    compiledTreeHash =
      JSON.parse(
        await readFile(
          path.join(APP_ROOT, ".tools/mathlib-library.json"),
          "utf8",
        ),
      ).content?.sha256 || null;
  } catch {}
  const identity = {
      schema,
      revision: MATHLIB_COMMIT,
      parserHash,
      compiledTreeHash,
    },
    key = digest(identity);
  if (!builds.has(key))
    builds.set(
      key,
      (async () => {
        const folder = path.join(APP_ROOT, ".runtime/premise-index"),
          file = path.join(folder, key + ".json");
        try {
          const cached = JSON.parse(await readFile(file, "utf8"));
          if (
            digest(cached.identity) === digest(identity) &&
            cached.entriesHash === digest(cached.entries)
          )
            return cached;
        } catch {}
        const { stdout } = await exec(
          "/usr/bin/git",
          [
            "ls-tree",
            "-r",
            "-z",
            "--format=%(objectname)%x09%(path)",
            MATHLIB_COMMIT,
            "--",
            "Mathlib",
          ],
          {
            cwd: MATHLIB_ROOT,
            signal,
            timeout: 120000,
            maxBuffer: 8 * 1024 * 1024,
          },
        );
        const files = stdout
          .split("\0")
          .filter((line) => line.endsWith(".lean"))
          .map((line) => {
            const [hash, file] = line.split("\t");
            if (
              !/^[a-f0-9]{40}$/.test(hash) ||
              !/^Mathlib\/[^\0]+\.lean$/.test(file) ||
              file.split("/").includes("..")
            )
              throw Error("Invalid pinned source tree entry");
            return { hash, file };
          });
        const entries = [],
          coverage = {
            sourceFiles: files.length,
            compilerFiles: 0,
            sourceFallbackFiles: 0,
            rejectedMetadata: [],
          };
        for (let offset = 0; offset < files.length; offset += 128) {
          signal?.throwIfAborted();
          const batch = files.slice(offset, offset + 128);
          const pending = exec("/usr/bin/git", ["cat-file", "--batch"], {
            cwd: MATHLIB_ROOT,
            signal,
            encoding: "buffer",
            timeout: 120000,
            maxBuffer: 32 * 1024 * 1024,
          });
          pending.child.stdin.end(batch.map((f) => f.hash).join("\n") + "\n");
          const { stdout: objects } = await pending;
          let cursor = 0;
          for (const item of batch) {
            const end = objects.indexOf(10, cursor),
              header = objects.subarray(cursor, end).toString("ascii");
            const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
            if (!match || match[1] !== item.hash)
              throw Error("Pinned source batch identity mismatch");
            const size = Number(match[2]),
              start = end + 1;
            cursor = start + size + 1;
            if (
              size > 8 * 1024 * 1024 ||
              cursor > objects.length ||
              objects[cursor - 1] !== 10
            )
              throw Error("Pinned source object size mismatch");
            const source = new TextDecoder("utf-8", { fatal: true }).decode(
              objects.subarray(start, start + size),
            );
            let declarations;
            try {
              const metadata = await readFile(
                path.join(
                  MATHLIB_ROOT,
                  ".lake/build/lib/lean",
                  item.file.slice(0, -5) + ".ilean",
                ),
                "utf8",
              );
              declarations = compilerDeclarations(
                JSON.parse(metadata),
                source,
                item.file,
              );
              coverage.compilerFiles++;
            } catch (error) {
              if (error.code !== "ENOENT")
                coverage.rejectedMetadata.push({
                  file: item.file,
                  reason: error.message.slice(0, 200),
                });
              declarations = sourceDeclarations(source, item.file);
              coverage.sourceFallbackFiles++;
            }
            const sourceSha256 = sha256(source);
            entries.push(...declarations.map((d) => ({ ...d, sourceSha256 })));
          }
          if (cursor !== objects.length)
            throw Error("Trailing pinned source batch data");
        }
        const data = {
          identity,
          entries,
          coverage,
          entriesHash: digest(entries),
        };
        await mkdir(folder, { recursive: true });
        const temp = file + "." + randomUUID() + ".tmp";
        await writeFile(temp, JSON.stringify(data));
        await rename(temp, file);
        return data;
      })().catch((error) => {
        builds.delete(key);
        throw error;
      }),
    );
  return builds.get(key);
}
export async function searchPremises(
  queries,
  { signal, limit = 40, target = "", offset = 0, module = "" } = {},
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
    ) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 80
  )
    throw Error("Invalid premise search budget or queries");
  if (!Number.isSafeInteger(offset) || offset < 0 || typeof module !== "string")
    throw Error("Invalid premise search page or module");
  if (!queries.length)
    return {
      status: "not_requested",
      queries: [],
      matches: [],
      revision: MATHLIB_COMMIT,
    };
  const data = await index({ signal });
  signal?.throwIfAborted();
  const candidates = rankPremiseDeclarations(
    data.entries.filter(
      (e) =>
        !module || e.module === module || e.module.startsWith(module + "."),
    ),
    queries,
    target,
    offset + limit + 1,
  );
  const ranked = candidates.slice(offset, offset + limit),
    sources = new Map(),
    matches = [];
  for (const entry of ranked) {
    if (!sources.has(entry.file))
      sources.set(
        entry.file,
        (
          await exec(
            "/usr/bin/git",
            ["show", `${MATHLIB_COMMIT}:${entry.file}`],
            {
              cwd: MATHLIB_ROOT,
              signal,
              timeout: 60000,
              maxBuffer: 8 * 1024 * 1024,
            },
          )
        ).stdout,
      );
    const source = sources.get(entry.file),
      lines = source.split("\n");
    if (
      sha256(source) !== entry.sourceSha256 ||
      lines[entry.line - 1] !== entry.snippet
    )
      throw Error("Premise index does not match pinned source");
    let installed = true;
    try {
      await access(
        path.join(
          MATHLIB_ROOT,
          ".lake/build/lib/lean",
          entry.file.slice(0, -5) + ".olean",
        ),
      );
    } catch {
      installed = false;
    }
    matches.push({
      ...entry,
      excerpt: lines
        .slice(Math.max(0, entry.line - 3), entry.line + 12)
        .join("\n"),
      sourceSha256: sha256(source),
      availableInCurrentEnvironment: "not_established",
      installed,
      url: `https://github.com/leanprover-community/mathlib4/blob/${MATHLIB_COMMIT}/${entry.file}#L${entry.line}`,
    });
  }
  return {
    schemaVersion: schema,
    status: "searched",
    revision: MATHLIB_COMMIT,
    indexHash: data.entriesHash,
    queries,
    matches,
    offset,
    nextOffset:
      candidates.length > offset + limit ? offset + matches.length : null,
    coverage: data.coverage,
    resolutions: queries.map((query) => ({
      query,
      exact: matches
        .filter((m) => m.name === query)
        .map((m) => ({
          name: m.name,
          module: m.module,
          sourceSha256: m.sourceSha256,
        })),
      status: matches.some((m) => m.name === query)
        ? "exact_source_candidate"
        : matches.some((m) => m.matchedQuery === query)
          ? "related_candidates_only"
          : "not_returned_in_budget",
      nativeVerificationRequired: true,
    })),
    scope:
      "pinned_qualified_declaration_candidates_native_import_check_required",
    note: "源码候选必须在具体导入环境核对类型与前提；排名不证明适用性。",
  };
}

export async function resolveDeclarationModules(names, { signal } = {}) {
  if (
    !Array.isArray(names) ||
    names.length > 256 ||
    names.some(
      (n) => typeof n !== "string" || n.length > 180 || /[\r\n\0]/.test(n),
    )
  )
    throw Error("Invalid declaration names");
  if (!names.length) return [];
  const data = await index({ signal });
  const wanted = new Set(names),
    found = new Map(names.map((n) => [n, []]));
  for (const entry of data.entries)
    if (wanted.has(entry.name)) found.get(entry.name).push(entry);
  return names.map((name) => {
    const entries = found.get(name),
      modules = [...new Set(entries.map((e) => e.module))];
    return {
      name,
      status:
        modules.length === 1
          ? "resolved_candidate"
          : modules.length > 1
            ? "ambiguous_candidates"
            : "not_found_in_index",
      modules,
      entries,
    };
  });
}
