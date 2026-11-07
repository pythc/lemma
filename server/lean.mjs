import { realpathSync } from "node:fs";
import { nativeHost, needsNativeAdmission } from "./resources/native-host.mjs";
import { proofAuditCommand, validateProofAudit } from "./lean-audit.mjs";
import { nativeSpan } from "./native-timing.mjs";
import { resolveEnvironment } from "./lean-environments.mjs";
import { executionContext } from "./execution-context.mjs";
import { dependencyCommand, parseDependencies } from "./lean-dependencies.mjs";
import { LEAN_RUNTIME } from "./runtime-limits.mjs";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { sha256 } from "./evidence.mjs";
import {
  validateContract,
  validateLeanText,
  MAX_PROOF_CHARACTERS,
} from "./contracts.mjs";
import { toolchainTree } from "./toolchain-tree.mjs";
import { libraryEnvironment, withLibrarySnapshot } from "./libraries.mjs";
import { profileForContract } from "../shared/library-profiles.mjs";
import { checkedReservation } from "./environment-reservation.mjs";

import { domainPrelude, domainTerms } from "./domain-schema.mjs";

export const LEAN_VERSION = "4.35.0";
export const RELEASE_SHA256 =
  "55132a570e3dfc6203626944b262793c0f0f6a8230c0d09344a06ac992fac4a9";
export const LEAN_BINARY_SHA256 =
  "d1d9c26a539f54fe839d2aa7760bf1ac1dd76a30b26e2c9684bebf2900038fcf";
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const toolRoot = path.join(
  appRoot,
  ".tools",
  `lean-${LEAN_VERSION}-darwin_aarch64`,
);
export const binary = path.join(toolRoot, "bin", "lean");
// Capture the code actually loaded, rather than hashing a possibly edited file later.
const RUNNER_SHA256 = sha256(
  (
    await Promise.all(
      [
        import.meta.url,
        new URL("./lean-dependencies.mjs", import.meta.url),
        new URL("./lean-audit.mjs", import.meta.url),
        new URL("./execution-context.mjs", import.meta.url),
        new URL("./libraries.mjs", import.meta.url),
        new URL("./external-libraries.mjs", import.meta.url),
        new URL("./runtime-limits.mjs", import.meta.url),
        new URL("./domain-schema.mjs", import.meta.url),
        new URL("./domain-library.mjs", import.meta.url),
        new URL("./domain-evidence.mjs", import.meta.url),
        new URL("./lean-query.mjs", import.meta.url),
        new URL("./native-timing.mjs", import.meta.url),
        new URL("./native-query-cache.mjs", import.meta.url),
        new URL("./target-structure.mjs", import.meta.url),
        new URL("./library-access.mjs", import.meta.url),
        new URL("./file-lease.mjs", import.meta.url),
        new URL("./resources/native-host.mjs", import.meta.url),
        new URL("./resources/native-policy.mjs", import.meta.url),
        new URL("../worker/native_slot.py", import.meta.url),
        new URL("./library-snapshot.mjs", import.meta.url),
        new URL("./library-generation.mjs", import.meta.url),
        new URL("./environment-reservation.mjs", import.meta.url),
        new URL("./environment-borrows.mjs", import.meta.url),
        new URL("../worker/library_lease.py", import.meta.url),
        new URL("./toolchain-tree.mjs", import.meta.url),
        new URL("./contracts.mjs", import.meta.url),
        new URL("./lean-environments.mjs", import.meta.url),
        new URL("./evidence.mjs", import.meta.url),
        new URL("../shared/library-profiles.mjs", import.meta.url),
        new URL("../shared/agent-tool-fields.mjs", import.meta.url),
      ].map((url) => readFile(fileURLToPath(url))),
    )
  )
    .map((bytes) => sha256(bytes))
    .join("\n"),
);
// Load the selected environment once at runtime. Importing all mathlib headers
// here as well would duplicate the environment in the interpreted bootstrap.
export const parserSource = (imports, extraTerms = 0) => `import Lean
import Std
open Lean
unsafe def main : IO UInt32 := do
  initSearchPath (← findSysroot)
  enableInitializersExecution
  let env ← importModules #[${imports.map((name) => `{ module := \`${name} }`).join(", ")}] {} (loadExts := true)
  for file in [${["Target.txt", "ProofTerm.txt", ...Array.from({ length: extraTerms }, (_, i) => `Domain${i}.txt`)].map((n) => JSON.stringify(n)).join(", ")}] do
    let input ← IO.FS.readFile file
    match Parser.runParserCategory env \`term input file with
    | .error error =>
      IO.eprintln error
      return 1
    | .ok _ => pure ()
  IO.println "lemma-parser-accepted"
  return 0
`;

export async function runBounded(
  command,
  args,
  {
    cwd,
    env,
    signal,
    timeoutMs = LEAN_RUNTIME.stdTimeoutMs,
    maxOutput = LEAN_RUNTIME.outputBytes,
    maxMemoryMiB = null,
    nativeAdmission = needsNativeAdmission(command, args),
  } = {},
) {
  const context = executionContext.getStore();
  if (nativeAdmission) await context?.onToolQueued?.("lean-host");
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        termination: "cancelled",
      });
    let stdout = "",
      stderr = "",
      termination = null,
      ended = false;
    const process = spawn(
      nativeAdmission ? nativeHost.python : command,
      nativeAdmission
        ? [nativeHost.helper, nativeHost.root, String(nativeHost.capacity)]
        : args,
      {
        cwd,
        env,
        stdio: nativeAdmission
          ? ["pipe", "pipe", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    let stoppingTimer;
    const stop = (reason) => {
      if (ended) return;
      termination = reason;
      const killOwnedGroup = () => {
        try {
          globalThis.process.kill(-process.pid, "SIGKILL");
        } catch {
          process.kill("SIGKILL");
        }
      };
      killOwnedGroup();
      // A fork in progress can acquire the inherited pipes/lease while the
      // first group signal is delivered. Drain that same group until close.
      stoppingTimer ||= setInterval(killOwnedGroup, 50);
    };
    let timer;
    if (nativeAdmission) {
      process.stdin.on("error", () => {});
      process.stdin.write(JSON.stringify({ command, args }) + "\n");
      let control = "";
      process.stdio[3].on("data", (data) => {
        control += data;
        if (!control.endsWith("\n")) return;
        try {
          const receipt = JSON.parse(control);
          if (receipt.event !== "acquired")
            throw Error("Invalid native admission receipt");
          Promise.resolve(context?.onToolStarted?.("lean-host"))
            .then(() => {
              if (ended || signal?.aborted) return;
              timer = setTimeout(() => stop("timeout"), timeoutMs);
              process.stdin.write("go\n");
            })
            .catch(() => stop("admission_record_failed"));
        } catch {
          stop("admission_protocol_failed");
        }
      });
    } else timer = setTimeout(() => stop("timeout"), timeoutMs);
    let checkingMemory = false;
    const memoryTimer = maxMemoryMiB
      ? setInterval(() => {
          if (ended || checkingMemory) return;
          checkingMemory = true;
          execFile(
            "/bin/ps",
            ["-axo", "pgid=,rss="],
            { timeout: 2000, maxBuffer: 1024 * 1024 },
            (error, output) => {
              checkingMemory = false;
              if (error || ended) return;
              const rss = output.split("\n").reduce((sum, row) => {
                const [group, size] = row.trim().split(/\s+/).map(Number);
                return (
                  sum +
                  (group === process.pid && Number.isFinite(size) ? size : 0)
                );
              }, 0);
              if (rss > maxMemoryMiB * 1024) stop("memory_limit");
            },
          );
        }, 250)
      : null;
    const abort = () => stop("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (stream) => (bytes) => {
      if (stream === "stdout") stdout += bytes.toString();
      else stderr += bytes.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutput)
        stop("output_limit");
    };
    process.stdout.on("data", collect("stdout"));
    process.stderr.on("data", collect("stderr"));
    process.on("error", (e) => {
      stderr = e.code || "spawn_error";
    });
    process.on("close", (exitCode, signalName) => {
      ended = true;
      clearTimeout(timer);
      clearInterval(stoppingTimer);
      if (memoryTimer) clearInterval(memoryTimer);
      signal?.removeEventListener("abort", abort);
      if (signalName && !termination) termination = `signal:${signalName}`;
      Promise.resolve(
        nativeAdmission ? context?.onToolFinished?.("lean-host") : undefined,
      ).then(
        () =>
          resolve({
            exitCode,
            stdout: stdout.slice(0, maxOutput),
            stderr: stderr.slice(0, maxOutput),
            termination,
          }),
        reject,
      );
    });
  });
}

export async function leanStatus({ verifyLibraries = false } = {}) {
  if (os.platform() !== "darwin" || os.arch() !== "arm64")
    return {
      ready: false,
      reason:
        "当前锁定的沙箱运行器支持 macOS arm64；其他平台需单独核验隔离方案。",
    };
  try {
    await access(binary);
    await access("/usr/bin/sandbox-exec");
    const release = JSON.parse(
      await readFile(path.join(appRoot, ".tools", "toolchain.json"), "utf8"),
    );
    const binarySha256 = sha256(await readFile(binary));
    if (
      release.archiveSha256 !== RELEASE_SHA256 ||
      release.binarySha256 !== binarySha256 ||
      binarySha256 !== LEAN_BINARY_SHA256
    )
      throw new Error("工具链摘要不符");
    if (!release.distribution?.sha256) throw new Error("工具链文件清单缺失");
    if (verifyLibraries) {
      const current = await toolchainTree(toolRoot);
      if (current.sha256 !== release.distribution.sha256)
        throw new Error("工具链库文件摘要不符");
    }
    return {
      ready: true,
      version: LEAN_VERSION,
      nodeVersion: process.versions.node,
      platform: os.platform(),
      arch: os.arch(),
      archiveSha256: RELEASE_SHA256,
      binarySha256,
      runnerSha256: RUNNER_SHA256,
      distribution: release.distribution,
      librariesVerified: verifyLibraries,
      sandbox: "macOS-seatbelt-v1",
    };
  } catch {
    return {
      ready: false,
      reason: "Lean 工具链尚未就绪或摘要不符，请运行 npm run setup:lean。",
    };
  }
}

export function proofSource(
  contract,
  proof,
  mode,
  { dependencyAudit = false, requiredBinders = 0 } = {},
) {
  validateContract(contract);
  validateLeanText(proof, "证明", MAX_PROOF_CHARACTERS);
  if (!["proof", "counterexample"].includes(mode))
    throw new Error("核验路线无效。");
  const target =
    mode === "counterexample"
      ? `¬ (${contract.leanTarget})`
      : `(${contract.leanTarget})`;
  return `${"import Lean\n"}${contract.imports.map((name) => `import ${name}`).join("\n")}\nset_option autoImplicit false\nset_option maxHeartbeats ${LEAN_RUNTIME.maxHeartbeats}\nset_option maxRecDepth ${LEAN_RUNTIME.maxRecDepth}\n${domainPrelude(contract.domainContext)}\nnamespace LemmaReview\ntheorem checked : ${target} :=\n${proof}\nend LemmaReview\n#print axioms LemmaReview.checked\n#check LemmaReview.checked\n${proofAuditCommand(contract, sha256(proof), mode)}\n${dependencyAudit ? dependencyCommand(requiredBinders, { outputFile: "Dependencies.json" }) : ""}`;
}

export function sandboxProfile(
  directory,
  libraryPaths = [],
  runtime = { toolRoot, binary },
) {
  const quoted = (v) => JSON.stringify(v);
  runtime = {
    ...runtime,
    toolRoot: realpathSync(runtime.toolRoot),
    binary: realpathSync(runtime.binary),
  };
  libraryPaths = libraryPaths.map((p) => realpathSync(p));
  return `(version 1)
    (deny default)
    (allow file-read-metadata)
    (allow file-read* (literal "/") (literal "/System") (literal "/System/Volumes")
      (literal "/System/Volumes/Preboot"))
    (allow file-read* (subpath ${quoted(runtime.toolRoot)}) (subpath ${quoted(directory)})
      (subpath "/System/Library") (subpath "/usr/lib") (subpath "/Library/Apple/System/Library")
      (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/private/var/db/dyld")
      (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
    (allow file-write* (subpath ${quoted(directory)}) (literal "/dev/null"))
    (allow process-fork)
    (allow process-exec (literal ${quoted(runtime.binary)}))
    (allow sysctl-read)
    (deny network*)
    ${libraryPaths.length ? `(allow file-read* ${libraryPaths.map((p) => `(subpath ${quoted(p)})`).join(" ")})` : ""}`;
}

export async function checkProof(contract, proof, options = {}) {
  if (options.librarySnapshot) {
    const { librarySnapshot, ...rest } = options;
    return withLibrarySnapshot(librarySnapshot, () =>
      checkProof(contract, proof, rest),
    );
  }
  return withCheckedEnvironment(
    contract,
    (environment) =>
      nativeSpan(
        "native.kernel",
        () => checkProofReserved(contract, proof, options, environment),
        { targetHash: contract.targetHash },
      ),
    options,
  );
}

export const withCheckedEnvironment = (contract, action, options) =>
  checkedReservation(contract, checkEnvironment, action, options);

export async function checkEnvironment(contract) {
  validateContract(contract);
  const profileInfo = profileForContract(contract),
    alternate = contract.executionEnvironment
      ? await resolveEnvironment(contract.executionEnvironment)
      : null,
    runtime = alternate || { toolRoot, binary },
    lean = alternate
      ? {
          ready: true,
          version: alternate.receipt.version,
          binarySha256: alternate.receipt.binarySha256,
          distribution: alternate.receipt.distribution,
          runnerSha256: RUNNER_SHA256,
          sandbox: "macos-seatbelt",
          executionEnvironment: alternate.identity,
        }
      : await leanStatus({ verifyLibraries: true });
  const library = alternate
    ? {
        ready: alternate.receipt.profiles.includes(profileInfo.id),
        searchPaths: alternate.searchPaths,
        contentVerified: true,
        revision: alternate.receipt.libraryRevision,
        treeSha256: alternate.identity.librarySha256,
        reason: alternate.receipt.profiles.includes(profileInfo.id)
          ? null
          : "Selected profile has not been installed for this environment",
      }
    : lean.ready
      ? await libraryEnvironment(
          profileInfo.id,
          contract.domainContext,
          contract.externalLibraries,
        )
      : { ready: false, searchPaths: [] };
  return { profileInfo, runtime, lean, library };
}

async function checkProofReserved(
  contract,
  proof,
  { mode = "proof", signal, dependencyAudit = false, requiredBinders = 0 } = {},
  preparedEnvironment,
) {
  const source = proofSource(contract, proof, mode, {
      dependencyAudit,
      requiredBinders,
    }),
    { profileInfo, runtime, lean, library } = preparedEnvironment;
  const { searchPaths, ...libraryIdentity } = library;
  const environment = {
    ...lean,
    ready: lean.ready && library.ready,
    library: libraryIdentity,
    reason: lean.ready ? library.reason : lean.reason,
  };
  // Omit absent fields from immutable evidence rather than serializing undefined.
  if (environment.reason === undefined) delete environment.reason;
  if (!environment.ready)
    return {
      status: "tool_unavailable",
      targetHash: contract.targetHash,
      mode,
      source,
      sourceSha256: sha256(source),
      environment,
      reason: environment.reason,
    };
  const folder = await mkdtemp(path.join(os.tmpdir(), "lemma-check-"));
  // Resolve /var -> /private/var so Seatbelt and the process use identical roots.
  const { realpath } = await import("node:fs/promises");
  const directory = await realpath(folder);
  try {
    const terms = domainTerms(contract.domainContext);
    const parserText = parserSource(contract.imports, terms.length);
    await Promise.all(
      terms.map((term, i) =>
        writeFile(path.join(directory, `Domain${i}.txt`), term, {
          mode: 0o600,
        }),
      ),
    );
    await writeFile(path.join(directory, "Proof.lean"), source, {
      mode: 0o600,
    });
    await writeFile(path.join(directory, "ParserCheck.lean"), parserText, {
      mode: 0o600,
    });
    await writeFile(path.join(directory, "Target.txt"), contract.leanTarget, {
      mode: 0o600,
    });
    await writeFile(path.join(directory, "ProofTerm.txt"), proof, {
      mode: 0o600,
    });
    const profile = sandboxProfile(directory, searchPaths, runtime);
    const analysis =
      profileInfo.id !== "std-v1" || !!contract.domainContext?.modules.length;
    const expanded =
      !!contract.domainContext?.modules.length ||
      !!contract.externalLibraries?.length;
    const timeoutMs = expanded
      ? LEAN_RUNTIME.expandedTimeoutMs
      : analysis
        ? LEAN_RUNTIME.analysisTimeoutMs
        : LEAN_RUNTIME.stdTimeoutMs;
    const proofMemoryMiB = dependencyAudit
        ? 6144
        : expanded
          ? 4096
          : analysis
            ? 2048
            : 2048,
      parserMemoryMiB = expanded ? 6144 : analysis ? 4096 : 2048;
    const invocation = {
      args: ["-M", String(proofMemoryMiB), "Proof.lean"],
      timeoutMs,
      maxHeartbeats: LEAN_RUNTIME.maxHeartbeats,
      parserMemoryMiB,
      proofMemoryMiB,
    };
    const processOptions = {
      cwd: directory,
      env: {
        PATH: path.join(runtime.toolRoot, "bin"),
        LANG: "C.UTF-8",
        TMPDIR: directory,
        LEAN_PATH: [directory, ...searchPaths].join(path.delimiter),
      },
      signal,
      timeoutMs,
    };
    const parser = await runBounded(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        profile,
        runtime.binary,
        "-M",
        String(parserMemoryMiB),
        "--run",
        "ParserCheck.lean",
      ],
      processOptions,
    );
    if (
      parser.exitCode !== 0 ||
      parser.termination ||
      !parser.stdout.includes("lemma-parser-accepted")
    )
      return {
        status:
          parser.termination === "cancelled" ? "cancelled" : "not_verified",
        targetHash: contract.targetHash,
        mode,
        source,
        sourceSha256: sha256(source),
        exitCode: parser.exitCode,
        axioms: [],
        environment,
        invocation,
        parser: {
          ...parser,
          stdout: parser.stdout.replaceAll(directory, "<check-dir>"),
          stderr: parser.stderr.replaceAll(directory, "<check-dir>"),
          sourceSha256: sha256(parserText),
        },
        failureKind: parser.termination
          ? "execution_failed"
          : /excessive memory|heartbeats/.test(parser.stdout + parser.stderr)
            ? "budget_exhausted"
            : /Target.txt|ProofTerm.txt/.test(parser.stdout + parser.stderr)
              ? "syntax_rejected"
              : "driver_failed",
        reason:
          parser.termination ||
          /excessive memory|heartbeats|ParserCheck.lean/.test(
            parser.stdout + parser.stderr,
          )
            ? "检查器执行受阻或资源预算耗尽；未对命题作出判定。"
            : "目标或证明未通过完整 Lean term 语法检查；没有取得证明证据。",
      };
    const result = await runBounded(
      "/usr/bin/sandbox-exec",
      ["-p", profile, runtime.binary, ...invocation.args],
      {
        ...processOptions,
      },
    );
    const rawOutput = result.stdout.replaceAll(directory, "<check-dir>");
    let audit = null,
      dependencyReport = null;
    try {
      audit = JSON.parse(
        await readFile(path.join(directory, "ProofAudit.json"), "utf8"),
      );
    } catch {}
    if (dependencyAudit) {
      try {
        dependencyReport = parseDependencies(
          "LEMMA_DEPENDENCIES:" +
            (await readFile(path.join(directory, "Dependencies.json"), "utf8")),
        );
      } catch {
        dependencyReport = {
          complete: false,
          reason: "dependency_audit_missing",
        };
      }
    }
    // Full dependency evidence is structured separately. Compiler diagnostics
    // must remain small enough to send back to the repair Agent.
    const output = rawOutput
      .split("\n")
      .filter((line) => !line.startsWith("LEMMA_DEPENDENCIES:"))
      .join("\n");
    const stderr = result.stderr.replaceAll(directory, "<check-dir>");
    const axioms = Array.isArray(audit?.axioms) ? audit.axioms : [];
    const verified =
      result.exitCode === 0 &&
      !result.termination &&
      validateProofAudit(audit, contract, sha256(proof), mode) &&
      (!dependencyAudit || dependencyReport?.complete === true);
    return {
      status: verified
        ? "verified"
        : result.termination === "cancelled"
          ? "cancelled"
          : "not_verified",
      targetHash: contract.targetHash,
      mode,
      source,
      sourceSha256: sha256(source),
      stdout: output,
      stderr,
      exitCode: result.exitCode,
      termination: result.termination,
      axioms,
      kernelAudit: audit,
      ...(dependencyAudit ? { dependencies: dependencyReport } : {}),
      environment,
      invocation,
      parser: { exitCode: 0, sourceSha256: sha256(parserText) },
      failureKind: verified
        ? null
        : result.termination
          ? "execution_failed"
          : result.exitCode === 0 &&
              (!audit || (dependencyAudit && !dependencyReport?.complete))
            ? "audit_incomplete"
            : /excessive memory|heartbeats|recursion depth/.test(
                  output + stderr,
                )
              ? "budget_exhausted"
              : "proof_rejected",
      reason: verified
        ? "固定目标经 Lean 检查，公理依赖符合声明。"
        : "本次没有取得可接受的证明证据；这不意味着原命题为假。",
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
