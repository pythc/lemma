import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded } from "./lean.mjs";
import { sha256 } from "./evidence.mjs";

export const ROCQ_PIN = Object.freeze({
  version: "9.3.0",
  platform: "homebrew-rocq-9.3.0",
  bottleSha256: "034125ee4c09f42e6a3a25b04fd86b5f26898be6cc36523d6203590f90428708",
});

const root = fileURLToPath(new URL("../", import.meta.url));
const platformRoot = path.join(root, ".tools", "rocq-platform");
const NAME = /^\s*(?:Theorem|Lemma|Example|Corollary|Proposition|Fact)\s+([A-Za-z_][A-Za-z0-9_']*)/gm;

let runtimePromise;

export function theoremNames(source) {
  return [...String(source || "").matchAll(NAME)].map((match) => match[1]);
}

export function parseAssumptions(stdout, theoremName) {
  const text = String(stdout || "");
  const axiomBlock = text.split(/\bAxioms:\s*/)[1] || "";
  const names = [];
  for (const line of axiomBlock.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_']*)\b/);
    if (!match) break;
    names.push(match[1]);
  }
  if (new RegExp(`\\b${theoremName}\\b[\\s\\S]{0,80}is assumed`).test(text))
    names.push(theoremName);
  const unique = [...new Set(names)];
  const admits = unique.filter((name) => name === theoremName);
  const extraAxioms = unique.filter((name) => name !== theoremName);
  return {
    closed:
      /closed under the global context/i.test(text) &&
      admits.length === 0 &&
      extraAxioms.length === 0,
    admits,
    extraAxioms,
  };
}

async function loadRuntime() {
  const manifestPath = path.join(platformRoot, "manifest.json");
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    manifest = null;
  }
  const candidates = [
    manifest?.coqc,
    "/opt/homebrew/bin/coqc",
    "/usr/local/bin/coqc",
  ].filter(Boolean);
  let coqc = "";
  let banner = "";
  for (const candidate of candidates) {
    const version = await runBounded(candidate, ["--version"], {
      timeoutMs: 20000,
    }).catch(() => null);
    const text = `${version?.stdout || ""}\n${version?.stderr || ""}`;
    if (text.includes(ROCQ_PIN.version)) {
      coqc = candidate;
      banner = text;
      break;
    }
  }
  if (!coqc)
    return { ready: false, reason: `固定的 Rocq ${ROCQ_PIN.version} 尚未安装。` };
  const binary = await realpath(coqc);
  const bin = path.dirname(binary);
  const coqtopCandidate = manifest?.coqtop || path.join(bin, "coqtop");
  const top = await realpath(coqtopCandidate).catch(() => "");
  const repl = await realpath(path.join(bin, "rocq")).catch(() => "");
  return {
    ready: Boolean(top || repl),
    version: ROCQ_PIN.version,
    platform: ROCQ_PIN.platform,
    coqc: binary,
    coqtop: top,
    rocq: repl,
    prefix: path.dirname(bin),
    coqcSha256: sha256(await readFile(binary)),
    banner: banner.slice(0, 300),
    reason: top || repl ? null : "找不到 coqtop 或 rocq repl。",
  };
}

export function rocqRuntime() {
  runtimePromise ||= loadRuntime();
  return runtimePromise;
}

async function resolveMake() {
  for (const candidate of [
    "/Library/Developer/CommandLineTools/usr/bin/make",
    "/usr/bin/make",
  ]) {
    const resolved = await realpath(candidate).catch(() => "");
    if (resolved) return resolved;
  }
  return "/usr/bin/make";
}

function sandboxProfile(directory, prefix, makeBinary) {
  const quoted = (value) => JSON.stringify(value);
  return `(version 1)
    (deny default)
    (allow file-read-metadata)
    (allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/usr/bin")
      (subpath "/bin") (subpath "/System/Library") (subpath "/Library/Apple/System/Library")
      (subpath "/System/Volumes/Preboot") (subpath "/opt/homebrew")
      (subpath "/private/var/db/dyld") (subpath ${quoted(prefix)})
      (subpath ${quoted(path.dirname(makeBinary))})
      (subpath ${quoted(directory)}) (literal "/dev/null") (literal "/dev/urandom"))
    (allow file-write* (subpath ${quoted(directory)}) (literal "/dev/null"))
    (allow process-exec (literal ${quoted(makeBinary)})
      (subpath ${quoted(prefix)}) (subpath "/bin") (subpath "/usr/bin"))
    (allow process-fork)
    (allow signal)
    (allow sysctl-read)
    (deny network*)`;
}

export async function checkRocqArtifact(source, { theoremName } = {}) {
  const names = theoremNames(source);
  if (names.length !== 1 || (theoremName && theoremName !== names[0]))
    return {
      ready: false,
      make: "not_run",
      closed: false,
      admits: [],
      extraAxioms: [],
      commands: ["make check", "make validate"],
      reason: "需要恰好一个定理声明，才能用固定命令重放。",
    };
  const name = names[0];
  const runtime = await rocqRuntime();
  if (!runtime.ready)
    return {
      ready: false,
      make: "unavailable",
      closed: false,
      admits: [],
      extraAxioms: [],
      commands: ["make check", "make validate"],
      version: runtime.version || null,
      reason: runtime.reason || "固定版本的 Rocq 尚未安装。",
    };
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "lemma-rocq-")),
  );
  const validateCommand = runtime.coqtop
    ? `"${runtime.coqtop}" -batch -q -Q . "" -l Paper.v -l PrintAssumptions.v`
    : `"${runtime.rocq}" repl -batch -q -Q . "" -l Paper.v -l PrintAssumptions.v`;
  const makefile = `check:\n\t"${runtime.coqc}" -q -Q . "" Paper.v\nvalidate: check\n\t${validateCommand}\n`;
  await writeFile(path.join(directory, "Paper.v"), source, { mode: 0o600 });
  await writeFile(
    path.join(directory, "PrintAssumptions.v"),
    `Print Assumptions ${name}.\n`,
    { mode: 0o600 },
  );
  await writeFile(path.join(directory, "Makefile"), makefile, { mode: 0o600 });
  const makeBinary = await resolveMake();
  const profile = sandboxProfile(directory, runtime.prefix, makeBinary);
  const runMake = (target) =>
    runBounded(
      "/usr/bin/sandbox-exec",
      ["-p", profile, makeBinary, "-C", directory, target],
      {
        cwd: directory,
        env: {
          PATH: `${path.dirname(runtime.coqc)}:/usr/bin:/bin`,
          HOME: directory,
          TMPDIR: directory,
          LANG: "C.UTF-8",
        },
        timeoutMs: 180000,
        maxOutput: 2_000_000,
        maxMemoryMiB: 2048,
      },
    );
  const check = await runMake("check");
  const makeOk = check.exitCode === 0 && !check.termination;
  const validate = makeOk ? await runMake("validate") : null;
  const assumptions = parseAssumptions(
    `${validate?.stdout || ""}\n${validate?.stderr || ""}`,
    name,
  );
  return {
    ready: true,
    make: makeOk ? "ok" : "failed",
    validate: validate
      ? validate.exitCode === 0 && !validate.termination
        ? "ok"
        : "failed"
      : "not_run",
    closed: makeOk && assumptions.closed,
    admits: assumptions.admits,
    extraAxioms: assumptions.extraAxioms,
    commands: ["make check", "make validate"],
    version: runtime.version,
    platform: runtime.platform,
    coqcSha256: runtime.coqcSha256,
    theoremName: name,
    checkExcerpt: `${check.stdout}\n${check.stderr}`.slice(0, 2000),
    validateExcerpt: `${validate?.stdout || ""}\n${validate?.stderr || ""}`.slice(
      0,
      2000,
    ),
  };
}

export function rocqColumns(result, located) {
  const axiomText = [
    ...(result.admits || []).map((name) => `${name}（admit）`),
    ...(result.extraAxioms || []).map((name) => `${name}（额外公理）`),
  ];
  return {
    make:
      result.make === "ok"
        ? axiomText.length
          ? "make check 已重放，仍有未完成项"
          : "make check 已重放"
        : result.make === "unavailable"
          ? "make check 未运行"
          : "make check 失败",
    axioms:
      result.make === "ok"
        ? axiomText.length
          ? axiomText.join("、")
          : "无 admit，无额外公理"
        : "未列出",
    correspondence: located
      ? `第 ${located.page.index + 1} 页：${located.quote}`
      : "语句没有唯一对应到原文",
  };
}
