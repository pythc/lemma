import { resolvePythonEnvironment } from "./python-environments.mjs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runBounded } from "./lean.mjs";
import { sha256 } from "./evidence.mjs";
import { ResourcePool } from "./resource-pool.mjs";

const pool = new ResourcePool(1);

export async function runNumericExperiment(
  workspace,
  code,
  {
    signal,
    timeoutMs = 60000,
    maxMemoryMiB = 512,
    files = [],
    environmentId,
  } = {},
) {
  if (typeof code !== "string" || !code.trim() || code.length > 64000)
    throw Error("Python experiment must contain at most 64000 characters");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000)
    throw Error("Invalid experiment timeout");
  if (!Number.isInteger(maxMemoryMiB) || maxMemoryMiB < 1 || maxMemoryMiB > 512)
    throw Error("Invalid experiment memory budget");
  return pool.run(
    async () => {
      const py = await resolvePythonEnvironment(environmentId),
        requestedDir = path.join(workspace, "experiments", randomUUID());
      await mkdir(requestedDir, { recursive: true, mode: 0o700 });
      const dir = await realpath(requestedDir);
      const file = path.join(dir, "experiment.py");
      await writeFile(file, code, { mode: 0o600 });
      for (const extra of files) {
        const folded = String(extra?.name || "").toLowerCase();
        if (!extra || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(extra.name))
          throw Error("附加文件名无效。");
        if (folded === "experiment.py") throw Error("附加文件不能替换主程序。");
        await writeFile(path.join(dir, extra.name), extra.content, {
          mode: 0o600,
        });
      }
      const q = JSON.stringify;
      const sandbox = `(version 1)(deny default)(allow file-read-metadata)
      (allow file-read* (literal "/") (subpath ${q(dir)}) (subpath ${q(py.prefix)}) ${py.basePrefix ? `(subpath ${q(py.basePrefix)})` : ""} (subpath "/System/Library") (subpath "/System/Volumes/Preboot") (subpath "/usr/lib") (subpath "/Library/Apple/System/Library") (subpath "/Library/Developer/CommandLineTools") (literal "/dev/null") (literal "/dev/urandom"))
      (allow file-write* (subpath ${q(dir)}) (literal "/dev/null"))
      (allow process-exec (subpath ${q(py.prefix)}) ${py.basePrefix ? `(subpath ${q(py.basePrefix)})` : ""})(allow process-fork)(allow sysctl-read)(deny network*)`;
      const bootstrap =
        "import os,resource,runpy,sys; resource.setrlimit(resource.RLIMIT_CPU,(120,120)); resource.setrlimit(resource.RLIMIT_FSIZE,(1048576,1048576)); resource.setrlimit(resource.RLIMIT_NOFILE,(128,128)); resource.setrlimit(resource.RLIMIT_NPROC,(16,16)); sys.path.insert(0, os.getcwd()); runpy.run_path('experiment.py',run_name='__main__')";
      const result = await runBounded(
        "/usr/bin/sandbox-exec",
        ["-p", sandbox, py.binary, "-I", "-B", "-c", bootstrap],
        {
          cwd: dir,
          env: {
            PATH: path.dirname(py.binary),
            HOME: dir,
            TMPDIR: dir,
            LANG: "C.UTF-8",
          },
          signal,
          timeoutMs,
          maxMemoryMiB,
          maxOutput: 200000,
        },
      );
      return {
        ...result,
        code,
        codeSha256: sha256(code),
        outputSha256: sha256(result.stdout || ""),
        pythonVersion: py.version,
        environmentId: py.environmentId || null,
        environmentContentSha256: py.contentSha256 || null,
        ...(/ModuleNotFoundError/.test(result.stderr)
          ? {
              guidance: {
                tool: "prepare_python_environment",
                reason:
                  "A package is absent from this isolated environment. Choose exact package versions or another approach; no installation was performed.",
              },
            }
          : {}),
        scope: "executed_finite_experiment_not_a_theorem_certificate",
        verified: false,
      };
    },
    { signal },
  );
}
