import { digest } from "./evidence.mjs";
import { obligationContract, kernelAccepted } from "./proof-decomposition.mjs";
import { domainPrelude } from "./domain-schema.mjs";

export const interfacePrompt = `Review the WHOLE source proof as an executable proof blueprint before solving locals. Return JSON {graph:{steps,assembly,policy,methodClaims,limitations},changes:[{name,reason}],interfaces:[{from,to,role,bridge:"exact missing mathematical fact or none"}]}. Use the same graph schema and exact source anchors as the input. Keep the root proposition and source unchanged. A dependency is a universally quantified proven lemma, not its conclusion assumed true. Trace what each consumer ACTUALLY needs. In particular, ∀ s, P s ∨ Q s does NOT imply (∀ s, P s) ∨ (∀ s, Q s). Strengthen a local interface only with source-grounded justification and classify omitted reasoning explicitly. Prove/refute required bridges separately; never add assumptions, fabricate dummy dependency uses, or independently reprove a predecessor. Preserve verified interfaces when adequate; revise inadequate interfaces in a new graph version with concrete reasons. When an earlier interface was already reported unused, merely relabeling its bridge as omitted is NOT a repair. Either strengthen the producer interface to the uniform/case-indexed statement that its proof actually establishes and adjust the consumer, or construct a genuine bridge that uses the original producer. Do not duplicate a stronger proof in the consumer while ignoring the producer. Remove a bridge made redundant by a stronger producer, explaining where its source obligation moved. Supply a real conditional assembly using these interfaces, with no sorry. Redundant source steps must be explained, not forced into a decorative application. Every substantive source case must remain covered. No root theorem may be a local lemma. This plan will undergo a separate source-alignment review and native Lean checks; it is not itself a certificate.`;

export function proofBlueprint(graph, root, previous = null) {
  const parts = graph.steps.map((s) => {
    const dependencies = s.dependsOn.map((n) =>
      graph.steps.find((p) => p.name === n),
    );
    return {
      name: s.name,
      title: s.title,
      kind: s.kind,
      anchors: s.anchors,
      target: s.target,
      dependsOn: s.dependsOn,
      interfaceHash: digest({
        target: s.target,
        dependencies: dependencies.map((d) => ({
          name: d.name,
          target: d.target,
        })),
      }),
      contract:
        s.target && dependencies.every((d) => d.target)
          ? obligationContract(root, s.name, s.target, dependencies)
          : null,
      consumers: graph.steps
        .filter((p) => p.dependsOn.includes(s.name))
        .map((p) => p.name),
      previousInterfaceChanged: !!previous?.steps?.some(
        (p) =>
          p.name === s.name &&
          digest({ target: p.target, dependsOn: p.dependsOn }) !==
            digest({ target: s.target, dependsOn: s.dependsOn }),
      ),
    };
  });
  return {
    schemaVersion: "lemma.proof-blueprint.v1",
    rootTargetHash: root.targetHash,
    sourceArtifact: root.sourceArtifact,
    parts,
    assemblyContract: parts.every((p) => p.contract)
      ? obligationContract(root, "RouteAssembly", root.leanTarget, graph.steps)
      : null,
    // Named propositions form a readable Lean skeleton, never admissions.
    signatures:
      `${root.imports.map((n) => `import ${n}`).join("\n")}\nset_option autoImplicit false\n${domainPrelude(root.domainContext)}\nnamespace LemmaBlueprint\n` +
      parts
        .filter((p) => p.contract)
        .map(
          (p) =>
            `-- ${p.name}: ${p.title.replace(/\s+/g, " ")}\ndef Goal_${p.name} : Prop := (\n${p.contract.leanTarget}\n)`,
        )
        .join("\n\n") +
      "\nend LemmaBlueprint\n",
    status: "interfaces_pending_kernel_checks",
  };
}

export function unresolvedInterfaceLinks(graph, previous) {
  const missing =
    previous?.assembly?.audit?.missingSourceSteps ||
    previous?.assembly?.connectionAudit?.missingSourceSteps ||
    [];
  if (!missing.length || !previous?.graph) return [];
  const old = new Map(previous.graph.steps.map((s) => [s.name, s]));
  // A title, prose label or deletion of an unrelated decorative edge cannot fix
  // a known producer/consumer interface mismatch.
  const changed = new Set(
    graph.steps
      .filter((s) => {
        const p = old.get(s.name);
        return (
          !p ||
          p.target !== s.target ||
          digest(p.dependsOn) !== digest(s.dependsOn)
        );
      })
      .map((s) => s.name),
  );
  const removed = new Set(
    [...old.keys()].filter((n) => !graph.steps.some((s) => s.name === n)),
  );
  return missing.filter((name) => {
    const relevant = new Set([name]),
      live = new Set([name]);
    for (const s of previous.graph.steps) {
      for (const n of s.dependsOn.filter((n) => live.has(n))) {
        relevant.add(s.name);
        const actual = previous.steps?.find((p) => p.name === s.name)?.check
          ?.dependencies?.binderUse;
        if (!actual || actual[s.dependsOn.indexOf(n)] === true)
          live.add(s.name);
      }
    }
    return ![...relevant].some((n) => changed.has(n) || removed.has(n));
  });
}

export async function checkBlueprint(blueprint, checker, signal) {
  const checks = blueprint.parts
    .filter((p) => !p.contract)
    .map((p) => ({ name: p.name, status: "missing_target" }));
  const batches = [];
  let group = [],
    characters = 0;
  for (const p of blueprint.parts.filter((p) => p.contract)) {
    if (
      group.length &&
      (characters + p.contract.leanTarget.length > 60000 || group.length >= 32)
    ) {
      batches.push(group);
      group = [];
      characters = 0;
    }
    group.push(p);
    characters += p.contract.leanTarget.length;
  }
  if (group.length) batches.push(group);
  const batchChecks = [];
  for (const parts of batches) {
    const { targetHash, ...body } = parts[0].contract;
    body.label = "证明接口类型检查";
    body.leanTarget = parts
      .map((p) => `((show Prop from (${p.contract.leanTarget})) → True)`)
      .join(" ∧ ");
    body.proofObligation = {
      rootTargetHash: blueprint.rootTargetHash,
      name: "InterfacePreflight",
      dependencies: [],
    };
    const contract = { ...body, targetHash: digest(body) };
    const term = "(by intro _; trivial)";
    const proof = parts
      .slice(1)
      .reduceRight((t) => `(And.intro ${term} ${t})`, term);
    const check = await checker(contract, proof, { signal });
    batchChecks.push({ parts: parts.map((p) => p.name), contract, check });
    if (kernelAccepted(check, contract)) {
      checks.push(
        ...parts.map((p) => ({
          name: p.name,
          interfaceHash: p.interfaceHash,
          status: "well_typed",
          batchTargetHash: contract.targetHash,
        })),
      );
    } else {
      // Only a failed batch needs individual probes to locate the bad signature.
      for (const p of parts) {
        const { targetHash, ...local } = p.contract;
        local.leanTarget = `(show Prop from (${p.contract.leanTarget})) → True`;
        const probe = { ...local, targetHash: digest(local) };
        const detail = await checker(probe, "by intro _; trivial", { signal });
        checks.push({
          name: p.name,
          interfaceHash: p.interfaceHash,
          status: kernelAccepted(detail, probe) ? "well_typed" : "invalid",
          check: detail,
        });
      }
    }
  }
  checks.sort(
    (a, b) =>
      blueprint.parts.findIndex((p) => p.name === a.name) -
      blueprint.parts.findIndex((p) => p.name === b.name),
  );
  return {
    schemaVersion: "lemma.interface-preflight.v2",
    checks,
    batchChecks,
    status: checks.every((c) => c.status === "well_typed")
      ? "well_typed"
      : "incomplete",
    scope: "signature_well_formedness_only_not_implications_or_author_route",
  };
}

export async function checkBlueprintConnection(graph, root, checker, signal) {
  if (!graph.assembly || graph.steps.some((s) => !s.target))
    return {
      status: "missing_connection_or_target",
      scope: "conditional_connection_only",
    };
  const contract = obligationContract(
    root,
    "BlueprintAssembly",
    root.leanTarget,
    graph.steps,
  );
  const check = await checker(contract, graph.assembly, {
    signal,
    dependencyAudit: true,
    requiredBinders: graph.steps.length,
  });
  return {
    status: kernelAccepted(check, contract)
      ? "connected_conditionally"
      : "invalid_connection",
    contract,
    check,
    scope: "conditional_connection_only_not_proved_source_steps",
  };
}
