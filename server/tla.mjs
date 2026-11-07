import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded } from "./lean.mjs";
import { sha256 } from "./evidence.mjs";
import {
  tlaConfigChecksProperty,
  tlaConfigDisablesDeadlock,
  tlaConfigNarrowsSearch,
  tlaConfigVacuousProperty,
} from "../shared/cs-track.mjs";

export const TLA_PIN = Object.freeze({
  version: "1.7.4",
  jarSha256:
    "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
  jarSha1: "bee4a54f3ee3d4afc347c3240ec2d9e93b075104",
});

const root = fileURLToPath(new URL("../", import.meta.url));
const jarPath = path.join(root, ".tools", "tla", "tla2tools-1.7.4.jar");
const MODULE = /----\s*MODULE\s+Paper\s*----/;
const BOUND_JAVA = `import java.nio.file.*;
public class BoundReport {
  public static void main(String[] args) throws Exception {
    int bound = Integer.parseInt(args[0]);
    String log = "";
    if (args.length > 1 && Files.exists(Path.of(args[1])))
      log = Files.readString(Path.of(args[1]));
    System.out.println("BOUND " + bound);
    System.out.println("UNCHECKED beyond the bound");
    if (log.contains("unexpected exception") || log.contains("semantic analysis failed"))
      System.out.println("STATUS incomplete");
    else if (log.contains("Deadlock reached")) System.out.println("STATUS stuck");
    else if (log.contains("were violated") || log.contains("is violated"))
      System.out.println("STATUS violated");
    else if (log.contains("states checked") && log.contains("Finished"))
      System.out.println("STATUS no-error");
    else System.out.println("STATUS incomplete");
  }
}
`;

let runtimePromise;

function tlaOutcome(text) {
  const body = String(text || "");
  const deadlock = /Deadlock reached/.test(body);
  const temporal = /were violated/.test(body);
  const violated = temporal || /is violated/.test(body);
  const counterexample = deadlock || violated;
  const crashed =
    /unexpected exception|semantic analysis failed|\*\*\*Parse Error\*\*\*/.test(
      body,
    );
  const finished = /Finished in /.test(body) && /states checked/.test(body);
  return {
    counterexample,
    deadlock,
    temporal,
    crashed,
    ok: finished && !counterexample && !crashed,
  };
}

async function resolveMake() {
  for (const candidate of [
    "/Library/Developer/CommandLineTools/usr/bin/make",
    "/usr/bin/make",
  ]) {
    const resolved = await realpath(candidate).catch(() => "");
    if (resolved) return resolved;
  }
  return "/usr/bin/make";
}

async function loadRuntime() {
  let jar = "";
  try {
    const bytes = await readFile(jarPath);
    if (sha256(bytes) === TLA_PIN.jarSha256) jar = await realpath(jarPath);
  } catch {
    jar = "";
  }
  if (!jar)
    return { ready: false, reason: `固定的 TLA+ ${TLA_PIN.version} 工具包尚未安装。` };
  const javaCandidates = [
    "/opt/homebrew/opt/openjdk@21/bin/java",
    "/opt/homebrew/opt/openjdk/bin/java",
    "/usr/bin/java",
  ];
  let java = "";
  let banner = "";
  for (const candidate of javaCandidates) {
    const version = await runBounded(candidate, ["-version"], {
      timeoutMs: 20000,
    }).catch(() => null);
    const text = `${version?.stdout || ""}\n${version?.stderr || ""}`;
    if (version && version.exitCode === 0 && /version/i.test(text)) {
      java = await realpath(candidate);
      banner = text;
      break;
    }
  }
  if (!java) return { ready: false, reason: "运行 TLA+ 需要本机 Java，目前没有可用的 Java。" };
  const javac = await realpath(path.join(path.dirname(java), "javac")).catch(() => "");
  if (!javac) return { ready: false, reason: "运行 TLA+ 需要 javac，目前没有找到。" };
  return {
    ready: true,
    version: TLA_PIN.version,
    jar,
    jarSha256: TLA_PIN.jarSha256,
    java,
    javac,
    prefix: path.dirname(path.dirname(java)),
    banner: banner.slice(0, 300),
  };
}

export function tlaRuntime() {
  runtimePromise ||= loadRuntime();
  return runtimePromise;
}

function sandboxProfile(directory, prefix, makeBinary, jarDir) {
  const quoted = (value) => JSON.stringify(value);
  return `(version 1)
    (deny default)
    (allow file-read-metadata)
    (allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/usr/bin")
      (subpath "/bin") (subpath "/System/Library") (subpath "/Library/Apple/System/Library")
      (subpath "/System/Volumes/Preboot") (subpath "/opt/homebrew")
      (subpath "/private/var/db/dyld") (subpath "/private/etc")
      (subpath ${quoted(prefix)}) (subpath ${quoted(jarDir)})
      (subpath ${quoted(path.dirname(makeBinary))})
      (subpath ${quoted(directory)}) (literal "/dev/null") (literal "/dev/urandom"))
    (allow file-write* (subpath ${quoted(directory)}) (literal "/dev/null"))
    (allow process-exec (literal ${quoted(makeBinary)})
      (subpath ${quoted(prefix)}) (subpath "/bin") (subpath "/usr/bin"))
    (allow process-fork)
    (allow signal)
    (allow sysctl-read)
    (deny network*)
    (allow network-inbound (local ip "localhost:*") (remote ip "localhost:*"))
    (allow network-outbound (local ip "localhost:*") (remote ip "localhost:*"))
    (allow network-bind (local ip "localhost:*"))`;
}

export async function checkTlaArtifact(source, { config, bound } = {}) {
  const commands = ["make check", "make bound"];
  if (!MODULE.test(String(source || "")))
    return {
      ready: false,
      make: "not_run",
      boundRecorded: false,
      counterexample: false,
      commands,
      reason: "TLA+ 模块名必须是 Paper，未运行。",
    };
  if (typeof config !== "string" || !config.trim())
    return {
      ready: false,
      make: "not_run",
      boundRecorded: false,
      counterexample: false,
      commands,
      reason: "没有 TLC 配置，未运行。",
    };
  if (!tlaConfigChecksProperty(config))
    return {
      ready: false,
      make: "not_run",
      boundRecorded: false,
      counterexample: false,
      commands,
      reason: "TLC 配置没有不变量或性质，未运行。",
    };
  if (tlaConfigDisablesDeadlock(config))
    return {
      ready: false,
      make: "not_run",
      boundRecorded: false,
      counterexample: false,
      commands,
      reason: "TLC 配置关闭了死锁检查，未运行。",
    };
  if (tlaConfigNarrowsSearch(config))
    return {
      ready: false,
      make: "not_run",
      boundRecorded: false,
      counterexample: false,
      commands,
      reason: "TLC 配置含有约束、对称或视图，会藏起一部分行为，未运行。",
    };
  if (tlaConfigVacuousProperty(config, source))
    return {
      ready: false,
      make: "not_run",
      boundRecorded: false,
      counterexample: false,
      commands,
      reason: "TLC 要检查的不变量或性质恒为 TRUE，没有检查规格，未运行。",
    };
  if (!Number.isInteger(bound) || bound < 1 || bound > 20)
    return {
      ready: false,
      make: "not_run",
      boundRecorded: false,
      counterexample: false,
      commands,
      reason: "搜索界必须是 1 到 20 的整数，未运行。",
    };
  const runtime = await tlaRuntime();
  if (!runtime.ready)
    return {
      ready: false,
      make: "unavailable",
      boundRecorded: false,
      counterexample: false,
      commands,
      version: null,
      reason: runtime.reason,
    };
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "lemma-tla-")));
  const java = runtime.java;
  const makefile = `check:\n\t"${java}" -XX:+UseParallelGC -cp "${runtime.jar}" tlc2.TLC -workers 1 -seed 1 -depth ${bound} -simulate num=1 -config Paper.cfg Paper.tla > check.log 2>&1; code=$$?; cat check.log; exit $$code\nbound:\n\t"${runtime.javac}" -encoding UTF-8 -d . BoundReport.java\n\t"${java}" -cp . BoundReport ${bound} check.log\n`;
  await writeFile(path.join(directory, "Paper.tla"), source, { mode: 0o600 });
  await writeFile(path.join(directory, "Paper.cfg"), config, { mode: 0o600 });
  await writeFile(path.join(directory, "BoundReport.java"), BOUND_JAVA, { mode: 0o600 });
  await writeFile(path.join(directory, "Makefile"), makefile, { mode: 0o600 });
  const makeBinary = await resolveMake();
  const profile = sandboxProfile(
    directory,
    runtime.prefix,
    makeBinary,
    path.dirname(runtime.jar),
  );
  const runMake = (target) =>
    runBounded(
      "/usr/bin/sandbox-exec",
      ["-p", profile, makeBinary, "-C", directory, target],
      {
        cwd: directory,
        env: {
          PATH: `${path.dirname(java)}:/usr/bin:/bin`,
          HOME: directory,
          TMPDIR: directory,
          LANG: "C.UTF-8",
        },
        timeoutMs: 180000,
        maxOutput: 2_000_000,
        maxMemoryMiB: 2048,
      },
    );
  const check = await runMake("check");
  const checkText = `${check.stdout}\n${check.stderr}`;
  const parsed = tlaOutcome(checkText);
  const boundRun = await runMake("bound");
  const boundText = `${boundRun.stdout}\n${boundRun.stderr}`;
  const boundRecorded =
    boundRun.exitCode === 0 &&
    boundText.includes(`BOUND ${bound}`) &&
    boundText.includes("UNCHECKED beyond the bound");
  return {
    ready: true,
    make: parsed.ok ? "ok" : parsed.counterexample ? "counterexample" : "failed",
    bound,
    boundRecorded,
    counterexample: parsed.counterexample,
    deadlock: parsed.deadlock,
    temporal: parsed.temporal,
    commands,
    version: runtime.version,
    jarSha256: runtime.jarSha256,
    checkExcerpt: checkText.slice(0, 2000),
    boundExcerpt: boundText.slice(0, 2000),
    reason: parsed.counterexample
      ? "在搜索界内发现一条行为。"
      : parsed.ok
        ? null
        : parsed.crashed
          ? "TLC 在仿真中遇到异常，不能视为没有错误。"
          : "TLC 没有在搜索界内正常结束。",
  };
}

export function tlaColumns(result, located) {
  const boundText = !result.bound
    ? "未记录搜索界"
    : result.make === "failed"
      ? `搜索没有完成。深度不超过 ${result.bound} 层的其余行为也未检查`
      : `仿真 1 条行为，深度不超过 ${result.bound} 层，其余行为与更深处未检查`;
  return {
    make:
      result.make === "ok"
        ? "tlc check 在界内结束"
        : result.make === "counterexample"
          ? result.deadlock
            ? "tlc check 在界内发现一条无法继续的行为"
            : result.temporal
              ? "tlc check 在界内发现一条违反时序性质的行为"
              : "tlc check 在界内发现一条行为"
          : result.make === "unavailable" || result.make === "not_run"
            ? "tlc check 未运行"
            : "tlc check 失败",
    bound: result.boundRecorded || result.bound ? boundText : "未记录搜索界",
    correspondence: located
      ? `第 ${located.page.index + 1} 页：${located.quote}`
      : "语句没有唯一对应到原文",
    ...(traceExcerpt(result.checkExcerpt)
      ? { trace: traceExcerpt(result.checkExcerpt) }
      : {}),
  };
}

function traceExcerpt(text) {
  const body = String(text || "");
  const markers = [
    "The behavior up to this point is:",
    "The following behavior constitutes a counter-example:",
  ];
  let at = -1;
  for (const marker of markers) {
    const found = body.indexOf(marker);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return "";
  let slice = body.slice(at);
  const stop = slice.search(
    /\n(?:The number of states generated:|Progress:|Simulation using seed|Finished in |make:)/,
  );
  if (stop >= 0) slice = slice.slice(0, stop);
  return slice.trim().slice(0, 600);
}
