// Explicitly scripted model for UI integration acceptance. Never use in dev.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
let anchor;
const model = async (_, req) => {
  await new Promise((r) => setTimeout(r, 1800));
  let parsed;
  if (req.role === "A_READ") {
    const p = req.input.pages.find((p) => p.text.includes("Theorem 1.1."));
    const start = p.text.indexOf("Theorem 1.1.");
    anchor = {
      pageIndex: p.pageIndex,
      quote: p.text.slice(start, start + 260),
    };
    parsed = {
      summary: "预设模型验收：此响应仅检验路径与交互，不评判论文。",
      claims: [
        {
          label: "Theorem 1.1",
          ...anchor,
          statement: "预设模型验收所选的原文命题。",
          concern: "演示不同返回如何触发检查。",
        },
      ],
    };
  } else if (req.role === "A_ENV") {
    parsed = {
      summary: "预设选库，仅验收页面和调度。",
      choices: req.input.paperMap.claims.map((c) => ({
        claimId: c.id,
        profile: "analysis-continuity-v1",
        reason: "受控测试选择，不代表论文依赖已满足。",
        queries: [],
        names: [],
      })),
    };
  } else if (req.role === "A_DIAGNOSE") {
    parsed = { action: "stop", guidance: "预设验收保留未解决状态。" };
  } else if (req.role === "A_COORDINATOR") {
    const inspections = req.input.tasks.filter((t) =>
      t.kind.startsWith("inspect_"),
    );
    const kinds =
      inspections.length === 0
        ? ["inspect_proof"]
        : inspections.length === 1
          ? ["inspect_definitions", "inspect_citation"]
          : inspections.length === 3
            ? ["inspect_proof"]
            : [];
    parsed = kinds.length
      ? {
          mode: "act",
          reason: "预设模型验收：根据已返回产物安排下一批检查。",
          actions: kinds.map((kind) => ({
            kind,
            claimId: req.input.claims[0].id,
            title: {
              inspect_proof: inspections.length
                ? "追查前提的使用位置"
                : "对照证明中的关键步骤",
              inspect_definitions: "核对定义是否一致",
              inspect_citation: "检查引用是否支持此步",
            }[kind],
            reason: "前一步发现需要进一步检查的依赖（预设验收）。",
            question: `fixture ${inspections.length} ${kind}`,
            strategy: `fixture strategy ${inspections.length}`,
            basedOn: [req.input.tasks.filter((t) => t.hasEvidence).at(-1).id],
          })),
        }
      : {
          mode: "finish",
          reason: "预设交互路径已执行完毕，内容不作为论文评审结论。",
          coverage: req.input.claims.map((c) => ({
            claimId: c.id,
            formalization: "not_attempted",
            reason: "受控页面验收，不执行论文形式化。",
          })),
        };
  } else
    parsed = {
      status: "unresolved",
      summary: "预设验收产物：引用与前提仍需真实模型核查，不构成数学判断。",
      anchors: [anchor],
      assumptions: [],
      steps: [],
      dependencies: ["fixture unresolved dependency"],
      nextQuestion: "此段的依赖是否完整？",
    };
  return {
    parsed,
    record: { provider: "scripted-ui-acceptance", role: req.role },
  };
};
const app = await createApp({
  dataRoot: path.join(root, ".runtime-acceptance/adaptive-ui"),
  configProvider: async () => ({ model: "scripted-ui-acceptance" }),
  model,
  adaptiveOptions: {
    testFixture: true,
    probe: async () => ({
      ready: true,
      probe: { testFixture: true },
      scope: "fixture_not_actual_tool",
    }),
  },
  origins: ["http://127.0.0.1:4182"],
});
app.server.listen(4183, "127.0.0.1", () =>
  console.log("Scripted UI acceptance API 4183; no external model calls"),
);

if (process.env.LEMMA_ACCEPTANCE_FRONTEND === "1") {
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: path.join(root, "vite.config.mjs"),
    root,
    server: {
      port: 4182,
      strictPort: true,
      proxy: {
        "/api": { target: "http://127.0.0.1:4183", changeOrigin: true },
      },
    },
  });
  await vite.listen();
  console.log("Scripted frontend 4182");
  process.on("SIGTERM", async () => {
    await app.adaptive.close();
    await vite.close();
    app.server.close();
    process.exit(0);
  });
}
