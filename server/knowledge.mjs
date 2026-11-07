import { resolveDeclarationModules } from "./premise-index.mjs";
import { maskLeanCommentsAndStrings } from "./declaration-names.mjs";
import { MATHLIB_COMMIT } from "../shared/library-profiles.mjs";
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { DOMAIN_KNOWLEDGE } from "../shared/knowledge-catalog.mjs";
import { MATHLIB_ROOT } from "./libraries.mjs";
import { inspectTarget } from "./lean-query.mjs";
import { profileForContract } from "../shared/library-profiles.mjs";
import { digest, sha256, isId } from "./evidence.mjs";
import { inspectReviewEvidence } from "./review-evidence.mjs";
const exec = promisify(execFile);

// Lexical candidates only: native queries below establish availability, while
// the independent reviewer still checks whether a name is used as intended.
export function declarationQueriesFromTarget(target) {
  return [
    ...new Set(
      maskLeanCommentsAndStrings(target).match(
        /[\p{L}_][\p{L}\p{N}_'₀-₉]*(?:\.[\p{L}_][\p{L}\p{N}_'₀-₉]*)*/gu,
      ) || [],
    ),
  ]
    .filter((name) => !name.startsWith("LemmaPaper."))
    .slice(0, 256);
}

export function rankDeclarations(contract, query = "", limit = 8) {
  const catalog = DOMAIN_KNOWLEDGE[contract.libraryProfile];
  if (!catalog) return [];
  const terms =
    `${contract.leanTarget} ${contract.statement} ${query}`
      .toLowerCase()
      .match(/[a-z_][a-z_.]+|[\u4e00-\u9fff]{2,}/g) || [];
  return catalog
    .map((item) => ({
      ...item,
      score: [...new Set(terms)].reduce(
        (s, term) =>
          s +
          (item.name.toLowerCase() === term
            ? 20
            : `${item.name} ${item.keywords}`.toLowerCase().includes(term)
              ? 2
              : 0),
        0,
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export async function retrieveKnowledge(
  contract,
  { query = "", signal, inspector = inspectTarget } = {},
) {
  // The built-in index describes this pinned Mathlib only. A sealed alternate
  // environment must not receive a same-name definition from a different tree.
  const canUsePinnedMathlib =
    !contract.executionEnvironment &&
    contract.imports.some((m) => m === "Mathlib" || m.startsWith("Mathlib."));
  const authored = canUsePinnedMathlib ? rankDeclarations(contract, query) : [];
  const requested = declarationQueriesFromTarget(contract.leanTarget);
  const resolvedNames = canUsePinnedMathlib
    ? await resolveDeclarationModules(requested, { signal })
    : [];
  const generic = resolvedNames
    .filter((r) => r.status === "resolved_candidate")
    .map((r) => ({ ...r.entries[0], sourceRevision: MATHLIB_COMMIT }));
  const names = new Map(generic.map((e) => [e.name, e]));
  for (const entry of authored)
    if (!names.has(entry.name))
      names.set(entry.name, {
        ...entry,
        sourceRevision: profileForContract(contract).revision,
      });
  const entries = [...names.values()].slice(0, 8);
  if (!entries.length)
    return {
      targetHash: contract.targetHash,
      libraryRevision: profileForContract(contract).revision,
      importedMathlibRevision: canUsePinnedMathlib ? MATHLIB_COMMIT : null,
      entries: [],
      status: contract.executionEnvironment
        ? "environment_not_indexed"
        : "no_matches",
      note: contract.executionEnvironment
        ? "当前索引不覆盖此封存环境，未回退到其他版本的定义。"
        : "当前索引中没有匹配声明；不代表数学库中不存在相关结果。",
    };
  const checked = await inspector(contract, {
    names: entries.map((e) => e.name),
    definitions: entries
      .filter((e) =>
        [
          "definition",
          "def",
          "abbrev",
          "structure",
          "class",
          "opaque",
        ].includes(e.kind),
      )
      .map((e) => e.name),
    signal,
  });
  const resolved = [];
  for (const item of entries) {
    const declaration = checked.declarations.find((d) => d.name === item.name);
    if (
      !declaration?.signature ||
      (checked.status !== "well_typed" && !declaration.verifiedInEnvironment)
    )
      continue;
    const { stdout: source } = await exec(
      "/usr/bin/git",
      ["show", `${item.sourceRevision}:${item.file}`],
      {
        cwd: MATHLIB_ROOT,
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
        signal,
      },
    );
    const escaped = item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(
      `(?:theorem|lemma|def|structure|class|protected theorem)\\s+${escaped}(?=[\\s{(:])`,
    ).exec(source);
    // Some declarations are class projections or generated aliases; retain the
    // complete file identity and say no exact line when no declaration is present.
    if (item.sourceSha256 && sha256(source) !== item.sourceSha256)
      throw Error("Knowledge candidate changed pinned source identity");
    const line =
      item.line ||
      (match ? source.slice(0, match.index).split("\n").length : null);
    resolved.push({
      ...item,
      ...declaration,
      line,
      sourceSha256: sha256(source),
      sourceOrigin: "git_object_at_pinned_revision",
      sourceExcerpt: line
        ? source
            .split("\n")
            .slice(line - 1, line + 9)
            .join("\n")
        : null,
      url: `https://github.com/leanprover-community/mathlib4/blob/${item.sourceRevision}/${item.file}${line ? `#L${line}` : ""}`,
      availableInCurrentEnvironment: "confirmed_in_fixed_contract",
      guidanceAuthority: item.nameOrigin
        ? "pinned_source_and_native_signature_only"
        : "authored_guidance_signature_checked_by_lean",
    });
  }
  return {
    schemaVersion: "lemma.knowledge.v1",
    targetHash: contract.targetHash,
    libraryRevision: profileForContract(contract).revision,
    importedMathlibRevision: canUsePinnedMathlib ? MATHLIB_COMMIT : null,
    query,
    status:
      checked.status === "well_typed"
        ? "resolved"
        : resolved.length
          ? "partially_resolved"
          : "lookup_failed",
    unresolved: entries
      .filter((e) => !resolved.some((r) => r.name === e.name))
      .map((e) => ({ name: e.name, status: "not_verified_in_contract" })),
    entries: resolved,
    inspection: checked,
  };
}

export const reusableIdentity = (contract) =>
  digest({
    leanTarget: contract.leanTarget,
    assumptions: contract.assumptions,
    imports: contract.imports,
    libraryRevision: profileForContract(contract).revision,
    allowedAxioms: contract.allowedAxioms,
    domainContext: contract.domainContext || null,
  });
export async function retrieveCases(store, contract, { autonomy = null } = {}) {
  const files = (await readdir(path.join(store.root, "runs")))
    .filter((f) => f.endsWith(".json") && isId(f.slice(0, -5)))
    .sort()
    .reverse()
    .slice(0, 100);
  const cases = [];
  for (const file of files) {
    const run = await store.getRun(file.slice(0, -5));
    if (
      run.status !== "completed" ||
      !run.root ||
      !run.contract ||
      (autonomy && run.autonomy?.sessionId !== autonomy.sessionId) ||
      reusableIdentity(run.contract) !== reusableIdentity(contract)
    )
      continue;
    let saved, proofArtifact;
    try {
      ({ saved, proofArtifact } = inspectReviewEvidence(
        await store.bundle(run.root),
        run.root,
      ));
    } catch {
      continue;
    } // Broken historical records are never promoted or reused.
    if (
      saved.check.status !== "verified" ||
      !["formalized_proved", "refuted"].includes(saved.conclusion.theorem)
    )
      continue;
    cases.push({
      root: run.root,
      targetHash: run.contract.targetHash,
      identity: reusableIdentity(contract),
      proof: proofArtifact.payload.proof,
      mode: proofArtifact.payload.mode,
      note: "历史已检查案例；复用必须重新运行当前 Lean 检查。",
    });
    if (cases.length === 2) break;
  }
  return cases;
}
