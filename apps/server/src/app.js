import { mountAdmin } from "./admin.js";
import { recordEvent } from "./analytics.js";
import { traceOperation } from "./trace-context.js";
import { customizeCart } from "./cart-customization.js";
import { getPreferenceJob, startPreferenceJob } from "./preference-builder.js";
import { telegramStatus, startTelegramLink, confirmTelegramLink, disconnectTelegram, handleTelegramUpdate, queueTelegramCart } from "./telegram.js";
import { getCartExperience, saveCartExperience, reserveBackgroundCart, releaseBackgroundCart, pausedBackgroundCart } from "./cart-experience.js";
import { decideCart, refreshPayment, cancelPayment } from "./checkout.js";
import crypto from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import cors from "cors";
import { CartCustomizationSchema, CartMutationSchema, CouponSelectionSchema, DetectionSchema, OrchestrateRequestSchema, foodCravingIdentity } from "@cravelens/shared";
import { claimThreadStatus, getThread, getVideo, patchThread, saveDetection, saveThread } from "./store.js";
import { buildPersonalizedCart, checkUPIPayment, confirmUPIPayment, customizePersonalizedCart, getRestaurantMenuItems, getSavedAddresses, mutatePersonalizedCart, placeOrder, publicPayment, selectPersonalizedCoupon } from "./swiggy.js";
import { completeSwiggyAuthorization, disconnectSwiggy, failSwiggyAuthorization, getSwiggyAuthorizationStatus, startSwiggyAuthorization } from "./swiggy-auth.js";
import { config } from "./config.js";
import { publishAgentEvent } from "./agent-events.js";
import { createDeviceSession, requireDevice, revokeDeviceSession, rotateDeviceSession } from "./device-auth.js";
import { deleteModelCredential, getPublicModelSettings, saveModelSettings } from "./model-settings.js";
import { decideFallback } from "./fallback-approval.js";

export const app = express();
const orchestrationFlights = new Map();


export function orchestrationFlightKey(input, swiggySessionId, requester = "") {
  const dish = String(input.verification?.dish || "food").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const identity = [swiggySessionId || `anonymous:${requester}`, input.addressId || "default", input.videoId, dish, JSON.stringify(foodCravingIdentity(input.verification)), input.personalContext || ""].join("\u001f");
  return crypto.createHash("sha256").update(identity).digest("hex");
}

export function runSingleFlight(flights, key, operation, { retainMs = 30_000 } = {}) {
  const existing = flights.get(key);
  if (existing) return { joined: true, promise: existing };

  const promise = Promise.resolve().then(operation);
  flights.set(key, promise);
  const remove = () => {
    if (flights.get(key) === promise) flights.delete(key);
  };
  promise.then((result) => {
    if (retainMs <= 0 || result?.paused) remove();
    else {
      const timer = setTimeout(remove, retainMs);
      timer.unref?.();
    }
  }, remove);
  return { joined: false, promise };
}

app.use(cors());
app.use(express.json({ limit: "5mb" }));
mountAdmin(app);

app.use("/models", express.static(config.localModelDirectory, { fallthrough: false, immutable: true, maxAge: "1y" }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "cravelens", time: new Date().toISOString() }));
app.get("/api/local-model/status", (_req, res) => {
  const files = ["gemma-4-E2B-it-web.litertlm", "gemma-4-E4B-it-web.litertlm", "gemma-4-E2B-it-web.task", "gemma-4-E4B-it-web.task"];
  const models = files.map((file) => { const path = join(config.localModelDirectory, file); const available = existsSync(path); return { file, available, bytes: available ? statSync(path).size : 0 }; });
  res.json({ available: models.some((model) => model.available), model: "Gemma 4", models });
});
app.post("/api/device/session", async (_req, res, next) => { try { res.status(201).json(await createDeviceSession()); } catch (error) { next(error); } });
app.post("/api/device/session/refresh", async (req, res, next) => { try { res.json(await rotateDeviceSession(req.body?.refreshToken)); } catch (error) { next(error); } });
app.post("/api/device/session/revoke", async (req, res, next) => { try { await revokeDeviceSession(req.body?.refreshToken); res.status(204).end(); } catch (error) { next(error); } });
app.get("/api/swiggy/auth/callback", async (req, res) => {
  const state = String(req.query.state || "");
  try {
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    const code = String(req.query.code || "");
    if (!code) throw new Error("Swiggy did not return an authorization code");
    await completeSwiggyAuthorization(state, code);
    res.type("html").send(authResultPage(true, "Swiggy connected", "You can close this tab and return to CraveLens."));
  } catch (error) {
    await failSwiggyAuthorization(state, error instanceof Error ? error.message : "Authorization failed");
    res.status(400).type("html").send(authResultPage(false, "Couldn’t connect Swiggy", error instanceof Error ? error.message : "Authorization failed"));
  }
});
app.post("/telegram/webhook", async (req, res) => {
  const supplied = Buffer.from(String(req.get("X-Telegram-Bot-Api-Secret-Token") || ""));
  const expected = Buffer.from(config.telegramWebhookSecret);
  if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.sendStatus(403);
  try { await handleTelegramUpdate(req.body); res.sendStatus(200); }
  catch { res.sendStatus(503); }
});
app.use(["/api/swiggy", "/api/orchestrate", "/api/model-settings", "/api/telegram", "/api/cart-experience", "/api/preferences"], requireDevice);
app.post("/api/preferences/build", async (req, res, next) => { try { res.status(202).json(await startPreferenceJob(req.deviceId, req.body)); } catch (error) { next(error); } });
app.get("/api/preferences/build/:runId", async (req, res, next) => { try { const job = await getPreferenceJob(req.deviceId, req.params.runId); if (!job) return res.status(404).json({ error: "Preferences run expired or was not found" }); res.set("Cache-Control", "no-store").json(job); } catch (error) { next(error); } });
app.get("/api/telegram", async (req, res, next) => { try { res.json(await telegramStatus(req.deviceId)); } catch (error) { next(error); } });
app.post("/api/telegram/connect", async (req, res, next) => { try { res.json(await startTelegramLink(req.deviceId)); } catch (error) { next(error); } });
app.post("/api/telegram/confirm", async (req, res, next) => { try { res.json(await confirmTelegramLink(req.deviceId)); } catch (error) { next(error); } });
app.delete("/api/telegram", async (req, res, next) => { try { await disconnectTelegram(req.deviceId); res.sendStatus(204); } catch (error) { next(error); } });
app.get("/api/cart-experience", async (req, res, next) => { try { res.json(await getCartExperience(req.deviceId)); } catch (error) { next(error); } });
app.put("/api/cart-experience", async (req, res, next) => { try { res.json(await saveCartExperience(req.deviceId, req.body)); } catch (error) { next(error); } });
app.use("/api/orchestrate/:threadId", async (req, res, next) => {
  if (req.path === "/fallback") return next();
  try { const thread = await getThread(req.params.threadId); if (!thread || thread.deviceId !== req.deviceId) return res.status(404).json({ error: "Cart not found" }); next(); } catch (error) { next(error); }
});
app.post("/api/swiggy/auth/start", async (req, res, next) => { try { res.json(await startSwiggyAuthorization(req.deviceId)); } catch (error) { next(error); } });
app.get("/api/swiggy/auth/status", async (req, res, next) => { try { res.json(await getSwiggyAuthorizationStatus(req.deviceId)); } catch (error) { next(error); } });
app.delete("/api/swiggy/auth", async (req, res, next) => { try { await disconnectSwiggy(req.deviceId); res.status(204).end(); } catch (error) { next(error); } });
app.get("/api/swiggy/addresses", async (req, res, next) => { try { res.json({ addresses: await getSavedAddresses(readSwiggySession(req)) }); } catch (error) { next(error); } });
app.get("/api/model-settings", async (req, res, next) => { try { res.json(await getPublicModelSettings(req.deviceId)); } catch (error) { next(error); } });
app.put("/api/model-settings", async (req, res, next) => { try { res.json(await saveModelSettings(req.deviceId, req.body)); } catch (error) { next(error); } });
app.delete("/api/model-settings/credentials/:provider", async (req, res, next) => { try { await deleteModelCredential(req.deviceId, req.params.provider); res.status(204).end(); } catch (error) { next(error); } });
app.post("/api/orchestrate/:runId/fallback", async (req, res, next) => { try { res.json(await decideFallback(req.deviceId, req.params.runId, req.body?.decision)); } catch (error) { next(error); } });
app.get("/api/videos/:videoId/detections", async (req, res, next) => { try { const data = await getVideo(req.params.videoId); res.json({ cached: Boolean(data), detections: data?.detections || [], verificationCount: data?.verificationCount || 0 }); } catch (error) { next(error); } });
app.post("/api/videos/:videoId/detections", async (req, res, next) => { try { const detection = DetectionSchema.parse(req.body); await saveDetection(req.params.videoId, detection); res.status(202).json({ accepted: true }); } catch (error) { next(error); } });
app.post("/api/orchestrate", async (req, res, next) => {
  try {
    const input = OrchestrateRequestSchema.parse(req.body);
    const food = input.verification;
    if (!food.isFood || food.confidence < 0.65) return res.json({ detected: false });
    const experience = await getCartExperience(req.deviceId);
    const swiggySessionId = readSwiggySession(req);
    const flightKey = orchestrationFlightKey(input, swiggySessionId, req.ip);
    const { joined, promise } = runSingleFlight(orchestrationFlights, flightKey, async () => {
      const reserved = await reserveBackgroundCart(req.deviceId);
      if (!reserved) {
        publishAgentEvent(input.streamId, "orchestration_paused", { reason: "ACTIVE_CART_PENDING" });
        return { detected: false, paused: true, code: "ACTIVE_CART_PENDING", ...await pausedBackgroundCart(req.deviceId) };
      }
      const threadId = reserved || crypto.randomUUID();
      return traceOperation("cart.prepare", {sessionId: threadId, streamId: input.streamId, operation: "cart.prepare"}, async () => {
      try {
      await recordEvent({id: `detection:${threadId}`, kind: "detection", outcome: "success", dishes: [...new Set((food.dishes?.length ? food.dishes : [food]).map(d => d.dish.trim().toLowerCase()))]});
      publishAgentEvent(input.streamId, "orchestration_started", { dish: food.dish });
      const suggestion = await buildPersonalizedCart(food, threadId, swiggySessionId, input.addressId, input.streamId, {
        personalContext: input.personalContext,
        timeZone: input.timeZone,
      });
      await Promise.all([saveThread({ deviceId: req.deviceId, threadId, conversationId: threadId, status: "awaiting_confirmation", suggestion, createdAt: new Date() }), saveDetection(input.videoId, { itemLabel: food.dish, startTime: Math.floor(input.timestamp), endTime: Math.floor(input.timestamp + 5), confidence: food.confidence })]);
      publishAgentEvent(input.streamId, "cart_ready", { restaurant: suggestion.restaurant, item: suggestion.item, finalAmount: suggestion.finalAmount });
      if (experience.mode === "telegram") await queueTelegramCart(threadId);
      await recordEvent({id: `cart:${threadId}`, kind: "cart", outcome: "success"});
      return { detected: true, suggestion, experience: experience.mode };
      } catch (error) {
        await recordEvent({id: `cart:${threadId}`, kind: "cart", outcome: "error"});
        if (reserved) await releaseBackgroundCart(req.deviceId, reserved);
        throw error;
      }
      });
    });
    if (joined) publishAgentEvent(input.streamId, "orchestration_joined", { dish: food.dish });
    const result = await promise;
    if (joined && result.suggestion) publishAgentEvent(input.streamId, "cart_ready", { restaurant: result.suggestion.restaurant, item: result.suggestion.item, finalAmount: result.suggestion.finalAmount });
    res.json(joined ? { ...result, deduplicated: true } : result);
  } catch (error) {
    publishAgentEvent(req.body?.streamId, "failed", { error: error instanceof Error ? error.message : "Unexpected error" });
    next(error);
  }
});
cartRoute("post", "/api/orchestrate/:threadId/customize", async (req, res, next) => {
  try { res.json(await customizeCart(req.deviceId, req.params.threadId, CartCustomizationSchema.parse(req.body))); }
  catch (error) { next(error); }
});
cartRoute("get", "/api/orchestrate/:threadId/menu", async (req, res, next) => {
  try {
    const thread = await getThread(req.params.threadId);
    if (!thread) return res.status(404).json({ error: "Cart conversation expired or was not found." });
    if (thread.status !== "awaiting_confirmation") return res.status(409).json({ error: "This cart cannot be edited right now." });
    const query = String(req.query.q || "").trim();
    if (query.length > 80) return res.status(400).json({ error: "Menu search must be 80 characters or fewer." });
    res.json({ items: await getRestaurantMenuItems(thread.suggestion, readSwiggySession(req), query) });
  } catch (error) { next(error); }
});
cartRoute("post", "/api/orchestrate/:threadId/cart", async (req, res, next) => {
  try {
    const input = CartMutationSchema.parse(req.body);
    const thread = await claimThreadStatus(req.params.threadId, ["awaiting_confirmation"], "updating_cart");
    if (!thread) {
      const existing = await getThread(req.params.threadId);
      if (!existing) return res.status(404).json({ error: "Cart conversation expired or was not found." });
      return res.status(409).json({ error: "This cart is already being updated." });
    }
    try {
      const suggestion = await mutatePersonalizedCart(thread.suggestion, input, readSwiggySession(req));
      if (suggestion?.deleted) {
        await patchThread(req.params.threadId, { status: "rejected", suggestion: null, cartUpdatedAt: new Date() });
        return res.json({ status: "deleted" });
      }
      await patchThread(req.params.threadId, { status: "awaiting_confirmation", suggestion, cartUpdatedAt: new Date() });
      return res.json({ status: "awaiting_confirmation", suggestion });
    } catch (error) {
      await patchThread(req.params.threadId, { status: "awaiting_confirmation", cartUpdateError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  } catch (error) { next(error); }
});
cartRoute("post", "/api/orchestrate/:threadId/coupon", async (req, res, next) => {
  try {
    const input = CouponSelectionSchema.parse(req.body);
    const thread = await claimThreadStatus(req.params.threadId, ["awaiting_confirmation"], "updating_coupon");
    if (!thread) {
      const existing = await getThread(req.params.threadId);
      if (!existing) return res.status(404).json({ error: "Cart conversation expired or was not found." });
      return res.status(409).json({ error: "This cart is already being updated." });
    }
    try {
      const suggestion = await selectPersonalizedCoupon(thread.suggestion, input.couponCode, readSwiggySession(req));
      await patchThread(req.params.threadId, { status: "awaiting_confirmation", suggestion, couponUpdatedAt: new Date() });
      return res.json({ status: "awaiting_confirmation", suggestion });
    } catch (error) {
      await patchThread(req.params.threadId, { status: "awaiting_confirmation", couponUpdateError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  } catch (error) { next(error); }
});
cartRoute("post", "/api/orchestrate/:threadId/decision", async (req, res, next) => {
  try {
    res.json(await decideCart(req.deviceId, req.params.threadId, req.body?.decision, req.body?.paymentMethod));
  } catch (error) { next(error); }
});
cartRoute("get", "/api/orchestrate/:threadId/payment-status", async (req, res, next) => {
  try {
    const thread = await getThread(req.params.threadId);
    if (!thread?.payment) return res.status(404).json({ error: "No UPI payment is pending for this cart." });
    if (thread.status === "ordered") return res.json({ status: "ordered", order: thread.order });
    if (thread.status === "payment_paid") return res.json({ status: "paid" });
    if (thread.status === "payment_cancelled") return res.json({ status: "cancelled" });
    if (["payment_review_required", "confirmation_failed"].includes(thread.status)) return res.json({ status: "payment_review_required" });
    if (["payment_cancelling", "confirming_payment"].includes(thread.status)) return res.json({ status: "pending" });
    if (thread.status === "payment_failed" || paymentExpired(thread.payment)) {
      if (thread.status !== "payment_failed") await claimThreadStatus(req.params.threadId, ["payment_pending"], "payment_failed");
      return res.json({ status: "failed" });
    }
    if (thread.status !== "payment_pending") return res.status(409).json({ error: "This payment is no longer available." });
    const status = await checkUPIPayment(thread.payment, readSwiggySession(req));
    if (status === "pending") return res.json({ status });
    const nextStatus = status === "paid" ? "payment_paid" : "payment_failed";
    const transitioned = await claimThreadStatus(req.params.threadId, ["payment_pending"], nextStatus);
    if (transitioned) return res.json({ status });
    return res.json(paymentStatusResponse(await getThread(req.params.threadId)));
  } catch (error) { next(error); }
});
cartRoute("post", "/api/orchestrate/:threadId/cancel-payment", async (req, res, next) => {
  try { res.json(await cancelPayment(req.deviceId, req.params.threadId)); } catch (error) { next(error); }
});
cartRoute("post", "/api/orchestrate/:threadId/confirm-payment", async (req, res, next) => {
  try {
    res.json(await refreshPayment(req.deviceId, req.params.threadId));
  } catch (error) { next(error); }
});
app.use((error, _req, res, _next) => {
  const message = safeErrorMessage(error instanceof Error ? error.message : "Unexpected error");
  console.error("[api]", { message, code: error?.code, statusCode: error?.statusCode });
  const status = error?.name === "ZodError" ? 400 : Number(error?.statusCode) || 500;
  if (status >= 500) void recordEvent({kind: "server_failure", outcome: "error", code: /^INFERENCE_/.test(error?.code || "") ? "MODEL_UPSTREAM" : "SERVER_ERROR", statusCode: status});
  res.status(status).json({ error: message, code: error?.code, ...(error?.fallback ? { fallback: error.fallback } : {}) });
});

function safeErrorMessage(value) {
  return String(value).replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]").replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[redacted-key]").slice(0, 1000);
}

function readSwiggySession(req) {
  return req.deviceId;
}

export function isSuggestionExpired(suggestion, now = Date.now()) {
  const expiresAt = Date.parse(suggestion?.expiresAt || "");
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function paymentExpired(payment, now = Date.now()) {
  const expiresAt = Date.parse(payment?.expiresAt || "");
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function paymentStatusResponse(thread) {
  if (thread?.status === "ordered") return { status: "ordered", order: thread.order };
  if (thread?.status === "payment_paid" || thread?.status === "confirming_payment") return { status: "paid" };
  if (thread?.status === "payment_cancelled") return { status: "cancelled" };
  if (thread?.status === "payment_failed") return { status: "failed" };
  if (["payment_review_required", "confirmation_failed"].includes(thread?.status)) return { status: "payment_review_required" };
  return { status: "pending" };
}

function authResultPage(success, title, detail) {
  const safe = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${safe(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f0e6;color:#191915;font:16px system-ui}.card{width:min(420px,calc(100% - 48px));padding:32px;border-radius:24px;background:#fff;box-shadow:0 24px 80px #342d1c1f;text-align:center}.mark{margin:auto;width:52px;height:52px;display:grid;place-items:center;border-radius:18px;background:${success ? "#258a55" : "#c94932"};color:#fff;font-size:25px}h1{font:30px Georgia;margin:20px 0 8px}p{color:#716b5f;line-height:1.5}</style><main class="card"><div class="mark">${success ? "✓" : "!"}</div><h1>${safe(title)}</h1><p>${safe(detail)}</p></main>`;
}

function cartRoute(method, path, handler) {
  app[method](path, (req, res, next) => traceOperation("cart.http." + path.split("/").at(-1), {sessionId: req.params.threadId, operation: "cart.followup"}, async () => {
    let failure;
    const result = await handler(req, res, (error) => { if (error) failure = error; else next(); });
    if (failure) throw failure;
    return result;
  }).catch(next));
}
