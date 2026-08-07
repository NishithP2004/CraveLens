import { defineConfig } from "vite";
import { resolve } from "node:path";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { build as esbuild } from "esbuild";

const copyLiteRtLmWasm = {
  name: "copy-litert-lm-wasm",
  async closeBundle() {
    const destination = resolve(import.meta.dirname, "dist/litertlm-wasm");
    await mkdir(destination, { recursive: true });
    await cp(resolve(import.meta.dirname, "../../node_modules/@litert-lm/core/wasm"), destination, { recursive: true });
  },
};

// Chrome does not render a raster data URI nested inside an SVG loaded by an
// extension <img>. Keep the official source marks reviewable as text in git,
// then materialize their embedded PNGs as first-class packaged assets.
const materializeProviderIcons = {
  name: "materialize-provider-icons",
  async closeBundle() {
    const destination = resolve(import.meta.dirname, "dist/provider-icons");
    await mkdir(destination, { recursive: true });
    for (const name of ["gemma", "ollama"]) {
      const source = await readFile(resolve(import.meta.dirname, `public/provider-icons/${name}.svg`), "utf8");
      const encoded = source.match(/data:image\/png;base64,([^\"]+)/)?.[1];
      if (!encoded) throw new Error(`Provider icon ${name}.svg does not contain an embedded PNG`);
      await writeFile(resolve(destination, `${name}.png`), Buffer.from(encoded, "base64"));
    }
  },
};

// Manifest V3 content scripts are evaluated as classic scripts even when the
// extension background worker is a module. Re-bundle this entry as an IIFE so
// Rollup's shared ESM chunks never leave an `import` in dist/content.js.
const bundleClassicContentScript = {
  name: "bundle-classic-content-script",
  async closeBundle() {
    await esbuild({
      entryPoints: [resolve(import.meta.dirname, "src/content.js")],
      outfile: resolve(import.meta.dirname, "dist/content.js"),
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "chrome120",
      minify: true,
      legalComments: "inline",
    });
  },
};

export default defineConfig({
  plugins: [copyLiteRtLmWasm, bundleClassicContentScript, materializeProviderIcons],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: { content: resolve(import.meta.dirname, "src/content.js"), background: resolve(import.meta.dirname, "src/background.js"), "food-worker": resolve(import.meta.dirname, "src/food-worker.js"), popup: resolve(import.meta.dirname, "src/popup.html"), offscreen: resolve(import.meta.dirname, "src/offscreen.html") },
      output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name].js", assetFileNames: "assets/[name][extname]" },
    },
  },
});
