// Isolated browser acceptance harness. Never uses .env.local or a real model.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createApp } from "../server/index.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const folder = path.join(root, "evidence/reader-workflow-20261017");
await mkdir(folder, { recursive: true });
const pdf = await PDFDocument.create(),
  font = await pdf.embedFont(StandardFonts.TimesRoman);
const page = pdf.addPage([612, 792]);
page.drawText("UI ACCEPTANCE FIXTURE - NOT A RESEARCH PAPER", {
  x: 50,
  y: 730,
  size: 10,
  font,
});
page.drawText("Theorem 1. Right identity", { x: 50, y: 650, size: 20, font });
page.drawText("For every natural number n, n + 0 = n.", {
  x: 50,
  y: 590,
  size: 13,
  font,
});
page.drawText(
  "A controlled response tests reader interactions, not mathematical ability.",
  { x: 50, y: 530, size: 11, font },
);
await writeFile(
  path.join(folder, "reader-ui-acceptance.pdf"),
  await pdf.save(),
);
const app = await createApp({
  dataRoot: path.join(root, ".runtime/reader-ui-acceptance-isolated"),
  configProvider: async () => ({
    model: "UI-TEST-STUB",
    reasoningEffort: "high",
  }),
  model: async (_, { role, input, signal }) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 2200);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("受控验收：已停止回答。"));
        },
        { once: true },
      );
    });
    const quote = "For every natural number n, n + 0 = n.";
    return {
      parsed:
        role === "READER"
          ? {
              answer:
                "【受控界面验收回答】这句话说：任意自然数加上 0，结果还是它自己。这是用于测试阅读器交互的固定回答，没有调用真实模型，也没有执行数学证明。",
              citations: [{ pageIndex: 0, quote }],
              reviewSuggestion: {
                recommended: true,
                reason:
                  "【受控验收】可发起对选定命题的核验；请在下一步确认原文与目标的一致性。",
              },
            }
          : {
              unavailable:
                "受控界面验收：故意返回缺少定义，用来检查工作流的受阻状态。没有执行真实模型或证明。",
            },
      record: {
        testOnly: true,
        role,
        model: "UI-TEST-STUB",
        historyCount: input.history?.length || 0,
      },
    };
  },
});
await new Promise((resolve) => app.server.listen(4181, "127.0.0.1", resolve));
const vite = await createServer({
  root,
  configFile: false,
  cacheDir: path.join(root, ".runtime/reader-ui-vite-cache"),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4180,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4181",
        changeOrigin: true,
        headers: { origin: "http://127.0.0.1:4178" },
      },
    },
  },
});
await vite.listen();
console.log("Isolated UI fixture: http://127.0.0.1:4180/ (no real model)");
process.on("SIGTERM", () => {
  void vite.close();
  app.server.close();
});
