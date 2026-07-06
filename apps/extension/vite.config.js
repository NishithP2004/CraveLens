import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: { content: resolve(import.meta.dirname, "src/content.js"), background: resolve(import.meta.dirname, "src/background.js"), "food-worker": resolve(import.meta.dirname, "src/food-worker.js"), popup: resolve(import.meta.dirname, "src/popup.html"), offscreen: resolve(import.meta.dirname, "src/offscreen.html") },
      output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name].js", assetFileNames: "assets/[name][extname]" },
    },
  },
});
