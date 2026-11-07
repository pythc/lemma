import path from "node:path";
import { FilesystemBackend } from "deepagents";

const reserved = (name) =>
  [
    "Task.json",
    "current-contract.json",
    "Goal.lean",
    "Goal.olean",
    "Goal.ilean",
    "Goal.olean.private",
    "Goal.olean.server",
  ].includes(name);
export class ProofFilesystemBackend extends FilesystemBackend {
  constructor(rootDir) {
    super({ rootDir, virtualMode: true });
  }
  resolvePath(key) {
    if (typeof key !== "string" || key.includes("\0"))
      throw Error("Invalid workspace path");
    if (key === this.cwd) key = "/";
    else if (key.startsWith(this.cwd + path.sep))
      key = key.slice(this.cwd.length);
    else if (
      /^\/(?:Users|private|home|tmp)\//.test(key) ||
      key.startsWith("/var/folders/")
    )
      throw Error(
        "Outside proof workspace; use /Scratch.lean or a path inside the current workspace",
      );
    return super.resolvePath(key);
  }
  mutable(key) {
    const relative = path.relative(this.cwd, this.resolvePath(key));
    if (reserved(relative.split(path.sep)[0]))
      throw Error(
        "Reserved proof task/goal file; use prepare_goal or add_mathlib_modules instead",
      );
  }
  async write(key, value) {
    try {
      this.mutable(key);
    } catch (error) {
      return { error: error.message };
    }
    return super.write(key, value);
  }
  async edit(key, oldString, newString, replaceAll = false) {
    try {
      this.mutable(key);
    } catch (error) {
      return { error: error.message };
    }
    return super.edit(key, oldString, newString, replaceAll);
  }
  async delete(key) {
    try {
      this.mutable(key);
    } catch (error) {
      return { error: error.message };
    }
    return super.delete(key);
  }
}
