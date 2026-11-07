import { digest } from "./evidence.mjs";
import {
  validateDecomposition,
  obligationContract,
  composeDecomposition,
  kernelAccepted,
} from "./proof-decomposition.mjs";
import { proofBlueprint, checkBlueprint } from "./proof-workspace.mjs";
import { auditDependencies } from "./lean-dependencies.mjs";
import { PROOF_RUNTIME } from "./runtime-limits.mjs";

// A project is a collection of conditional obligations, never a collection of
// assumed facts. Only a fresh full-root check can turn it into a certificate.
export class LemmaProjects {
  constructor({
    contract,
    checker,
    persist,
    policy = {},
    signal,
    limits = {},
  }) {
    Object.assign(this, { contract, checker, persist, policy, signal });
    this.limits = { ...PROOF_RUNTIME, ...limits };
    this.projects = new Map();
    this.checks = new Map();
  }
  get(id) {
    const p = this.projects.get(id);
    if (!p) throw Error("Unknown lemma project; call plan_lemmas first");
    return p;
  }
  local(p, name) {
    const part = p.plan.parts.find((s) => s.name === name);
    if (!part) throw Error("Unknown lemma in this project");
    return {
      part,
      contract: obligationContract(
        p.contract,
        part.name,
        part.target,
        part.dependsOn.map((n) => p.plan.parts.find((s) => s.name === n)),
      ),
    };
  }
  async plan(raw, parent = null) {
    this.signal?.throwIfAborted();
    let root = this.contract,
      depth = 0;
    if (parent) {
      const p = this.get(parent.projectId);
      root = this.local(p, parent.name).contract;
      depth = p.depth + 1;
    }
    if (depth >= this.limits.maxDecompositionDepth)
      throw Error("Lemma decomposition depth exhausted");
    if (
      this.projects.size >=
      this.limits.maxHelperParts * this.limits.maxDecompositionDepth
    )
      throw Error("Lemma project count exhausted");
    // Optional proof fields from the shared validator are deliberately excluded:
    // the agent must submit and check each construction using check_lemma.
    if (raw.parts?.some((p) => Object.hasOwn(p, "proof")))
      throw Error("Submit lemma proof terms through check_lemma, not a plan");
    const plan = validateDecomposition(raw, root, this.limits.maxHelperParts);
    const id = digest({ root: root.targetHash, plan, parent });
    if (this.projects.has(id)) return this.describe(this.get(id));
    const blueprint = proofBlueprint(
      {
        steps: plan.parts.map((p) => ({
          ...p,
          title: p.purpose,
          kind: "omitted",
          anchors: [],
        })),
      },
      root,
    );
    const preflight = await checkBlueprint(
      blueprint,
      this.checker,
      this.signal,
    );
    const connection = obligationContract(
      root,
      "LemmaAssembly",
      root.leanTarget,
      plan.parts,
    );
    const connectionCheck =
      preflight.status === "well_typed"
        ? await this.checker(connection, plan.assembly, {
            signal: this.signal,
            dependencyAudit: true,
            requiredBinders: plan.parts.length,
          })
        : null;
    const artifact = await this.persist("proof:lemma_plan", {
      projectId: id,
      root,
      plan,
      parent,
      depth,
      preflight,
      connection,
      connectionCheck,
      scope: "conditional_plan_not_proved_helpers",
    });
    const p = {
      id,
      contract: root,
      plan,
      parent,
      depth,
      preflight,
      connection,
      connectionCheck,
      artifact,
      solved: new Map(),
      attempts: [],
    };
    this.projects.set(id, p);
    return this.describe(p);
  }
  async check(id, name, proof) {
    this.signal?.throwIfAborted();
    const p = this.get(id),
      { part, contract } = this.local(p, name);
    if (
      p.preflight.checks.find((s) => s.name === name)?.status !== "well_typed"
    )
      throw Error(
        "Lemma signature is invalid; revise the plan before proving it",
      );
    const key = digest({ contract: contract.targetHash, proof });
    // Failed repeats can reuse their diagnostic. A successful term submitted
    // under a new plan must populate THAT plan and receive a fresh receipt.
    if (this.checks.has(key) && !this.checks.get(key).accepted)
      return { ...this.checks.get(key), repeated: true };
    const check = await this.checker(contract, proof, {
      signal: this.signal,
      dependencyAudit: true,
      requiredBinders: part.dependsOn.length,
    });
    const audit = auditDependencies(check, this.policy);
    const accepted =
      kernelAccepted(check, contract) && audit.status === "passed";
    const artifact = await this.persist(
      "proof:lemma_check",
      {
        projectId: id,
        name,
        contract,
        proof,
        check,
        audit,
        accepted,
        scope: "conditional_helper_only_not_parent_or_paper",
      },
      [p.artifact],
    );
    const result = { name, contract, proof, check, audit, accepted, artifact };
    this.checks.set(key, result);
    p.attempts.push(artifact);
    if (accepted)
      p.solved.set(name, {
        ...result,
        identity: digest({ target: part.target, dependsOn: part.dependsOn }),
      });
    return result;
  }
  async assemble(id, assembly = null) {
    this.signal?.throwIfAborted();
    const p = this.get(id);
    const missing = p.plan.parts
      .filter((s) => !p.solved.has(s.name))
      .map((s) => s.name);
    if (missing.length)
      return {
        accepted: false,
        missing,
        scope: "unproved_helpers_cannot_be_assumed",
      };
    const plan = assembly
      ? validateDecomposition(
          { parts: p.plan.parts, assembly },
          p.contract,
          this.limits.maxHelperParts,
        )
      : p.plan;
    const connectionCheck = await this.checker(p.connection, plan.assembly, {
      signal: this.signal,
      dependencyAudit: true,
      requiredBinders: plan.parts.length,
    });
    const connectionAudit = auditDependencies(connectionCheck, this.policy);
    if (
      !kernelAccepted(connectionCheck, p.connection) ||
      connectionAudit.status !== "passed"
    ) {
      const artifact = await this.persist(
        "proof:lemma_assembly_failure",
        {
          projectId: id,
          assembly: plan.assembly,
          connectionCheck,
          connectionAudit,
        },
        [p.artifact, ...p.attempts],
      );
      p.attempts.push(artifact);
      return {
        accepted: false,
        check: connectionCheck,
        audit: connectionAudit,
        artifact,
      };
    }
    const proof = composeDecomposition(plan, p.solved, p.connection);
    // Recompile the fully expanded term. Conditional checks above are never
    // sufficient to mark even the parent local goal as solved.
    const check = await this.checker(p.contract, proof, {
      signal: this.signal,
      dependencyAudit: true,
    });
    const audit = auditDependencies(check, this.policy);
    const accepted =
      kernelAccepted(check, p.contract) && audit.status === "passed";
    const artifact = await this.persist(
      "proof:lemma_assembly",
      {
        projectId: id,
        contract: p.contract,
        proof,
        check,
        audit,
        accepted,
        connectionCheck,
        parent: p.parent,
      },
      [p.artifact, ...p.attempts],
    );
    const result = {
      accepted,
      contract: p.contract,
      proof,
      check,
      audit,
      artifact,
    };
    p.result = result;
    if (accepted && p.parent) {
      result.parentCheck = await this.check(
        p.parent.projectId,
        p.parent.name,
        proof,
      );
    }
    return result;
  }
  describe(p) {
    return {
      projectId: p.id,
      targetHash: p.contract.targetHash,
      depth: p.depth,
      parent: p.parent,
      preflight: p.preflight,
      connectionCheck: p.connectionCheck,
      ready:
        p.preflight.status === "well_typed" &&
        kernelAccepted(p.connectionCheck, p.connection),
      parts: p.plan.parts.map((part) => ({
        ...part,
        contract: this.local(p, part.name).contract,
        accepted: p.solved.has(part.name),
        artifact: p.solved.get(part.name)?.artifact || null,
      })),
      result: p.result
        ? { accepted: p.result.accepted, artifact: p.result.artifact }
        : null,
      progress: {
        closedHelpers: p.solved.size,
        totalHelpers: p.plan.parts.length,
        parentCertified: Boolean(p.result?.accepted),
        nextAction:
          p.solved.size < p.plan.parts.length
            ? "Construct smaller obligations when needed, call check_lemma for every unsolved helper, then assemble_lemmas. A conjunction split is only an interface."
            : "assemble_lemmas",
      },
      scope: "plan_and_conditional_helpers_not_paper_acceptance",
    };
  }
  status() {
    return [...this.projects.values()].map((p) => this.describe(p));
  }
}
