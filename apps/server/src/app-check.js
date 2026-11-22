export function androidAppCheck(req, res, next) {
  if (process.env.APP_CHECK_ENFORCE_ANDROID !== "true") return next();
  if (String(req.get("x-cravelens-platform") || "") !== "android") return next();
  const token = String(req.get("x-firebase-appcheck") || "");
  if (!token) return res.status(401).json({ error: "App Check token required", code: "APP_CHECK_REQUIRED" });
  verifyAppCheckToken(token).then(() => next(), next);
}

async function verifyAppCheckToken(token) {
  let getAppCheck;
  let initializeApp;
  let getApps;
  try {
    ({ getAppCheck } = await import("firebase-admin/app-check"));
    ({ initializeApp, getApps } = await import("firebase-admin/app"));
  } catch {
    throw Object.assign(new Error("App Check enforcement requires the firebase-admin package"), { statusCode: 503, code: "APP_CHECK_UNCONFIGURED" });
  }
  if (!getApps().length) initializeApp();
  await getAppCheck().verifyToken(token);
}
