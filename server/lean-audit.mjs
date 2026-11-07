// Trusted instrumentation added after the parser-checked theorem. This is a
// separate machine receipt, not a regex over pretty-printed Lean diagnostics.
export function proofAuditCommand(contract, proofHash, mode) {
  return `
open Lean Elab Command in
run_cmd do
  let env := (← getEnv).setExporting false
  let some (.thmInfo root) := env.find? \`LemmaReview.checked
    | throwError "missing checked theorem declaration"
  let axioms ← Lean.collectAxioms \`LemmaReview.checked
  let report := Json.mkObj [
    ("schema", toJson ("lemma.kernel-audit.v1" : String)),
    ("declaration", toJson root.name.toString),
    ("kind", toJson ("theorem" : String)),
    ("typeRepr", toJson (reprStr root.type)),
    ("universes", toJson (root.levelParams.map Name.toString)),
    ("axioms", toJson (axioms.map Name.toString)),
    ("targetHash", toJson (${JSON.stringify(contract.targetHash)} : String)),
    ("proofHash", toJson (${JSON.stringify(proofHash)} : String)),
    ("mode", toJson (${JSON.stringify(mode)} : String))]
  liftIO <| IO.FS.writeFile "ProofAudit.json" report.compress
`;
}

export function validateProofAudit(audit, contract, proofHash, mode) {
  return (
    audit?.schema === "lemma.kernel-audit.v1" &&
    audit.declaration === "LemmaReview.checked" &&
    audit.kind === "theorem" &&
    typeof audit.typeRepr === "string" &&
    audit.typeRepr.length > 0 &&
    Array.isArray(audit.universes) &&
    audit.universes.every((u) => typeof u === "string") &&
    audit.targetHash === contract.targetHash &&
    audit.proofHash === proofHash &&
    audit.mode === mode &&
    Array.isArray(audit.axioms) &&
    audit.axioms.every(
      (a) => typeof a === "string" && contract.allowedAxioms.includes(a),
    )
  );
}
