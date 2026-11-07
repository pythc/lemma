import { finalizeTeamPaper } from "../server/team/finalization.mjs";
import {
  evidenceArtifacts,
  writeEvidenceFile,
} from "../server/evidence-io.mjs";
import { evaluationInventory } from "../server/team/evaluation-report.mjs";
import { nativeResourcePolicy } from "../server/resources/native-policy.mjs";
// Raw-PDF-only product acceptance. No paper-specific goals, lemmas or proofs.
import {
  readFile,
  writeFile,
  appendFile,
  mkdir,
  readdir,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.mjs";
import { sha256 } from "../server/evidence.mjs";
import { objectiveResolved } from "../server/team/objectives.mjs";
import { forkCheckpoint } from "../server/team/checkpoint.mjs";
const project = fileURLToPath(new URL("../", import.meta.url));
const [pdfPath, outArg, ...extra] = process.argv.slice(2);
if (
  extra.length &&
  (![3, 5].includes(extra.length) ||
    extra[0] !== "--continue" ||
    (extra.length === 5 && extra[3] !== "--user-pause-record"))
)
  throw Error("Continuation arguments: --continue parent-store run-id");
const [, parentStore, parentRunId, , pauseRecordPath] = extra;
const pauseAuthorization = pauseRecordPath
  ? JSON.parse(await readFile(pauseRecordPath, "utf8"))
  : null;
if (!pdfPath || !outArg)
  throw Error(
    "Usage: node scripts/evaluate-team-paper.mjs raw.pdf empty-output-directory",
  );
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length)
  throw Error("A new empty output directory is required");
async function fingerprints() {
  const files = {};
  async function visit(dir) {
    for (const e of await readdir(path.join(project, dir), {
      withFileTypes: true,
    })) {
      const name = path.join(dir, e.name);
      if (e.isDirectory()) await visit(name);
      else if (/\.(mjs|js|jsx|css|json|py|lean|toml|html)$/.test(e.name))
        files[name] = sha256(await readFile(path.join(project, name)));
    }
  }
  for (const dir of ["server", "shared", "src", "scripts", "worker"])
    await visit(dir);
  for (const file of [
    "package.json",
    "package-lock.json",
    "AGENTS.md",
    "vite.config.mjs",
    "index.html",
  ])
    files[file] = sha256(await readFile(path.join(project, file)));
  return files;
}
const freeze = await fingerprints();
await writeFile(
  path.join(out, "implementation-freeze.json"),
  JSON.stringify(freeze, null, 2),
);
const pdf = await readFile(pdfPath);
await writeFile(path.join(out, "input.pdf"), pdf);
const continuation = parentStore
  ? await forkCheckpoint({
      sourceRoot: parentStore,
      destinationRoot: path.join(out, "store"),
      runId: parentRunId,
      paperSha256: sha256(pdf),
      claimRoot: path.join(project, ".tools", "team-continuations"),
      pauseAuthorization,
    })
  : null;
const cli = (await promisify(execFile)("codex", ["--version"])).stdout.trim();
const uiBaseUrl = new URL(
  process.env.LEMMA_UI_BASE_URL || "http://127.0.0.1:4178",
);
if (
  uiBaseUrl.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(uiBaseUrl.hostname)
)
  throw Error(
    "The evaluation reader must use an explicit loopback HTTP origin",
  );
const app = await createApp({
  dataRoot: path.join(out, "store"),
  origins: [uiBaseUrl.origin],
});
await new Promise((resolve, reject) => {
  app.server.once("error", reject);
  app.server.listen(
    Number(process.env.LEMMA_PORT || 4179),
    "127.0.0.1",
    resolve,
  );
});
const port = app.server.address().port;
const input = {
  orchestration: "team",
  pdfBase64: pdf.toString("base64"),
  title: path.basename(pdfPath),
  intent:
    "请自主评审这篇论文的主要数学结论及作者证明。自行阅读全文、选择形式化知识库、拆解任务、构造必要定义与引理、协作、修复失败，并由独立验收 Agent 检查成果。尽可能用 Lean 验证；明确区分原文对应关系、精确命题证明、条件性证明、原证明路线和未完成内容。",
};
await writeFile(
  path.join(out, "launch.json"),
  JSON.stringify(
    {
      paperSha256: sha256(pdf),
      cli,
      model: "gpt-6-sol",
      reasoningEffort: "high",
      resourcePolicy: app.team.resources.policy,
      nativeResourcePolicy,
      capacityRecovery: "user_authorized_restart_unfinished_cli_actor_only",
      scope: input.intent,
      externalProofCache: false,
      developerMathematicalAssistance: false,
      ...(continuation
        ? {
            continuation,
            checkpointProofsImported: true,
            freshAutonomousBenchmark: false,
          }
        : {}),
    },
    null,
    2,
  ),
);
const response = continuation
  ? null
  : await fetch(`http://127.0.0.1:${port}/api/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
const started = continuation
  ? await app.team.resume(parentRunId, {
      expectedRoot: continuation.parentRoot,
      authorization:
        "User explicitly requested continuing this saved review after interruption; retain public checkpoints and unknown outcomes, using the same model and shared budget without human proof assistance.",
    })
  : await response.json();
if (response && !response.ok) throw Error(started.error);
await writeFile(
  path.join(out, "started.json"),
  JSON.stringify({
    runId: started.id,
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    engine: started.engine,
  }),
);
console.log(
  JSON.stringify({
    runId: started.id,
    url: `${uiBaseUrl.origin}/?review=${started.id}`,
    port,
  }),
);
let finalizing = false;
const timer = setInterval(() => {
  void finalize().catch(async (error) => {
    finalizing = true;
    clearInterval(timer);
    await writeFile(
      path.join(out, "finalization.json"),
      JSON.stringify({
        status: "failed",
        error: error.message,
        completedAt: new Date().toISOString(),
        retryIssued: false,
      }),
    );
    console.error(
      JSON.stringify({ event: "finalization_failed", error: error.message }),
    );
  });
}, 1500);
async function finalize() {
  const r = await app.team.load(started.id);
  if (!r.root || app.team.active.get(r.id)?.jobs.size || finalizing) return;
  finalizing = true;
  clearInterval(timer);
  const now = await fingerprints();
  const changes = [
    ...new Set([...Object.keys(freeze), ...Object.keys(now)]),
  ].filter((f) => freeze[f] !== now[f]);
  const state = await finalizeTeamPaper({
    team: app.team,
    store: app.store,
    runId: r.id,
    out,
    metadata: { cli, codeChanges: changes },
  });
  console.log(
    JSON.stringify({
      event: "review_finished",
      status: r.status,
      delivery: state.status,
      report: path.join(out, "result-report.json"),
    }),
  );
}
async function stop() {
  clearInterval(timer);
  if (app.team.runs.get(started.id)?.status === "running")
    await app.team.pause(started.id, { reason: "User requested runner pause" });
  await app.team.close();
  const closed = new Promise((r) => app.server.close(r));
  app.server.closeAllConnections();
  await closed;
  process.exit(0);
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
