import { mkdir, readdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { digest, isHash } from "./evidence.mjs";
import { validateContract } from "./contracts.mjs";

export const SEARCH_POLICY = "source-interfaces-portfolio-v1";
export function proofMemoryScope(
  contract,
  { context = null, policy = null } = {},
) {
  validateContract(contract);
  return digest({ searchPolicy: SEARCH_POLICY, contract, context, policy });
}
export function failureLesson(check, audit = null) {
  if (audit?.missingSourceSteps?.length)
    return {
      kind: "missing_dependency",
      detail: `未接入 ${audit.missingSourceSteps.join(", ")}`,
    };
  if (audit?.status === "route_violation")
    return {
      kind: "route_violation",
      detail: "避免根定理捷径、禁用依赖或无效连接",
    };
  const output = (
    String(check?.stdout || "") +
    "\n" +
    String(check?.stderr || "")
  ).slice(-16000);
  return {
    kind: check?.failureKind || "unresolved",
    detail: output || check?.reason || "没有有效证明；不能据此否定命题",
  };
}
export function branchPlan(attempt, parent = null) {
  if (!Number.isInteger(attempt) || attempt < 0)
    throw Error("Invalid proof branch index");
  const strategies = [
    "source_direct",
    "explicit_intermediate_lemmas",
    "equivalent_representation",
    "source_case_split",
  ];
  return {
    index: attempt,
    strategy: strategies[attempt % strategies.length],
    parent,
    instruction:
      "Keep the fixed target and source route. Change the actual construction, not lemma spelling alone. Do not repeat a failed proof unchanged.",
  };
}
export class ProofMemory {
  constructor(store) {
    this.store = store;
    this.directory = path.join(store.root, "proof-memory");
  }
  async remember({
    contract,
    proof,
    mode = "proof",
    check,
    audit = null,
    scope,
    branch = null,
    inputs = [],
  }) {
    if (
      !isHash(scope) ||
      !proof ||
      !["proof", "counterexample"].includes(mode) ||
      check?.targetHash !== contract.targetHash
    )
      throw Error("Invalid proof memory identity");
    validateContract(contract);
    const payload = {
      schemaVersion: "lemma.proof-memory.v1",
      scope,
      contract,
      proof,
      mode,
      check,
      audit,
      branch,
      lesson:
        check.status === "verified" && (!audit || audit.status === "passed")
          ? null
          : failureLesson(check, audit),
      acceptance: "candidate_text_only_recompile_required",
    };
    const artifact = await this.store.put("proof:memory", payload, inputs);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Immutable content-addressed index; the artifact, not this index, is authoritative.
    try {
      await writeFile(
        path.join(this.directory, `${artifact}.json`),
        JSON.stringify({ artifact, scope }),
        { flag: "wx", mode: 0o600 },
      );
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    return artifact;
  }
  async recall(scope, { limit = 24 } = {}) {
    if (!isHash(scope)) throw Error("Invalid memory scope");
    let files;
    try {
      files = await readdir(this.directory);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const found = [];
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const index = JSON.parse(
        await readFile(path.join(this.directory, file), "utf8"),
      );
      if (index.scope !== scope) continue;
      const a = await this.store.get(file.slice(0, -5));
      if (a.kind !== "proof:memory" || a.payload.scope !== scope)
        throw Error("Proof memory index changed");
      validateContract(a.payload.contract);
      found.push({ ...a.payload, artifact: a.id });
    }
    return found
      .sort(
        (a, b) =>
          Number(b.check.status === "verified") -
          Number(a.check.status === "verified"),
      )
      .slice(0, limit);
  }
}
