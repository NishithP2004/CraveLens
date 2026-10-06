import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

import { siteAssets } from "@cravelens/shared/site-assets";

function readSharedAsset(name) {
  return readFileSync(
    resolve(import.meta.dirname, "../../packages/shared/static", name),
  );
}

function sharedSitePlugin() {
  let building = false;
  return {
    name: "cravelens-shared-site",
    transformIndexHtml(html) {
      return html
        .replace(
          "<!-- CRAVELENS_SHARED_FOOTER -->",
          readSharedAsset("site-footer.html").toString(),
        )
        .replace(
          "<!-- CRAVELENS_SHARED_HEADER -->",
          readSharedAsset("site-header.html").toString(),
        );
    },
    configResolved(config) {
      building = config.command === "build";
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split("?")[0].slice(1);
        if (!siteAssets.includes(name)) return next();
        res.setHeader(
          "Content-Type",
          name.endsWith(".png")
            ? "image/png"
            : name.endsWith(".css")
              ? "text/css"
              : "text/javascript",
        );
        res.end(readSharedAsset(name));
      });
    },
    buildStart() {
      if (!building) return;
      for (const name of siteAssets) {
        this.emitFile({
          type: "asset",
          fileName: name,
          source: readSharedAsset(name),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [sharedSitePlugin()],
  build: {
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, "index.html"),
        guide: resolve(import.meta.dirname, "guide/index.html"),
        privacy: resolve(import.meta.dirname, "privacy/index.html"),
        terms: resolve(import.meta.dirname, "terms/index.html"),
      },
    },
  },
});
