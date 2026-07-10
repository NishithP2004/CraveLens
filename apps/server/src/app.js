import crypto from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import cors from "cors";
import { DetectionSchema, OrchestrateRequestSchema } from "@cravelens/shared";
import { getThread, getVideo, saveDetection, saveThread, updateThread } from "./store.js";
import { buildPersonalizedCart, getSavedAddresses, placeOrder } from "./swiggy.js";
import { completeSwiggyAuthorization, failSwiggyAuthorization, getSwiggyAuthorizationStatus, startSwiggyAuthorization } from "./swiggy-auth.js";
import { config } from "./config.js";
import { publishAgentEvent } from "./agent-events.js";

export const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use("/models", express.static(config.localModelDirectory, { fallthrough: false, immutable: true, maxAge: "1y" }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "cravelens", time: new Date().toISOString() }));
app.get("/api/local-model/status", (_req, res) => {
  const path = join(config.localModelDirectory, "gemma-3n-E2B-it-int4-Web.litertlm");
  const available = existsSync(path);
  res.json({ available, model: "Gemma 3n E2B", bytes: available ? statSync(path).size : 0 });
});
app.post("/api/swiggy/auth/start", async (_req, res, next) => { try { res.json(await startSwiggyAuthorization()); } catch (error) { next(error); } });
app.get("/api/swiggy/auth/status/:sessionId", async (req, res, next) => { try { res.json(await getSwiggyAuthorizationStatus(req.params.sessionId)); } catch (error) { next(error); } });
app.get("/api/swiggy/addresses", async (req, res, next) => { try { res.json({ addresses: await getSavedAddresses(readSwiggySession(req)) }); } catch (error) { next(error); } });
app.get("/api/swiggy/auth/callback", async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  try {
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    const code = String(req.query.code || "");
    if (!code) throw new Error("Swiggy did not return an authorization code");
    await completeSwiggyAuthorization(sessionId, code);
    res.type("html").send(authResultPage(true, "Swiggy connected", "You can close this tab and return to CraveLens."));
  } catch (error) {
    failSwiggyAuthorization(sessionId, error instanceof Error ? error.message : "Authorization failed");
    res.status(400).type("html").send(authResultPage(false, "Couldn’t connect Swiggy", error instanceof Error ? error.message : "Authorization failed"));
  }
});
app.get("/api/videos/:videoId/detections", async (req, res, next) => { try { const data = await getVideo(req.params.videoId); res.json({ cached: Boolean(data), detections: data?.detections || [], verificationCount: data?.verificationCount || 0 }); } catch (error) { next(error); } });
app.post("/api/videos/:videoId/detections", async (req, res, next) => { try { const detection = DetectionSchema.parse(req.body); await saveDetection(req.params.videoId, detection); res.status(202).json({ accepted: true }); } catch (error) { next(error); } });
app.post("/api/orchestrate", async (req, res, next) => {
  try {
    const input = OrchestrateRequestSchema.parse(req.body);
    const food = input.verification;
    if (!food.isFood || food.confidence < 0.65) return res.json({ detected: false });
    const threadId = crypto.randomUUID();
    publishAgentEvent(input.streamId, "orchestration_started", { dish: food.dish });
    const suggestion = await buildPersonalizedCart(food, threadId, readSwiggySession(req), input.addressId, input.streamId);
    await Promise.all([saveThread({ threadId, status: "awaiting_confirmation", suggestion, createdAt: new Date() }), saveDetection(input.videoId, { itemLabel: food.dish, startTime: Math.floor(input.timestamp), endTime: Math.floor(input.timestamp + 5), confidence: food.confidence })]);
    publishAgentEvent(input.streamId, "cart_ready", { restaurant: suggestion.restaurant, item: suggestion.item, finalAmount: suggestion.finalAmount });
    res.json({ detected: true, suggestion });
  } catch (error) {
    publishAgentEvent(req.body?.streamId, "failed", { error: error instanceof Error ? error.message : "Unexpected error" });
    next(error);
  }
});
app.post("/api/orchestrate/:threadId/decision", async (req, res, next) => {
  try {
    const decision = req.body?.decision;
    if (!["approve", "reject"].includes(decision)) return res.status(400).json({ error: "decision must be approve or reject" });
    const thread = await getThread(req.params.threadId);
    if (!thread) return res.status(404).json({ error: "Suggestion expired or not found" });
    if (isSuggestionExpired(thread.suggestion)) return res.status(410).json({ error: "Cart expired. Build a fresh Swiggy cart." });
    await updateThread(req.params.threadId, decision === "approve" ? "approved" : "rejected");
    if (decision === "reject") return res.json({ status: "rejected" });
    res.json({ status: "approved", order: await placeOrder(thread.suggestion, readSwiggySession(req)) });
  } catch (error) { next(error); }
});
app.use((error, _req, res, _next) => { console.error(error); res.status(error?.name === "ZodError" ? 400 : 500).json({ error: error instanceof Error ? error.message : "Unexpected error" }); });

function readSwiggySession(req) {
  const session = req.get("x-swiggy-session-id");
  return session && /^[\w-]{20,80}$/.test(session) ? session : undefined;
}

export function isSuggestionExpired(suggestion, now = Date.now()) {
  const expiresAt = Date.parse(suggestion?.expiresAt || "");
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function authResultPage(success, title, detail) {
  const safe = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${safe(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f0e6;color:#191915;font:16px system-ui}.card{width:min(420px,calc(100% - 48px));padding:32px;border-radius:24px;background:#fff;box-shadow:0 24px 80px #342d1c1f;text-align:center}.mark{margin:auto;width:52px;height:52px;display:grid;place-items:center;border-radius:18px;background:${success ? "#258a55" : "#c94932"};color:#fff;font-size:25px}h1{font:30px Georgia;margin:20px 0 8px}p{color:#716b5f;line-height:1.5}</style><main class="card"><div class="mark">${success ? "✓" : "!"}</div><h1>${safe(title)}</h1><p>${safe(detail)}</p></main>`;
}
