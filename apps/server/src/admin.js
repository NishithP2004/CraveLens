import express from "express";
import { siteAssets } from "@cravelens/shared/site-assets";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAccessVerifier } from "@cravelens/shared/access";
import { adminSummary } from "./analytics.js";
let verifier;
let signature;
export function adminHeaders(req, res, next) {
  res.set({
    "Cache-Control": "no-store, no-transform",
    "X-Robots-Tag": "noindex, nofollow",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  next();
}
export async function requireAdmin(req, res, next) {
  try {
    const settings = {
      teamDomain: process.env.ADMIN_ACCESS_TEAM_DOMAIN,
      audience: process.env.ADMIN_ACCESS_AUDIENCE,
      emails: process.env.ADMIN_EMAILS,
    };
    const current = JSON.stringify(settings);
    if (current !== signature) {
      verifier = createAdminAccessVerifier(settings);
      signature = current;
    }
    await verifier(req.get("X-CraveLens-Admin-Assertion"));
    next();
  } catch (error) {
    res.status(error.statusCode || 403).json({ error: error.message });
  }
}
export function mountAdmin(app, { authorize = requireAdmin } = {}) {
  app.use(["/admin", "/api/admin"], adminHeaders, authorize);
  app.get("/api/admin/summary", async (req, res, next) => {
    try {
      const days = Number(req.query.days || 30);
      if (![7, 30, 90].includes(days))
        return res.status(400).json({ error: "Choose 7, 30 or 90 days" });
      res.json(await adminSummary(days));
    } catch (error) {
      next(error);
    }
  });
  for (const asset of siteAssets) {
    app.get(`/admin/${asset}`, (req, res) =>
      res.sendFile(
        createRequire(import.meta.url).resolve(`@cravelens/shared/${asset}`),
      ),
    );
  }
  for (const font of ["dm-sans", "manrope"]) {
    app.get(`/admin/fonts/${font}.woff2`, (req, res) =>
      res.sendFile(
        createRequire(import.meta.url).resolve(
          `@fontsource-variable/${font}/files/${font}-latin-wght-normal.woff2`,
        ),
      ),
    );
  }
  app.get("/admin/vendor/chart.js", (req, res) =>
    res.sendFile(
      join(
        dirname(createRequire(import.meta.url).resolve("chart.js")),
        "chart.umd.min.js",
      ),
    ),
  );
  app.get(
    ["/admin", "/admin/", "/admin/index.html"],
    async (req, res, next) => {
      try {
        const [html, footer, header] = await Promise.all([
          readFile(
            fileURLToPath(new URL("../admin/index.html", import.meta.url)),
            "utf8",
          ),
          readFile(
            createRequire(import.meta.url).resolve(
              "@cravelens/shared/site-footer.html",
            ),
            "utf8",
          ),
          readFile(
            createRequire(import.meta.url).resolve(
              "@cravelens/shared/site-header.html",
            ),
            "utf8",
          ),
        ]);
        res
          .type("html")
          .send(
            html
              .replace(
                "<!-- CRAVELENS_SHARED_FOOTER -->",
                footer.replace(
                  'src="/swiggy-logo.png"',
                  'src="/admin/swiggy-logo.png"',
                ),
              )
              .replace("<!-- CRAVELENS_SHARED_HEADER -->", header),
          );
      } catch (error) {
        next(error);
      }
    },
  );
  app.use(
    "/admin",
    express.static(fileURLToPath(new URL("../admin/", import.meta.url)), {
      fallthrough: false,
      index: "index.html",
      maxAge: 0,
    }),
  );
}
