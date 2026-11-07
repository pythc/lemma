import { constants } from "node:fs";
import { cp, mkdir, readFile, realpath, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { inspectBundle, unpackPaperBundle, isHash, sha256 } from "./evidence.mjs";
import { readEvidenceFile } from "./evidence-io.mjs";
import { contentTree } from "./toolchain-tree.mjs";
import { libraryAccess } from "./library-access.mjs";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const codePaths = [".nvmrc", ".node-version", "evaluation/runtime.json", "server", "shared", "worker", "scripts", "fixtures", "package.json", "package-lock.json"];
const toolPaths = ["toolchain.json", "lean-4.35.0-darwin_aarch64", "mathlib-library.json",
  "mathlib4-4.35.0", "library-snapshots", "domain-cache-history", "environments", "external-libraries"];

async function clone(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  // APFS clones have distinct inodes; no mutable runtime data is hard-linked.
  await execute("/bin/cp", ["-cR", source, destination]);
}

async function checkIsolation(profile, project, original, output) {
  const listener = createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  // The listener is live and the old file exists before the sandbox probe.
  await access(path.join(original, "package.json"));
  const code = `
    const fs = require("node:fs"), net = require("node:net");
    let read;
    try { fs.readFileSync(process.argv[1]); read = "allowed"; } catch(e) { read = e.code; }
    const socket = net.connect({host: "127.0.0.1", port: Number(process.argv[2])});
    const done = (network) => { socket.destroy(); console.log(JSON.stringify({read,network})); };
    socket.once("connect", () => done("allowed"));
    socket.once("error", e => done(e.code));
    socket.setTimeout(3000, () => done("timeout"));
  `;
  try {
    const { stdout } = await execute("/usr/bin/sandbox-exec", ["-p", profile,
      process.execPath, "-e", code, path.join(original, "package.json"), String(port)],
      { cwd: project, timeout: 8000, maxBuffer: 65536,
        env: { PATH: "/usr/bin:/bin", HOME: path.join(project, ".home") } });
    const result = JSON.parse(stdout);
    await writeFile(path.join(output, "isolation-canary.json"), JSON.stringify(result, null, 2), { flag: "wx" });
    if (![result.read, result.network].every((v) => ["EPERM", "EACCES"].includes(v)))
      throw Error("独立回放的原目录或网络隔离实测未通过。");
    return result;
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
}

export async function cleanReplay(file, expectedRoot, output, { timeoutMs = 30 * 60_000 } = {}) {
  if (!isHash(expectedRoot)) throw Error("独立回放必须提供来自归档的 expected-root。");
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw Error("当前原生独立回放只验收了 macOS arm64。");
  output = path.resolve(output);
  if (output === path.resolve(appRoot) || output.startsWith(path.resolve(appRoot) + path.sep))
    throw Error("独立回放输出必须位于原项目目录之外，以验证无法读取原项目。");
  // Do not overwrite an earlier successful OR failed attempt.
  await mkdir(output, { recursive: false, mode: 0o700 });
  const report = {
    schemaVersion: "lemma.clean-replay.v1", expectedRoot,
    startedAt: new Date().toISOString(), integrity: false,
    modelDispatch: "disabled", network: "os_sandbox_denied",
    applicationState: "new_empty_directory", reproduced: false, revalidated: false,
  };
  try {
    const bundle = await readEvidenceFile(file);
    inspectBundle(bundle.schemaVersion === "lemma.paper-evidence.v1" ? unpackPaperBundle(bundle) : bundle, expectedRoot);
    report.integrity = true;
    const project = path.join(output, "project");
    await mkdir(project);
    await mkdir(path.join(project, ".runtime"));
    await mkdir(path.join(project, ".home"));
    await mkdir(path.join(output, "tmp"));
    for (const relative of codePaths)
      await clone(path.join(appRoot, relative), path.join(project, relative));
    await clone(await realpath(path.join(appRoot, "node_modules")), path.join(project, "node_modules"));
    await libraryAccess.read(async () => {
      for (const relative of toolPaths) {
        const source = path.join(appRoot, ".tools", relative);
        try { await access(source); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
        await clone(source, path.join(project, ".tools", relative));
      }
    });
    const evidence = path.join(output, file.endsWith(".ndjson") ? "input.ndjson" : "input.json");
    await cp(file, evidence, { mode: constants.COPYFILE_FICLONE, errorOnExist: true, force: false });
    report.evidenceFileSha256 = sha256(await readFile(evidence));
    report.code = await contentTree(project, codePaths, { includeFiles: true });
    report.node = { version: process.version, binarySha256: sha256(await readFile(process.execPath)) };
    // The old project cannot be read, so accidental absolute paths fail instead
    // of masking missing files in this independent checkout.
    // macOS cannot apply a second Seatbelt profile to an already sandboxed
    // process. Only the trusted sandbox-exec launcher starts with a fresh
    // profile; it immediately applies the existing deny-default Lean sandbox.
    const profile = `(version 1)(allow default)(deny network*)(deny file-read* (subpath ${JSON.stringify(await realpath(appRoot))}))(allow process-exec (literal "/usr/bin/sandbox-exec") (with no-sandbox))`;
    await writeFile(path.join(output, "sandbox.sb"), profile);
    report.isolation = await checkIsolation(profile, project, await realpath(appRoot), output);
    const resultFile = path.join(output, "replay.json");
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, process.execPath,
      "scripts/replay.mjs", evidence, `--expected-root=${expectedRoot}`, `--output=${resultFile}`], {
      cwd: project, stdio: ["ignore", "pipe", "pipe"], detached: true,
      env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: "en_US.UTF-8",
        HOME: path.join(project, ".home"), TMPDIR: path.join(output, "tmp"), LEMMA_REPLAY_OFFLINE: "1" },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => { stdout = (stdout + b.toString()).slice(-1_000_000); });
    child.stderr.on("data", (b) => { stderr = (stderr + b.toString()).slice(-1_000_000); });
    const timer = setTimeout(() => {
      report.timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (e) { if (e.code !== "ESRCH") child.kill("SIGKILL"); }
    }, timeoutMs);
    try {
      report.process = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (exitCode, signal) => resolve({ pid: child.pid, exitCode, signal }));
      });
    } finally {
      clearTimeout(timer);
      await writeFile(path.join(output, "stdout.log"), stdout);
      await writeFile(path.join(output, "stderr.log"), stderr);
    }
    report.result = JSON.parse(await readFile(resultFile, "utf8"));
    report.reproduced = report.process.exitCode === 0 && report.result.reproduced === true;
    report.revalidated = report.result.revalidated === true;
    report.sameEnvironment = report.result.sameEnvironment === true;
  } catch (e) {
    report.error = { code: e.code || null, message: e.message };
  }
  report.endedAt = new Date().toISOString();
  await writeFile(path.join(output, "result.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return report;
}
