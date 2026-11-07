// Separate local preview; credentials are read from an explicitly selected
// local configuration directory and are never copied into the checkout.
import path from "node:path";
import { createServer as createViteServer } from "vite";
import { createApp } from "../server/index.mjs";
import { modelConfig, semanticModelConfig } from "../server/model.mjs";
const configRoot = path.resolve(process.argv[2] || ".");
const apiPort = Number(process.env.LEMMA_PREVIEW_API_PORT || 4189);
const uiPort = Number(process.env.LEMMA_PREVIEW_UI_PORT || 4188);
const app = await createApp({
  dataRoot: path.resolve(process.env.LEMMA_PREVIEW_DATA_ROOT || ".runtime/foundations-preview"),
  configProvider: () => modelConfig(configRoot),
  semanticConfigProvider: () => semanticModelConfig(configRoot),
});
await new Promise((resolve, reject) => {
  app.server.once("error", reject);
  app.server.listen(apiPort, "127.0.0.1", resolve);
});
const vite = await createViteServer({ server: { port: uiPort, strictPort: true,
  proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } } } });
await vite.listen();
console.log(`Isolated preview: http://127.0.0.1:${uiPort}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.adaptive.close();
  await app.harness.close();
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  await vite.close();
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
