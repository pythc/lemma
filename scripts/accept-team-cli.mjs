import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MathematicalTools } from "../server/tools/mathematics.mjs";
import { TeamRuntime } from "../server/team/runtime.mjs";
import { TeamResources } from "../server/resources/team-resources.mjs";
import { CodexCliAdapter } from "../server/adapters/codex-cli.mjs";
import { EvidenceStore, sha256 } from "../server/evidence.mjs";
const out = path.resolve(process.argv[2] || "evidence/team-cli-smoke-20261029");
await mkdir(out, { recursive: true });
const source = {
  paperSha256: sha256("tool-compatibility-only"),
  pageCount: 1,
  pdfBase64: "JVBERi0=",
  pages: [
    {
      index: 0,
      text: "This is an engineering compatibility note, not a mathematical research paper. No mathematical claim is asserted.",
    },
  ],
  extraction: "synthetic_compatibility_note",
};
const store = new EvidenceStore(path.join(out, "store"));
const runtime = new TeamRuntime({
  store,
  mathTools: new MathematicalTools({ store }),
  resources: new TeamResources(),
  executor: new CodexCliAdapter(),
  extract: async () => source,
});
await runtime.init();
const run = await runtime.start({
  title: "Codex CLI 工具接入验收",
  pdfBase64: source.pdfBase64,
  intent:
    "这是一条工程兼容性检查。主线读取原文，创建一个任务 Agent 检查文本是否包含数学命题；任务通过工具保存短报告并提交；验收 Agent 独立核查。主线收到结果后提交最终报告。不要构造数学命题或证明。",
});
process.once(
  "SIGINT",
  () =>
    void runtime
      .cancel(run.id)
      .then(() => runtime.close())
      .then(() => process.exit(130)),
);
process.once(
  "SIGTERM",
  () =>
    void runtime
      .cancel(run.id)
      .then(() => runtime.close())
      .then(() => process.exit(143)),
);
await writeFile(
  path.join(out, "started.json"),
  JSON.stringify({ runId: run.id, model: run.model }),
);
const timer = setInterval(async () => {
  const r = await runtime.load(run.id);
  if (r.root && !runtime.active.get(run.id).jobs.size) {
    clearInterval(timer);
    await writeFile(path.join(out, "result.json"), JSON.stringify(r, null, 2));
    console.log(
      JSON.stringify({
        status: r.status,
        tasks: r.tasks.map((t) => ({
          role: t.role,
          status: t.status,
          error: t.error,
        })),
        model: r.model,
      }),
    );
    await runtime.close();
  }
}, 1000);
