// Candidate discovery only. Compiler metadata supplies qualified names when
// available; source fallback never establishes an import or mathematical fact.
export function maskLeanCommentsAndStrings(source) {
  const out = source.split("");
  let block = 0,
    line = false,
    string = false,
    escaped = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i],
      next = source[i + 1];
    if (line) {
      if (c === "\n") line = false;
      else out[i] = " ";
      continue;
    }
    if (block) {
      if (c === "/" && next === "-") {
        out[i] = out[i + 1] = " ";
        block++;
        i++;
      } else if (c === "-" && next === "/") {
        out[i] = out[i + 1] = " ";
        block--;
        i++;
      } else if (c !== "\n" && c !== "\r") out[i] = " ";
      continue;
    }
    if (string) {
      if (c !== "\n" && c !== "\r") out[i] = " ";
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') string = false;
      continue;
    }
    if (c === "-" && next === "-") {
      out[i] = out[i + 1] = " ";
      i++;
      line = true;
    } else if (c === "/" && next === "-") {
      out[i] = out[i + 1] = " ";
      i++;
      block = 1;
    } else if (c === '"') {
      out[i] = " ";
      string = true;
    }
  }
  return out.join("");
}
const header =
  /^\s*(?:@\[[^\]]*\]\s*)*((?:(?:public|protected|noncomputable|private|unsafe|partial)\s+)*)(def|abbrev|theorem|lemma|structure|class|opaque|axiom|instance)\s+([^\s:({]+)/u;
const identifier =
  /^(?:_root_\.)?[\p{L}_][\p{L}\p{N}_'\u2080-\u2089]*(?:\.[\p{L}_][\p{L}\p{N}_'\u2080-\u2089]*)*$/u;
const fields = (file) => ({
  file,
  module: file.slice(0, -5).replaceAll("/", "."),
});
export function sourceDeclarations(source, file) {
  const raw = source.split("\n"),
    lines = maskLeanCommentsAndStrings(source).split("\n"),
    stack = [],
    entries = [];
  let ns = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let m;
    if ((m = /^namespace\s+([^\s]+)\s*$/.exec(line)) && identifier.test(m[1])) {
      stack.push({ name: m[1], namespace: ns });
      ns = m[1].startsWith("_root_.")
        ? m[1].slice(7).split(".")
        : ns.concat(m[1].split("."));
      continue;
    }
    if (
      /^(?:noncomputable\s+)?section(?:\s+[^\s]+)?\s*$/.test(line) ||
      line === "mutual"
    ) {
      stack.push({ name: line.split(/\s+/).at(-1), namespace: ns });
      continue;
    }
    if (/^end(?:\s+[^\s]+)?\s*$/.test(line)) {
      const frame = stack.pop();
      if (frame) ns = frame.namespace;
      continue;
    }
    m = header.exec(lines[i]);
    if (!m || /\bprivate\b/.test(m[1]) || !identifier.test(m[3])) continue;
    const literal = m[3],
      name = literal.startsWith("_root_.")
        ? literal.slice(7)
        : [...ns, literal].join(".");
    if (name.startsWith("_")) continue;
    entries.push({
      ...fields(file),
      name,
      sourceName: literal,
      kind: m[2],
      line: i + 1,
      snippet: raw[i],
      nameOrigin: "source_scope_candidate",
    });
  }
  return entries;
}
export function compilerDeclarations(metadata, source, file) {
  const module = fields(file).module,
    raw = source.split("\n");
  if (
    metadata?.version !== 5 ||
    metadata.module !== module ||
    !metadata.decls ||
    typeof metadata.decls !== "object" ||
    Array.isArray(metadata.decls)
  )
    throw Error("Compiler declaration metadata identity/format mismatch");
  const entries = [];
  for (const [name, range] of Object.entries(metadata.decls)) {
    if (name.startsWith("_") || !identifier.test(name)) continue;
    if (
      !Array.isArray(range) ||
      range.length !== 8 ||
      range.some((v) => !Number.isInteger(v) || v < 0) ||
      range[0] > range[4] ||
      range[4] > range[2] ||
      range[2] >= raw.length
    )
      throw Error("Compiler declaration source range mismatch");
    const line = range[4],
      base = name.split(".").at(-1);
    // Generated declarations without a literal source site remain discoverable
    // through their parent but are not presented as exact source declarations.
    if (!raw[line].includes(base)) continue;
    const kind =
      header.exec(
        maskLeanCommentsAndStrings(raw.slice(range[0], line + 1).join("\n")),
      )?.[2] || "declaration";
    entries.push({
      ...fields(file),
      name,
      sourceName: base,
      kind,
      line: line + 1,
      snippet: raw[line],
      nameOrigin: "lean_compiler_metadata",
    });
  }
  return entries;
}
