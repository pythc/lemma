import { digest, isHash } from "./evidence.mjs";
import { DOMAIN_LIMITS } from "./domain-schema.mjs";
import { MATHLIB_COMMIT } from "../shared/library-profiles.mjs";
import { verifyDomainModules } from "./domain-library.mjs";
import { validateContract } from "./contracts.mjs";

export function selectedReviewModules(artifacts, selection, { paperSha256 }) {
  const a = artifacts.get(selection?.artifact),
    v = a?.payload?.value;
  const source = artifacts.get(v?.identity?.sourceArtifact);
  if (
    a?.kind !== "adaptive:environment_probe" ||
    v?.identity?.paperSha256 !== paperSha256 ||
    v.identity.runId !== selection.parentReviewId ||
    v.identity.claimId !== selection.claimId ||
    !source ||
    source.payload?.value?.paperSha256 !== paperSha256 ||
    !a.inputs.includes(source.id) ||
    v.preparation?.status !== "ready" ||
    !Array.isArray(v.modules) ||
    digest(v.preparation.modules) !== digest(v.modules)
  )
    throw Error("Review environment receipt is foreign, unprepared or unbound");
  return v.modules;
}

export function selectedInspectionModules(
  artifacts,
  model,
  ids,
  { paperSha256, sourceArtifact },
) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > DOMAIN_LIMITS.modules ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !isHash(id))
  )
    throw Error("Invalid module preparation receipt selection");
  if (
    !["deepagents-js", "explicit_alignment_repair"].includes(model?.source) ||
    !isHash(model.harnessRoot) ||
    !model.harnessRunId
  )
    throw Error("Module selection requires its execution-owned report");
  const report = artifacts.get(model.harnessRoot);
  const repaired =
    model.source === "explicit_alignment_repair" &&
    report?.kind === "translation:alignment_repair";
  if (repaired) {
    const p = report.payload,
      failed = artifacts.get(p.rejectedHarness);
    const original = p.rejectedModel?.toolCalls;
    if (
      failed?.kind !== "harness:interrupted" ||
      failed.payload.runId !== model.harnessRunId ||
      !report.inputs.includes(failed.id) ||
      p.rejectedModel.finishReason !== "tool_calls" ||
      original?.length !== 1 ||
      digest(JSON.parse(original[0].function.arguments)) !==
        digest(p.rejectedProposal) ||
      digest({ ...p.rejectedProposal, alignment: null }) !==
        p.fixedFieldsHash ||
      digest({ ...p.result, alignment: null }) !== p.fixedFieldsHash
    )
      throw Error(
        "Alignment repair changed fixed submission or lost its received failure",
      );
  }
  if (
    (!repaired && report?.kind !== "harness:report") ||
    report.payload.runId !== model.harnessRunId
  )
    throw Error("Module selection report identity mismatch");
  const reachable = new Set();
  const walk = (id) => {
    if (reachable.has(id)) return;
    const a = artifacts.get(id);
    if (!a) throw Error("Missing module receipt ancestry");
    reachable.add(id);
    for (const parent of a.inputs) walk(parent);
  };
  walk(model.harnessRoot);
  const byName = new Map();
  for (const id of ids) {
    const a = artifacts.get(id),
      v = a?.payload;
    if (
      !reachable.has(id) ||
      a?.kind !== "harness:inspection_modules" ||
      v.runId !== model.harnessRunId ||
      v.paperSha256 !== paperSha256 ||
      v.sourceArtifact !== sourceArtifact ||
      !a.inputs.includes(sourceArtifact) ||
      v.preparation?.status !== "ready" ||
      !Array.isArray(v.modules) ||
      !Array.isArray(v.preparation.modules) ||
      digest(v.preparation.modules) !== digest(v.modules)
    )
      throw Error("Foreign, unprepared or source-mismatched module receipt");
    for (const m of v.modules) {
      if (byName.has(m.name) && digest(byName.get(m.name)) !== digest(m))
        throw Error("Conflicting pinned module identity");
      byName.set(m.name, m);
    }
  }
  if (byName.size > DOMAIN_LIMITS.modules)
    throw Error("Selected imports exceed the domain module limit");
  return [...byName.values()];
}

// Only module imports cross this bridge. Draft definitions and proofs remain
// diagnostic and cannot enter the mathematical contract by this path.
export async function bindTranslationModules(
  store,
  {
    model,
    ids = [],
    environmentSelection = null,
    paperSha256,
    sourceArtifact,
    contextArtifact,
    translationArtifact,
    signal,
    priorContract = null,
    priorContractArtifact = null,
  },
) {
  const artifacts = new Map();
  const roots = [
    ...(ids.length ? [model?.harnessRoot] : []),
    ...(environmentSelection ? [environmentSelection.artifact] : []),
  ];
  for (const root of roots)
    for (const a of (await store.bundle(root)).artifacts)
      artifacts.set(a.id, a);
  const selected = [
    ...(ids.length
      ? selectedInspectionModules(artifacts, model, ids, {
          paperSha256,
          sourceArtifact,
        })
      : []),
    ...(environmentSelection
      ? selectedReviewModules(artifacts, environmentSelection, { paperSha256 })
      : []),
  ];
  if (priorContract) {
    validateContract(priorContract);
    const saved = await store.get(priorContractArtifact);
    if (
      saved.kind !== "task:R05" ||
      digest(saved.payload) !== digest(priorContract) ||
      priorContract.paperSha256 !== paperSha256 ||
      priorContract.sourceArtifact !== sourceArtifact
    )
      throw Error("Prior translation environment identity mismatch");
    if (priorContract.executionEnvironment)
      throw Error(
        "Pinned modules require a compatible Mathlib execution environment",
      );
    if (
      priorContract.domainContext?.definitions.length ||
      priorContract.domainContext?.lemmas.length
    )
      throw Object.assign(
        Error(
          "New imports require domain recovery to recheck existing definitions and lemmas; preparation receipts remain recorded.",
        ),
        { requiresDomainRecovery: true },
      );
  }
  const union = new Map(
    (priorContract?.domainContext?.modules || []).map((m) => [m.name, m]),
  );
  for (const m of selected) {
    if (union.has(m.name) && digest(union.get(m.name)) !== digest(m))
      throw Error("Prior module identity changed");
    union.set(m.name, m);
  }
  const modules = [...union.values()];
  if (modules.length > DOMAIN_LIMITS.modules)
    throw Error("Combined module limit exceeded");
  await verifyDomainModules(modules, { signal });
  const plan = {
    queries: [],
    modules: modules.map((m) => m.name),
    definitions: [],
    lemmas: [],
  };
  const planArtifact = await store.put(
    "task:RDP",
    {
      plan,
      origin: "translation_execution_imports",
      model: ids.length ? model : null,
      moduleReceiptIds: ids,
      environmentSelection,
      paperSha256,
      sourceArtifact,
      priorContractArtifact,
    },
    [
      sourceArtifact,
      contextArtifact,
      translationArtifact,
      ...roots,
      ...ids,
      ...(priorContractArtifact ? [priorContractArtifact] : []),
    ],
  );
  const libraryArtifact = await store.put(
    "task:RDL",
    {
      status: "ready",
      modules,
      origin: "verified_prepared_translation_imports",
    },
    [
      planArtifact,
      ...ids,
      ...(environmentSelection ? [environmentSelection.artifact] : []),
    ],
  );
  const context = {
    schemaVersion: "lemma.domain.v1",
    revision: MATHLIB_COMMIT,
    modules,
    definitions: [],
    lemmas: [],
  };
  const artifact = await store.put(
    "domain_completion",
    {
      context,
      planArtifact,
      libraryArtifact,
      components: [],
      scope: "prepared_module_imports_not_new_definitions_or_proofs",
    },
    [planArtifact, libraryArtifact],
  );
  return { context, artifact };
}

export function inspectTranslationModulePlan(
  planArtifact,
  libraryArtifact,
  artifacts,
  identity,
) {
  if (planArtifact.payload.origin !== "translation_execution_imports") return;
  const { model, moduleReceiptIds, environmentSelection } =
    planArtifact.payload;
  const selected = [
    ...(moduleReceiptIds.length
      ? selectedInspectionModules(artifacts, model, moduleReceiptIds, identity)
      : []),
    ...(environmentSelection
      ? selectedReviewModules(artifacts, environmentSelection, identity)
      : []),
  ];
  if (!moduleReceiptIds.length && !environmentSelection)
    throw Error("Translation import plan has no preparation provenance");
  let priorContract = null;
  const union = new Map();
  if (planArtifact.payload.priorContractArtifact) {
    const prior = artifacts.get(planArtifact.payload.priorContractArtifact);
    if (prior?.kind !== "task:R05" || !planArtifact.inputs.includes(prior.id))
      throw Error("Prior module contract provenance missing");
    priorContract = validateContract(prior.payload);
    if (
      priorContract.paperSha256 !== identity.paperSha256 ||
      priorContract.sourceArtifact !== identity.sourceArtifact ||
      priorContract.domainContext?.definitions.length ||
      priorContract.domainContext?.lemmas.length ||
      priorContract.executionEnvironment
    )
      throw Error("Prior import scope is not module-only");
    for (const m of priorContract.domainContext?.modules || [])
      union.set(m.name, m);
  }
  for (const m of selected) {
    if (union.has(m.name) && digest(union.get(m.name)) !== digest(m))
      throw Error("Prior module replaced");
    union.set(m.name, m);
  }
  const modules = [...union.values()];
  if (
    (moduleReceiptIds.length &&
      !planArtifact.inputs.includes(model.harnessRoot)) ||
    (environmentSelection &&
      (!planArtifact.inputs.includes(environmentSelection.artifact) ||
        !libraryArtifact.inputs.includes(environmentSelection.artifact))) ||
    moduleReceiptIds.some(
      (id) =>
        !planArtifact.inputs.includes(id) ||
        !libraryArtifact.inputs.includes(id),
    ) ||
    digest(modules) !== digest(libraryArtifact.payload.modules)
  )
    throw Error("Translation module preparation provenance mismatch");
  return priorContract;
}
