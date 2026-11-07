import { nativeSpan } from "./native-timing.mjs";
import { nativeInspectionFailure } from "./inspection-diagnostic.mjs";
import {
  queryCache,
  invalidateNativeQueryOwner,
} from "./native-query-cache.mjs";
import {
  targetStructureCommand,
  parseTargetStructure,
} from "./target-structure.mjs";
import {
  declarationQueryResults,
  validDeclarationQueryName,
} from "./declaration-query.mjs";
import { LEAN_RUNTIME } from "./runtime-limits.mjs";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  binary,
  parserSource,
  runBounded,
  sandboxProfile,
  withCheckedEnvironment,
} from "./lean.mjs";
import { withLibrarySnapshot } from "./libraries.mjs";
import { validateContract } from "./contracts.mjs";
import { sha256, digest } from "./evidence.mjs";

import {
  domainPrelude,
  domainTerms,
  orderedComponents,
} from "./domain-schema.mjs";

// Only the term goes through the untrusted parser. Commands and declaration
// names are controlled here, with the same fixed environment and sandbox.
export async function inspectTarget(contract, options = {}) {
  if (options.librarySnapshot) {
    const { librarySnapshot, ...rest } = options;
    return withLibrarySnapshot(librarySnapshot, () =>
      inspectTarget(contract, rest),
    );
  }
  validateContract(contract);
  validateQueries(options.names || [], options.definitions || []);
  const queuedAt = Date.now();
  return withCheckedEnvironment(
    contract,
    (environment) =>
      nativeSpan("native.inspection", () =>
        inspectTargetReserved(
          contract,
          { ...options, queuedAt },
          environment,
          Date.now() - queuedAt,
        ),
      ),
    options,
  ).catch((error) => {
    invalidateNativeQueryOwner();
    throw error;
  });
}
function validateQueries(names, definitions) {
  if (
    !Array.isArray(names) ||
    names.length > 20 ||
    names.some((n) => !validDeclarationQueryName(n))
  )
    throw Error("定理查询名称无效。");
  if (
    !Array.isArray(definitions) ||
    definitions.some((n) => !names.includes(n))
  )
    throw Error("定义查询必须属于声明清单。");
}
async function inspectTargetReserved(
  contract,
  { names = [], definitions = [], signal, queuedAt = Date.now() } = {},
  preparedEnvironment,
  environmentMs,
) {
  const started = Date.now(),
    queueMs = 0; // Native queue wait is recorded by runBounded; environmentMs includes the read-lease wait.
  validateContract(contract);
  if (
    !Array.isArray(names) ||
    names.length > 20 ||
    names.some((n) => !validDeclarationQueryName(n))
  )
    throw new Error("定理查询名称无效。");
  if (
    !Array.isArray(definitions) ||
    definitions.some((n) => !names.includes(n))
  )
    throw new Error("定义查询必须属于声明清单。");
  const expanded =
    !!contract.domainContext?.modules.length ||
    !!contract.externalLibraries?.length;
  const parserMemoryMiB = expanded ? 6144 : 4096,
    proofMemoryMiB = expanded ? 4096 : 2048;
  const { lean, library, runtime } = preparedEnvironment;
  const { searchPaths, ...identity } = library;
  const environment = {
    ...lean,
    library: identity,
    ready: lean.ready && library.ready,
  };
  if (!environment.ready) {
    invalidateNativeQueryOwner();
    return {
      status: "tool_unavailable",
      stage: "environment",
      targetTypeStatus: "unknown",
      declarationQueryStatus: "not_checked",
      declarations: declarationQueryResults(names, "", { executed: false }),
      targetHash: contract.targetHash,
      environment,
      reason: "工具链或数学库尚未通过身份检查。",
    };
  }
  signal?.throwIfAborted();
  const cache = queryCache(contract, environment, {
    names,
    definitions,
    signal,
  });
  const previous = cache?.get();
  if (previous)
    return {
      ...previous,
      performance: {
        queueMs,
        environmentMs,
        elapsedMs: Date.now() - started,
        cache: "hit",
        key: cache.key,
        reason:
          "same_owner_exact_contract_queries_and_freshly_verified_full_environment",
        reusedResultHash: digest(previous),
      },
    };
  const folder = await mkdtemp(path.join(os.tmpdir(), "lemma-query-")),
    directory = await realpath(folder);
  const components = contract.domainContext
    ? orderedComponents(contract.domainContext)
    : [];
  const terms = domainTerms(contract.domainContext);
  // Import only the command elaborator required by trusted structure instrumentation.
  // The umbrella Lean module exceeds the unchanged 2 GiB query limit in the fixed analysis profile.
  const source = `import Lean.Elab.Command\n${contract.imports.map((n) => `import ${n}`).join("\n")}\nset_option autoImplicit false\nset_option maxHeartbeats ${LEAN_RUNTIME.maxHeartbeats}\nset_option pp.fullNames true\n${domainPrelude(contract.domainContext)}\n${components.map((c) => `#print axioms LemmaPaper.${c.name}`).join("\n")}\ndef LemmaQuery.target : Prop := (${contract.leanTarget})\n#print LemmaQuery.target\n${targetStructureCommand}\n${names.map((n) => `#eval IO.println "LEMMA_DECL:${n}"\n${definitions.includes(n) ? `#print ${n}` : `#check @${n}`}\n#eval IO.println "LEMMA_DECL_OK:${n}"\n#eval IO.println "LEMMA_DECL_END:${n}"`).join("\n")}\n`;
  try {
    await Promise.all([
      ...terms.map((term, i) =>
        writeFile(path.join(directory, `Domain${i}.txt`), term, {
          mode: 0o600,
        }),
      ),
      writeFile(path.join(directory, "Query.lean"), source, { mode: 0o600 }),
      writeFile(
        path.join(directory, "ParserCheck.lean"),
        parserSource(contract.imports, terms.length),
        { mode: 0o600 },
      ),
      writeFile(path.join(directory, "Target.txt"), contract.leanTarget, {
        mode: 0o600,
      }),
      writeFile(path.join(directory, "ProofTerm.txt"), "by trivial", {
        mode: 0o600,
      }),
    ]);
    const options = {
      cwd: directory,
      env: {
        PATH: path.dirname(runtime.binary),
        LANG: "C.UTF-8",
        TMPDIR: directory,
        LEAN_PATH: [directory, ...searchPaths].join(path.delimiter),
      },
      signal,
      timeoutMs: expanded
        ? LEAN_RUNTIME.expandedTimeoutMs
        : LEAN_RUNTIME.analysisTimeoutMs,
    };
    const prefix = [
      "-p",
      sandboxProfile(directory, searchPaths, runtime),
      runtime.binary,
    ];
    const parserStarted = Date.now();
    const parser = await nativeSpan("native.parser", () =>
      runBounded(
        "/usr/bin/sandbox-exec",
        [...prefix, "-M", String(parserMemoryMiB), "--run", "ParserCheck.lean"],
        options,
      ),
    );
    const parserMs = Date.now() - parserStarted;
    if (
      parser.exitCode !== 0 ||
      parser.termination ||
      !parser.stdout.includes("lemma-parser-accepted")
    )
      return {
        status: nativeInspectionFailure(parser)
          ? "tool_unavailable"
          : "not_well_typed",
        failureKind: nativeInspectionFailure(parser),
        targetTypeStatus: nativeInspectionFailure(parser)
          ? "unknown"
          : "not_well_typed",
        declarationQueryStatus: "not_checked",
        stage: "syntax",
        declarations: declarationQueryResults(names, "", { executed: false }),
        targetHash: contract.targetHash,
        environment,
        sourceSha256: sha256(source),
        parser,
        reason: "目标语法检查未完成。",
      };
    const elaborationStarted = Date.now();
    const result = await nativeSpan("native.elaboration", () =>
      runBounded(
        "/usr/bin/sandbox-exec",
        [...prefix, "-M", String(proofMemoryMiB), "Query.lean"],
        options,
      ),
    );
    const elaborationMs = Date.now() - elaborationStarted;
    const stdout = result.stdout.replaceAll(directory, "<query-dir>"),
      stderr = result.stderr.replaceAll(directory, "<query-dir>");
    const failureKind = nativeInspectionFailure(result);
    // Optional name queries follow the complete target section. A missing name
    // must not erase a valid target or hide errors in its actual environment.
    const targetDiagnostics = stdout.split("LEMMA_DECL:")[0];
    const structure = parseTargetStructure(
      targetDiagnostics,
      contract.targetHash,
      digest(environment),
    );
    const targetAccepted =
      !failureKind &&
      /^def LemmaQuery.target\s/m.test(targetDiagnostics) &&
      !/\berror(?:\([^)\n]*\))?:/.test(targetDiagnostics) &&
      !!structure &&
      components.every((c) => {
        const prefix = `'LemmaPaper.${c.name}' `;
        const audit = targetDiagnostics
          .split("\n")
          .filter((l) => l.startsWith(prefix))
          .at(-1);
        if (!audit) return false;
        if (audit.includes("does not depend on any axioms")) return true;
        const axioms = /depends on axioms:\s*\[([^\]]*)\]/.exec(audit);
        return (
          !!axioms &&
          axioms[1]
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean)
            .every((a) => contract.allowedAxioms.includes(a))
        );
      });
    const declarations = declarationQueryResults(names, stdout);
    const declarationQueryStatus = failureKind
      ? "incomplete"
      : declarations.every((d) => d.verifiedInEnvironment)
        ? "complete"
        : "incomplete";
    const accepted =
      result.exitCode === 0 &&
      targetAccepted &&
      declarationQueryStatus === "complete";
    const queryIncomplete =
      targetAccepted &&
      names.length > 0 &&
      declarationQueryStatus === "incomplete";
    const checked = {
      performance: {
        queueMs,
        environmentMs,
        parserMs,
        elaborationMs,
        elapsedMs: Date.now() - started,
        cache: "miss",
        key: cache?.key || null,
        reason: cache
          ? "no_matching_successful_query_in_this_owner"
          : "no_session_owner",
      },
      status: accepted
        ? "well_typed"
        : failureKind
          ? "tool_unavailable"
          : queryIncomplete
            ? "query_incomplete"
            : "not_well_typed",
      failureKind,
      targetHash: contract.targetHash,
      environment,
      source,
      sourceSha256: sha256(source),
      invocation: {
        parserMemoryMiB,
        proofMemoryMiB,
        timeoutMs: options.timeoutMs,
      },
      ...result,
      stdout,
      stderr,
      stage: "native",
      targetTypeStatus: failureKind
        ? "unknown"
        : targetAccepted
          ? "well_typed"
          : "not_well_typed",
      declarationQueryStatus,
      declarations,
      targetStructure: targetAccepted ? structure : null,
      reason: accepted
        ? "目标类型为 Prop；这只检查形式表达合法，不证明原文一致性或目标成立。"
        : failureKind
          ? "原生检查因资源或进程中断未完成；目标类型未知，不能据此认定目标无效。"
          : queryIncomplete
            ? "目标类型检查已通过；部分可选声明查询未通过。请分别查看各声明结果，不要因此修改形式目标。这不是证明证书。"
            : "目标类型或其固定环境检查未通过；请查看具体诊断。",
    };
    signal?.throwIfAborted();
    cache?.put(checked);
    return checked;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
