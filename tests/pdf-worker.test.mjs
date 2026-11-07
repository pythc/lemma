import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createServer, build } from "vite";
import { pdfWorkerAsset } from "../scripts/vite-pdf-worker.mjs";

const require = createRequire(import.meta.url);
const original = await readFile(
  require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
);
test("dev worker is served unchanged, without Vite client imports, on a fingerprinted URL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lemma-pdf-worker-"));
  const server = await createServer({
    root,
    configFile: false,
    plugins: [pdfWorkerAsset()],
    optimizeDeps: { noDiscovery: true },
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  try {
    await server.listen();
    const module = await server.transformRequest("virtual:lemma-pdf-worker");
    const url = module.code.match(/export default "([^"]+)"/)[1];
    assert.match(url, /^\/assets\/pdf\.worker-[\d.]+-[a-f0-9]{16}\.mjs$/);
    const response = await fetch(
      `http://127.0.0.1:${server.httpServer.address().port}${url}?import`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
    const actual = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(actual, original);
    assert.ok(!actual.includes(Buffer.from("/@vite/client")));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("production module URL resolves to the exact installed PDF worker bytes", async () => {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    plugins: [pdfWorkerAsset()],
    base: "/reader/",
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: "virtual:lemma-pdf-worker",
        preserveEntrySignatures: "strict",
      },
    },
  });
  const files = result.output;
  const asset = files.find(
    (f) => f.type === "asset" && f.fileName.startsWith("assets/pdf.worker-"),
  );
  assert.ok(asset);
  assert.deepEqual(Buffer.from(asset.source), original);
  const entry = files.find((f) => f.type === "chunk" && f.isEntry);
  assert.ok(entry.code.includes(`/reader/${asset.fileName}`));
});
