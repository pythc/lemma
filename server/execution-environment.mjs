import { currentDomainRoot } from "./domain-library.mjs";
import { access } from "node:fs/promises";
import path from "node:path";
import { MATHLIB_ROOT } from "./libraries.mjs";
import {
  MATHLIB_COMMIT,
  LIBRARY_PROFILES,
  libraryProfile,
} from "../shared/library-profiles.mjs";
// Lex headers without treating comments or string literals as dependency requests.
export function leanImports(code) {
  let clean = "",
    depth = 0,
    string = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i],
      n = code[i + 1];
    if (depth) {
      if (c === "/" && n === "-") {
        depth++;
        i++;
      } else if (c === "-" && n === "/") {
        depth--;
        i++;
      } else if (c === "\n") clean += "\n";
      continue;
    }
    if (string) {
      if (c === "\\") i++;
      else if (c === '"') string = false;
      clean += c === "\n" ? "\n" : " ";
      continue;
    }
    if (c === "/" && n === "-") {
      depth++;
      i++;
      clean += " ";
    } else if (c === "-" && n === "-") {
      while (i < code.length && code[i] !== "\n") i++;
      clean += "\n";
    } else if (c === '"') {
      string = true;
      clean += " ";
    } else clean += c;
  }
  return [
    ...new Set(
      [
        ...clean.matchAll(
          /^\s*(?:public\s+|private\s+|meta\s+)?import\s+([^\n]+)/gm,
        ),
      ].flatMap((m) => m[1].trim().split(/\s+/)),
    ),
  ];
}
export function draftModules(code, modules = [], profile = "std-v1") {
  libraryProfile(profile);
  if (!Array.isArray(modules))
    throw Error("modules must be an array of pinned import names");
  return [
    ...new Set([
      ...modules,
      ...leanImports(code).filter((n) => /^Mathlib(?:\.|$)/.test(n)),
    ]),
  ];
}
export async function inspectExecutionEnvironment(imports = []) {
  if (
    !Array.isArray(imports) ||
    imports.length > 100 ||
    imports.some(
      (n) => typeof n !== "string" || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(n),
    )
  )
    throw Error("imports must be at most 100 module names");
  const currentRoot = await currentDomainRoot();
  const { binary, leanStatus } = await import("./lean.mjs");
  return {
    toolchain: await leanStatus(),
    revision: MATHLIB_COMMIT,
    profiles: LIBRARY_PROFILES,
    modules: await Promise.all(
      imports.map(async (name) => {
        if (!/^Mathlib(?:\.|$)/.test(name)) {
          const toolchainImport = /^(Std|Init|Lean)(\.|$)/.test(name);
          let present = false;
          if (toolchainImport)
            try {
              await access(
                path.join(
                  path.dirname(binary),
                  "../lib/lean",
                  name.replaceAll(".", "/") + ".olean",
                ),
              );
              present = true;
            } catch {}
          return {
            name,
            status: present
              ? "toolchain_import"
              : toolchainImport
                ? "missing_toolchain_import"
                : "not_prepared_by_pinned_mathlib",
            meaning: "File availability is not a type check",
          };
        }
        let installed = true;
        try {
          await access(
            path.join(
              currentRoot,
              ".lake/build/lib/lean",
              name.replaceAll(".", "/") + ".olean",
            ),
          );
        } catch {
          installed = false;
        }
        return {
          name,
          status: installed ? "present_not_yet_identity_checked" : "missing",
          prepare: { tool: "prepare_modules", arguments: { modules: [name] } },
        };
      }),
    ),
    scope: "inventory_not_proof; preparation verifies pinned identities",
  };
}
