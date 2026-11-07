// Compiler text selects search terms; it never becomes a Lean command.
export function missingDeclarationQueries(diagnostic) {
  if (diagnostic?.category !== "unknown_declaration") return [];
  const names = [
    ...String(diagnostic.message || "").matchAll(
      /(?:Unknown (?:constant|identifier)|Invalid field|environment does not contain)\s+[`'"]([A-Za-z_][A-Za-z0-9_.]{1,79})[`'"]/gi,
    ),
  ].map((m) => m[1]);
  return [...new Set(names.flatMap((name) => [name, name.split(".").at(-1)]))]
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_.]{1,79}$/.test(name))
    .slice(0, 8);
}

export function mergePremises(existing, incoming, limit = 64) {
  const byName = new Map();
  // Newly resolved diagnostic matches take priority over broad initial hits.
  for (const entry of [...incoming, ...existing])
    if (entry.name && !byName.has(entry.name)) byName.set(entry.name, entry);
  return [...byName.values()].slice(0, limit);
}
