import { digest } from "./evidence.mjs";
import { validateContract } from "./contracts.mjs";
import { domainImports } from "./domain-schema.mjs";
import {
  profileForContract,
  MATHLIB_COMMIT,
} from "../shared/library-profiles.mjs";
import {
  composeDecomposition,
  obligationContract,
  kernelAccepted,
} from "./proof-decomposition.mjs";

export function sameTheoremScope(candidate, root) {
  return (
    candidate?.leanTarget === root.leanTarget &&
    candidate.sourceArtifact === root.sourceArtifact &&
    digest(candidate.allowedAxioms) === digest(root.allowedAxioms) &&
    digest(candidate.domainContext?.definitions || []) ===
      digest(root.domainContext?.definitions || []) &&
    digest(candidate.domainContext?.lemmas || []) ===
      digest(root.domainContext?.lemmas || [])
  );
}

// Transfer received text and library modules, never prior acceptance, helper
// definitions or helper lemmas. The checker must prove the current closed goal.
export async function rebindTheoremText(store, rootRun, prior, artifact) {
  const root = rootRun.contract;
  if (
    prior.paperSha256 !== rootRun.paperSha256 ||
    prior.contract?.sourceArtifact !== root.sourceArtifact ||
    prior.contract.leanTarget !== root.leanTarget ||
    artifact.kind !== "task:R09" ||
    typeof artifact.payload.proof !== "string"
  )
    return null;
  const modules = new Map(
    (root.domainContext?.modules || []).map((m) => [m.name, m]),
  );
  for (const m of prior.contract.domainContext?.modules || []) {
    if (modules.has(m.name) && digest(modules.get(m.name)) !== digest(m))
      throw Error(
        "Received theorem library identity conflicts with current modules",
      );
    modules.set(m.name, m);
  }
  let contract = root;
  const inputs = [artifact.id, rootRun.contractArtifact];
  if (modules.size > (root.domainContext?.modules.length || 0)) {
    if (prior.contract.domainContext?.revision !== MATHLIB_COMMIT)
      throw Error("Received theorem uses a different mathlib revision");
    const domainContext = {
      schemaVersion: "lemma.domain.v1",
      revision: MATHLIB_COMMIT,
      definitions: root.domainContext?.definitions || [],
      lemmas: root.domainContext?.lemmas || [],
      modules: [...modules.values()],
    };
    const extension = await store.put(
      "original:theorem_environment",
      {
        rootTargetHash: root.targetHash,
        originTargetHash: prior.contract.targetHash,
        domainContext,
      },
      inputs,
    );
    const profile = profileForContract(root);
    const body = {
      ...root,
      schemaVersion: root.externalLibraries?.length
        ? "lemma.contract.v5"
        : "lemma.contract.v4",
      domainContext,
      libraryProfile: profile.id,
      libraryRevision: profile.revision,
      domainArtifact: extension,
      contextArtifact: root.contextArtifact || rootRun.contextArtifact,
      translationArtifact: root.translationArtifact || rootRun.contractArtifact,
      imports: [
        ...domainImports(profileForContract(root), domainContext),
        ...(root.externalLibraries || []).flatMap((e) => e.modules),
      ],
    };
    delete body.targetHash;
    contract = validateContract({ ...body, targetHash: digest(body) });
    inputs.push(extension);
  }
  return {
    contract,
    proof: artifact.payload.proof,
    inputs,
    rootTargetHash: root.targetHash,
    originTargetHash: prior.contract.targetHash,
  };
}

// Build received text, never an acceptance shortcut. The closed root must still
// pass a fresh Lean check even when every conditional fact was accepted before.
export function sourceTheoremCandidate(report, root) {
  if (!report || !sameTheoremScope(report.contract, root)) return null;
  if (
    report.independentTheorem?.status === "verified" &&
    sameTheoremScope(report.independentTheorem.contract, root)
  )
    return {
      contract: validateContract(report.independentTheorem.contract),
      proof: report.independentTheorem.proof,
      inputs: [report.root, report.independentTheorem.artifact].filter(Boolean),
    };
  const { graph, steps, assembly } = report;
  if (
    !graph ||
    !assembly?.connectionProof ||
    !assembly.connection ||
    !kernelAccepted(assembly.check, assembly.connection) ||
    graph.steps.some((s) => !s.target)
  )
    return null;
  const expected = obligationContract(
    root,
    "RouteAssembly",
    root.leanTarget,
    graph.steps,
  );
  if (
    assembly.connection.leanTarget !== expected.leanTarget ||
    !sameTheoremScope(
      { ...assembly.connection, leanTarget: root.leanTarget },
      root,
    )
  )
    return null;
  const solved = new Map();
  for (const s of graph.steps) {
    const result = steps?.find((r) => r.name === s.name);
    const local = obligationContract(
      root,
      s.name,
      s.target,
      s.dependsOn.map((n) => graph.steps.find((d) => d.name === n)),
    );
    if (
      !result?.proof ||
      result.contract?.leanTarget !== local.leanTarget ||
      !kernelAccepted(result.check, result.contract)
    )
      return null;
    solved.set(s.name, {
      identity: digest({ target: s.target, dependsOn: s.dependsOn }),
      contract: result.contract,
      proof: result.proof,
    });
  }
  const body = { ...root };
  for (const k of [
    "schemaVersion",
    "imports",
    "domainContext",
    "domainArtifact",
  ])
    if (assembly.connection[k] !== undefined) body[k] = assembly.connection[k];
  delete body.targetHash;
  const contract = validateContract({ ...body, targetHash: digest(body) });
  return {
    contract,
    proof: composeDecomposition(
      { parts: graph.steps, assembly: assembly.connectionProof },
      solved,
      assembly.connection,
    ),
    inputs: [
      report.root,
      assembly.artifact,
      ...steps.map((s) => s.artifact),
    ].filter(Boolean),
  };
}
