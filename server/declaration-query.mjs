// Only signatures actually printed by Lean count as available. An error in one
// optional query must not erase successful queries or turn them into proofs.
export const validDeclarationQueryName = (name) =>
  typeof name === "string" &&
  /^[\p{L}_][\p{L}\p{N}_'₀-₉]*(?:\.[\p{L}_][\p{L}\p{N}_'₀-₉]*)*$/u.test(name);
export function declarationQueryResults(
  names,
  stdout,
  { executed = true } = {},
) {
  return names.map((name) => {
    if (!executed)
      return {
        name,
        status: "not_checked",
        signature: "",
        verifiedInEnvironment: false,
      };
    const marker = `LEMMA_DECL:${name}\n`,
      offset = stdout.indexOf(marker);
    const block =
      offset < 0
        ? ""
        : stdout
            .slice(offset + marker.length)
            .split("LEMMA_DECL:")[0]
            .trim();
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // New native queries bracket the command with success/end markers. Command
    // success, not its pretty-printed spelling (Nat may print ℕ), is authority.
    const success = `LEMMA_DECL_OK:${name}`;
    const end = `LEMMA_DECL_END:${name}`;
    const hasNativeMarkers = block.includes(end);
    const diagnostic = block.split(end)[0].replace(success, "").trim();
    const available =
      !!block &&
      !/\berror(?:\([^)\n]*\))?:/.test(diagnostic) &&
      (hasNativeMarkers
        ? block.includes(success)
        : new RegExp(
            "^(?:(?:(?:protected|noncomputable|private)\\s+)*(?:def|abbrev|theorem|lemma|structure|class|opaque|axiom|instance)\\s+)?@?" +
              escaped +
              "(?:\\.\\{[^}\\n]*\\})?(?:\\s|:|$)",
          ).test(block));
    return {
      name,
      status: available ? "available" : block ? "query_failed" : "not_checked",
      signature: available ? diagnostic : "",
      diagnostic: available ? "" : diagnostic,
      verifiedInEnvironment: available,
    };
  });
}
