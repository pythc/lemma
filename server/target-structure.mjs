// Trusted instrumentation of the elaborated term. De Bruijn indices distinguish
// same-spelled binders; this does not infer a natural-language binding for them.
export const targetStructureCommand = `
namespace LemmaStructure
open Lean Meta
abbrev Scope := Array (FVarId × String × Bool)
def node (id : String) (name : Name) (kind role : String) (ty : Expr) (scope : Scope) : MetaM Json := do
  let typeText := (← ppExpr ty).pretty
  return Json.mkObj [("id",toJson id),("name",toJson name.toString),("kind",toJson kind),("role",toJson role),("type",toJson typeText),
    ("scope",toJson (scope.filterMap fun (_,id,q) => if q then some id else none)),
    ("typeDependencies",toJson (scope.filterMap fun (v,id,_) => if ty.containsFVar v then some id else none))]
partial def scan (e : Expr) (id : String) (scope : Scope) (inType : Bool) (fuel : Nat) : MetaM (Array Json) := do
  if fuel == 0 then return #[Json.mkObj [("id",toJson id),("role",toJson "unresolved")]]
  match e with
  | .forallE name ty body bi =>
    let premise ← isProp ty
    let role := if inType then "type_parameter" else if premise then "premise" else if bi == BinderInfo.default then "variable" else "implicit_parameter"
    let n ← node id name "forall" role ty scope
    let domains ← scan ty (id ++ ".type") scope true (fuel-1)
    let children ← withLocalDecl name bi ty fun x => scan (body.instantiate1 x) (id ++ ".body") (scope.push (x.fvarId!,id,role == "variable")) inType (fuel-1)
    return #[n] ++ domains ++ children
  | .app (.app (.const name _) ty) (.lam v _ body bi) =>
    if name.toString == "Exists" then
      let role := if inType then "type_parameter" else "variable"
      let n ← node id v "exists" role ty scope
      let domains ← scan ty (id ++ ".type") scope true (fuel-1)
      let children ← withLocalDecl v bi ty fun x => scan (body.instantiate1 x) (id ++ ".body") (scope.push (x.fvarId!,id,!inType)) inType (fuel-1)
      return #[n] ++ domains ++ children
    else
      e.getAppArgs.toList.zipIdx |>.foldlM (init := (← scan e.getAppFn (id ++ ".fn") scope inType (fuel-1))) fun acc (arg,i) => do
        return acc ++ (← scan arg (id ++ ".arg" ++ toString i) scope inType (fuel-1))
  | .app _ _ =>
    e.getAppArgs.toList.zipIdx |>.foldlM (init := (← scan e.getAppFn (id ++ ".fn") scope inType (fuel-1))) fun acc (arg,i) => do
      return acc ++ (← scan arg (id ++ ".arg" ++ toString i) scope inType (fuel-1))
  | .lam name ty body bi =>
    let n ← node id name "lambda" "lambda" ty scope
    let children ← withLocalDecl name bi ty fun x => scan (body.instantiate1 x) (id ++ ".body") (scope.push (x.fvarId!,id,false)) inType (fuel-1)
    return #[n] ++ children
  | .letE name ty val body _ =>
    let n ← node id name "let" "let" ty scope
    let values ← scan val (id ++ ".value") scope inType (fuel-1)
    let children ← withLetDecl name ty val fun x => scan (body.instantiate1 x) (id ++ ".body") (scope.push (x.fvarId!,id,false)) inType (fuel-1)
    return #[n] ++ values ++ children
  | .mdata _ body => scan body id scope inType (fuel-1)
  | .proj _ _ body => scan body (id ++ ".projection") scope inType (fuel-1)
  | .mvar _ | .bvar _ => return #[Json.mkObj [("id",toJson id),("role",toJson "unresolved")]]
  | _ => return #[]
end LemmaStructure
open Lean Elab Command in
run_cmd do
  let env := (← getEnv).setExporting false
  let some root := env.find? \`LemmaQuery.target | throwError "missing fixed target"
  let some value := root.value? (allowOpaque := true) | throwError "missing target expression"
  let raw := reprStr value
  let nodes ← liftTermElabM (LemmaStructure.scan value "root" #[] false 128)
  let data := Json.mkObj [("expression", toJson raw), ("constants", toJson (value.getUsedConstants.map Name.toString)), ("binders",Json.arr nodes)]
  logInfo ("LEMMA_TARGET_STRUCTURE:" ++ data.compress)
`;

export function parseTargetStructure(
  stdout,
  targetHash,
  environmentHash = null,
) {
  const line = stdout
    .split("\n")
    .find((l) => l.startsWith("LEMMA_TARGET_STRUCTURE:"));
  if (!line) return null;
  try {
    const value = JSON.parse(line.slice("LEMMA_TARGET_STRUCTURE:".length));
    if (
      typeof value.expression !== "string" ||
      !Array.isArray(value.constants) ||
      !Array.isArray(value.binders) ||
      value.binders.length > 512
    )
      return null;
    if (new Set(value.binders.map((n) => n.id)).size !== value.binders.length)
      return null;
    return {
      schemaVersion: "lemma.target-structure.v2",
      targetHash,
      environmentHash,
      ...value,
      complete: value.binders.every((n) => n.role !== "unresolved"),
      quantifiers: value.binders.filter((n) => n.role === "variable"),
      representation:
        "Lean elaborated Expr; bvar uses zero-based De Bruijn indices",
      authority: "formal_term_structure_not_source_fidelity_or_proof",
    };
  } catch {
    return null;
  }
}
