import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const virtualId = "virtual:lemma-pdf-worker";
const resolvedId = `\0${virtualId}`;

// Serve the installed worker byte-for-byte. A ?url import of an .mjs file
// still enters Vite's dev module transforms and can import its HMR client.
export function pdfWorkerAsset() {
  const bytes = readFileSync(
    require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
  );
  const { version } = JSON.parse(
    readFileSync(require.resolve("pdfjs-dist/package.json"), "utf8"),
  );
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const fileName = `assets/pdf.worker-${version}-${hash}.mjs`;
  let assetUrl;
  return {
    name: "lemma-pdf-worker-asset",
    configResolved(config) {
      assetUrl = `${config.base}${fileName}`;
    },
    resolveId(id) {
      if (id === virtualId) return resolvedId;
    },
    load(id) {
      if (id === resolvedId)
        return `export default ${JSON.stringify(assetUrl)};`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (new URL(req.url, "http://localhost").pathname !== assetUrl)
          return next();
        if (!["GET", "HEAD"].includes(req.method)) {
          res.writeHead(405, { Allow: "GET, HEAD" });
          return res.end();
        }
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Content-Length": bytes.length,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(req.method === "HEAD" ? undefined : bytes);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName, source: bytes });
    },
  };
}
