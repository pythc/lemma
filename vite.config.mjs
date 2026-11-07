import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { pdfWorkerAsset } from "./scripts/vite-pdf-worker.mjs";

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.LEMMA_API_TARGET || "http://127.0.0.1:4179",
        changeOrigin: true,
      },
    },
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [pdfWorkerAsset(), react()],
});
