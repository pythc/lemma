import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MATHLIB_ROOT } from "./libraries.mjs";
import { MATHLIB_COMMIT } from "../shared/library-profiles.mjs";
import { sha256 } from "./evidence.mjs";
const exec = promisify(execFile);

export function sourceWindow(text, { startLine = 1, lineCount = 160 } = {}) {
  if (
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    !Number.isInteger(lineCount) ||
    lineCount < 1 ||
    lineCount > 400
  )
    throw Error(
      "Source window requires startLine >= 1 and lineCount from 1 to 400",
    );
  const lines = text.split("\n");
  if (startLine > lines.length)
    throw Error("Source window starts beyond the last line");
  const endLine = Math.min(lines.length, startLine + lineCount - 1);
  const excerpt = lines.slice(startLine - 1, endLine).join("\n");
  if (excerpt.length > 64000)
    throw Error("Source window too large; reduce lineCount");
  return {
    sourceSha256: sha256(text),
    excerptSha256: sha256(excerpt),
    totalLines: lines.length,
    startLine,
    endLine,
    nextLine: endLine < lines.length ? endLine + 1 : null,
    text: excerpt,
    scope: "source_inspection_not_import_availability_or_proof_certificate",
  };
}

export async function readPinnedMathlibSource(module, options = {}) {
  options.signal?.throwIfAborted();
  if (
    typeof module !== "string" ||
    module.length > 180 ||
    !/^Mathlib(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(module)
  )
    throw Error("Use a pinned Mathlib module name, never a file path");
  // Validate paging before even opening the local repository.
  sourceWindow("", { startLine: 1, lineCount: options.lineCount ?? 160 });
  if (!Number.isInteger(options.startLine ?? 1) || (options.startLine ?? 1) < 1)
    throw Error("Invalid source startLine");
  const file = module.replaceAll(".", "/") + ".lean";
  const { stdout } = await exec(
    "/usr/bin/git",
    ["show", `${MATHLIB_COMMIT}:${file}`],
    {
      cwd: MATHLIB_ROOT,
      signal: options.signal,
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return {
    repo: "leanprover-community/mathlib4",
    revision: MATHLIB_COMMIT,
    module,
    file,
    acquisition: "local_immutable_git_object_no_network",
    ...sourceWindow(stdout, options),
  };
}
