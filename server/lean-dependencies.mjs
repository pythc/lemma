// Trusted instrumentation, never interpolated from model generated commands.
// Names come from the elaborated proof, not from a textual tactic scan.
export function dependencyCommand(
  requiredBinders = 0,
  { outputFile = null } = {},
) {
  if (outputFile !== null && outputFile !== "Dependencies.json")
    throw Error("Untrusted dependency output path");
  if (
    !Number.isInteger(requiredBinders) ||
    requiredBinders < 0 ||
    requiredBinders > 128
  )
    throw Error("Invalid dependency binder count");
  return `
open Lean Elab Command in
run_cmd do
  let env := (← getEnv).setExporting false
  let some root := env.find? \`LemmaReview.checked | throwError "missing checked theorem"
  let some value := root.value? (allowOpaque := true) | throwError "missing checked proof"
  let ctorField (ctor : Name) (i : Nat) (e : Expr) : Option Expr := do
    let .const name _ := e.getAppFn | none
    if name != ctor then none else do
      let some (.ctorInfo ci) := env.find? name | none
      let args := e.getAppArgs
      args[ci.numParams + i]?
  let rec live (e : Expr) : Expr :=
    match e with
    | .letE n t v b nd =>
      let b := live b
      if !b.hasLooseBVar 0 then b.lowerLooseBVars 1 1
      else .letE n (live t) (live v) b nd
    | .app f a =>
      let f := live f
      let a := live a
      match f with
      | .lam _ _ b _ =>
        if !b.hasLooseBVar 0 then b.lowerLooseBVars 1 1
        else .app f a
      | _ =>
        let result := Expr.app f a
        match result.getAppFn with
        | .const n _ =>
          match env.getProjectionFnInfo? n with
          | some pi =>
            let args := result.getAppArgs
            match args[pi.numParams]? with
            | some structExpr =>
              match ctorField pi.ctorName pi.i structExpr with
              | some field => mkAppN field (args.extract (pi.numParams + 1) args.size)
              | none => result
            | none => result
          | none => result
        | _ => result
    | .lam n t b bi => .lam n (live t) (live b) bi
    | .forallE n t b bi => .forallE n (live t) (live b) bi
    | .mdata _ b => live b
    | .proj n i b =>
      let b := live b
      match b.getAppFn with
      | .const c _ =>
        match env.find? c with
        | some (.ctorInfo ci) =>
          if ci.induct == n then (ctorField c i b).getD (.proj n i b)
          else .proj n i b
        | _ => .proj n i b
      | _ => .proj n i b
    | _ => e
  let liveValue := live value
  let direct := liveValue.getUsedConstants
  let mut todo := direct.toList
  let mut seen : NameSet := {}
  let mut missing : Array String := #[]
  let mut edges : Array (Name × Array Name) := #[]
  while !todo.isEmpty && seen.size < 100000 do
    let n := todo.head!
    todo := todo.tail!
    if seen.contains n then continue
    seen := seen.insert n
    match env.find? n with
    | none => missing := missing.push n.toString
    | some ci =>
      let deps := ci.getUsedConstantsAsSet.toArray
      edges := edges.push (n, deps)
      todo := deps.toList ++ todo
  let names := seen.toArray.qsort Name.lt
  let mut indices : NameMap Nat := {}
  for i in [:names.size] do
    indices := indices.insert names[i]! i
  let coded := edges.map fun (n, deps) =>
    Json.arr #[toJson (indices.find? n), toJson (deps.map fun d => indices.find? d)]
  let directTheorems := direct.filter fun n => match env.find? n with
    | some (.thmInfo _) => true
    | _ => false
  let mut body := liveValue
  let mut count := 0
  for _ in [:${requiredBinders}] do
    match body with
    | .lam _ _ b _ => body := b; count := count + 1
    | _ => pure ()
  let used := (List.range count).map fun i => body.hasLooseBVar (count - 1 - i)
  let report := Json.mkObj [
    ("direct", toJson (direct.map Name.toString)),
    ("names", toJson (names.map Name.toString)),
    ("edges", Json.arr coded),
    ("theorems", toJson (directTheorems.map Name.toString)),
    ("missing", toJson missing),
    ("complete", toJson (todo.isEmpty && missing.isEmpty)),
    ("requiredBinders", toJson (${requiredBinders} : Nat)),
    ("binderUse", toJson used),
    ("usePolicy", toJson ("live_lets_arguments_and_projections_v4" : String))]
  ${outputFile ? 'liftIO <| IO.FS.writeFile "Dependencies.json" report.compress' : 'logInfo m!"LEMMA_DEPENDENCIES:{report.compress}"'}
`;
}

export function parseDependencies(stdout) {
  const line = stdout
    .split("\n")
    .find((s) => s.startsWith("LEMMA_DEPENDENCIES:"));
  if (!line) return { complete: false, reason: "dependency_audit_missing" };
  try {
    const r = JSON.parse(line.slice("LEMMA_DEPENDENCIES:".length));
    if (
      !Array.isArray(r.direct) ||
      !Array.isArray(r.edges) ||
      !Array.isArray(r.binderUse)
    )
      throw Error("Malformed dependency audit");
    if (Array.isArray(r.names)) {
      r.edges = r.edges.map(([n, deps]) => [
        r.names[n] || "<unexpanded>",
        deps.map((i) => (i === null ? "<unexpanded>" : r.names[i])),
      ]);
      delete r.names;
    }
    return r;
  } catch {
    return { complete: false, reason: "dependency_audit_invalid" };
  }
}

export function auditDependencies(check, policy = {}, requiredBinders = 0) {
  const d = check.dependencies;
  const names = new Set((d?.edges || []).map((e) => e[0]));
  const forbidden = policy.forbiddenDeclarations || [];
  const families = policy.forbiddenFamilies || [];
  const hits = [...names].filter(
    (n) =>
      forbidden.includes(n) ||
      families.some((f) => n.toLowerCase().includes(f.toLowerCase())),
  );
  const ignoredDependencies = Array.from(
    { length: requiredBinders },
    (_, i) => i,
  ).filter((i) => d?.binderUse?.[i] !== true);
  const prohibitedAxioms = (check.axioms || []).filter((a) =>
    (policy.forbiddenAxioms || []).includes(a),
  );
  return {
    status:
      !d?.complete || ignoredDependencies.length
        ? "unresolved"
        : hits.length || prohibitedAxioms.length
          ? "route_violation"
          : "passed",
    hits,
    prohibitedAxioms,
    ignoredDependencies,
    complete: d?.complete === true,
    equivalenceCoverage:
      "declared_names_and_known_families_not_all_mathematical_equivalences",
  };
}

export function auditAssemblyDependencies(check, policy, steps) {
  const base = auditDependencies(check, policy);
  const used = steps
    .filter((_, i) => check.dependencies?.binderUse?.[i] === true)
    .map((s) => s.name);
  const reachable = new Set();
  const visit = (name) => {
    if (reachable.has(name)) return;
    reachable.add(name);
    steps.find((s) => s.name === name)?.dependsOn.forEach(visit);
  };
  used.forEach(visit);
  const missingSourceSteps = steps
    .filter((s) => !reachable.has(s.name))
    .map((s) => s.name);
  return {
    ...base,
    status:
      base.status === "passed" && missingSourceSteps.length
        ? "unresolved"
        : base.status,
    usedAssemblySteps: used,
    missingSourceSteps,
  };
}

// Local obligations can declare both a fact and its ancestor. The assembled
// proof obtains the former from the latter; do not require redundant direct
// mentions of every ancestor inside the local proof term.
export function auditScopedDependencies(
  check,
  policy,
  dependencies,
  graph = dependencies,
) {
  const base = auditDependencies(check, policy);
  const reachable = new Set();
  const visit = (name) => {
    if (reachable.has(name)) return;
    reachable.add(name);
    graph.find((s) => s.name === name)?.dependsOn.forEach(visit);
  };
  dependencies.forEach((s, i) => {
    if (check.dependencies?.binderUse?.[i] === true) visit(s.name);
  });
  const ignoredDependencies = dependencies
    .map((_, i) => i)
    .filter((i) => !reachable.has(dependencies[i].name));
  return {
    ...base,
    ignoredDependencies,
    status:
      base.status === "passed" && ignoredDependencies.length
        ? "unresolved"
        : base.status,
  };
}

// A source inference is a closed implication. Its own antecedents may already
// state the facts established by preceding steps; unused GLOBAL helper aliases
// are then not a mathematical gap. Their provenance is checked when connecting
// the complete proof, using actual binder use rather than planned edges.
export function auditLocalInference(check, policy, dependencies) {
  const base = auditDependencies(check, policy);
  return {
    ...base,
    ignoredDependencies: dependencies
      .map((_, i) => i)
      .filter((i) => check.dependencies?.binderUse?.[i] !== true),
  };
}
export function actualStepGraph(graph, results) {
  return graph.steps.map((s) => ({
    name: s.name,
    dependsOn: s.dependsOn.filter(
      (_, i) =>
        results.find((r) => r.name === s.name)?.check?.dependencies
          ?.binderUse?.[i] === true,
    ),
  }));
}
