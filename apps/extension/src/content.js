import { frameFeatures, selectKeyframe } from "./detector.js";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { io } from "socket.io-client";
import QRCode from "qrcode";
import { createCartBuildLock } from "./cart-build-lock.js";
import { historyThemeCss, interfaceThemeCss } from "./theme.js";
import { formatTranscriptContext, getTranscriptContext } from "./transcript.js";

const state = { running: false, navigationVersion: 0, lastTrigger: -120, lastPlaybackTime: null, replayPending: false, cache: [], videoId: "", modelStatus: "idle", lastResult: null, vlmStatus: "idle", vlmResult: null, error: "", agentSocket: null, agentEvents: [], foodHistory: [], carts: [], cartsHidden: false, themeMode: "system" };
const cartBuildLock = createCartBuildLock();
const fallbackDecisions = new Map();
const VIDEO_STORE_PREFIX = "cravelens:video:";
const CART_STORE_SUFFIX = ":session-carts";
const DETECTOR_OVERLAY_TTL_MS = 350;
const DEFAULT_SCAN_INTERVAL_MS = 4000;
const MIN_SCAN_INTERVAL_MS = 2000;
const MAX_SCAN_INTERVAL_MS = 30000;
let detectorOverlayTimer;
let detectorScanTimer;
let paymentPollTimer;
let paymentCountdownTimer;
let initializeTimer;
let extensionContextStopped = false;
const api = (path, options = {}) => chrome.runtime.sendMessage({ type: "CRAVELENS_API", path, ...options }).then((r) => { if (!r.ok) throw new Error(r.error); return r.data; });
const settings = async () => {
  if (extensionContextStopped || !chrome.runtime?.id) throw new Error("Extension context invalidated.");
  try {
    return await chrome.storage.local.get({ enabled: true, debug: false, apiUrl: "http://localhost:8787", addressId: "", addressLabel: "", sensitivity: .38, scanIntervalMs: DEFAULT_SCAN_INTERVAL_MS, themeMode: "system", personalContext: "" });
  } catch (error) {
    if (isExtensionContextInvalidated(error)) stopInvalidatedExtensionContext();
    throw error;
  }
};
const normalizeScanInterval = (value) => Math.max(MIN_SCAN_INTERVAL_MS, Math.min(MAX_SCAN_INTERVAL_MS, Number(value) || DEFAULT_SCAN_INTERVAL_MS));

function getVideoId() {
  const url = new URL(location.href);
  if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/").filter(Boolean)[1] || "";
  return url.searchParams.get("v") || "";
}

function getActiveVideo() {
  const videos = [...document.querySelectorAll("video")];
  const visible = (video) => {
    const rect = video.getBoundingClientRect();
    const style = getComputedStyle(video);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  return videos.find((video) => !video.paused && video.readyState >= 2 && visible(video))
    || videos.find((video) => video.readyState >= 2 && visible(video))
    || videos.find((video) => !video.paused && video.readyState >= 2)
    || videos[0];
}

const isCurrentNavigation = (version) => version === state.navigationVersion;

function observePlaybackPosition(video) {
  const currentTime = Number(video?.currentTime);
  if (!Number.isFinite(currentTime)) return;
  if (Number.isFinite(state.lastPlaybackTime) && currentTime < state.lastPlaybackTime - .75) {
    state.lastTrigger = -120;
    state.replayPending = true;
    state.lastResult = null;
    state.error = "";
    removeDetectorOverlay();
    console.info(`[CraveLens] Replay or backward seek detected (${state.lastPlaybackTime.toFixed(1)}s → ${currentTime.toFixed(1)}s); scan gates reset`);
  }
  state.lastPlaybackTime = currentTime;
}
function capture(video, width = 320) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = Math.round(width * video.videoHeight / video.videoWidth);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return { canvas, imageData: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

async function burst(video) {
  const frames = [];
  for (let i = 0; i < 6; i++) {
    const shot = capture(video, 720); const features = frameFeatures(shot.imageData);
    frames.push({ ...features, timestamp: video.currentTime, dataUrl: shot.canvas.toDataURL("image/jpeg", .82) });
    await new Promise((r) => setTimeout(r, 330));
  }
  return selectKeyframe(frames);
}

async function trigger(video, confidence, signature, { forceVerification = false, throwOnError = false } = {}) {
  const navigationVersion = state.navigationVersion;
  let cartBuildClaim;
  state.lastTrigger = video.currentTime;
  if (!forceVerification && state.foodHistory.some((entry) => Math.abs(Number(entry.timestamp) - video.currentTime) < 8)) {
    console.info("[CraveLens] Gemma skipped: this video timestamp was already confirmed");
    return;
  }
  if (!forceVerification && signature && state.foodHistory.some((entry) => histogramDistance(signature, entry.signature) < .11)) {
    console.info("[CraveLens] Gemma skipped: this visual scene was already confirmed");
    return;
  }
  closeAgentStream();
  let vlmConfirmed = false;
  try {
    const cfg = await settings();
    console.info("[CraveLens] ONNX-positive frame accepted; preparing local VLM keyframe");
    const keyframe = await burst(video);
    const frameTimestamp = Number.isFinite(keyframe.timestamp) ? keyframe.timestamp : video.currentTime;
    if (!isCurrentNavigation(navigationVersion)) return;
    state.vlmStatus = "running"; renderDebug();
    const liveCaptionTracks = await chrome.runtime.sendMessage({
      type: "CRAVELENS_YOUTUBE_CAPTION_TRACKS",
    }).then((response) => response?.tracks || []).catch(() => []);
    const transcriptContext = await getTranscriptContext({
      videoId: state.videoId,
      timestamp: frameTimestamp,
      captionTracks: liveCaptionTracks,
    }).catch((error) => {
      console.warn("[CraveLens] Transcript context unavailable; continuing with visual verification only:", error);
      return undefined;
    });
    console.info("[CraveLens] Sending keyframe to the configured VLM", {
      frameTimestamp,
      transcriptCues: transcriptContext
        ? transcriptContext.before.length + transcriptContext.at.length + transcriptContext.after.length
        : 0,
    });
    console.info("[CraveLens] VLM input context", {
      videoTitle: document.title.replace(" - YouTube", ""),
      frameTimestamp,
      captionTrackSource: liveCaptionTracks.length ? "live YouTube player" : "page metadata fallback",
      transcript: formatTranscriptContext(transcriptContext),
      frame: "[selected keyframe image omitted from console]",
    });
    const local = await chrome.runtime.sendMessage({
      type: "CRAVELENS_VLM_VERIFY",
      imageDataUrl: keyframe.dataUrl,
      videoTitle: document.title.replace(" - YouTube", ""),
      frameTimestamp,
      transcriptContext,
    });
    if (!isCurrentNavigation(navigationVersion)) return;
    if (!local?.ok) { state.vlmStatus = "failed"; renderDebug(); throw new Error(local?.error || "Local VLM verification failed"); }
    state.vlmStatus = "ready"; state.vlmResult = { ...local.verification, inferenceMs: local.vlmInferenceMs, timestamp: frameTimestamp }; renderDebug();
    if (!local.verification.isFood || local.verification.confidence < .65) return local.verification;
    vlmConfirmed = true;
    const dishKey = normalizeDish(local.verification.dish);
    const existing = state.foodHistory.find((entry) => entry.dishKey === dishKey);
    const existingCart = state.carts.find((cart) => normalizeDish(cart.detectedDish || cart.item) === dishKey && !isCartExpired(cart));
    if (existing && existingCart) {
      console.info(`[CraveLens] Agent flow skipped: an active ${local.verification.dish} cart already exists for this video`);
      return local.verification;
    }
    cartBuildClaim = cartBuildLock.claim(state.videoId, dishKey);
    if (!cartBuildClaim) {
      console.info(`[CraveLens] Agent flow skipped: a ${local.verification.dish} cart build is already in progress for this video`);
      return local.verification;
    }
    if (!existing) {
      state.foodHistory.push({ dish: local.verification.dish, dishKey, timestamp: frameTimestamp, confidence: local.verification.confidence, signature: signature || null, confirmedAt: Date.now() });
      persistVideoState();
    }
    state.agentEvents = [{ message: `${local.verification.dish} confirmed by the configured VLM`, state: "done" }, { message: "Connecting to the cart agent…", state: "active" }];
    showToast({ loading: true, dish: local.verification.dish });
    renderAgentEvents();
    const streamId = crypto.randomUUID();
    await connectAgentStream(cfg.apiUrl, streamId);
    if (!isCurrentNavigation(navigationVersion)) { closeAgentStream(); return; }
    const result = await api("/api/orchestrate", { method: "POST", body: {
      videoId: state.videoId,
      timestamp: frameTimestamp,
      triggerConfidence: confidence,
      verification: local.verification,
      videoTitle: document.title.replace(" - YouTube", ""),
      addressId: cfg.addressId || undefined,
      streamId,
      personalContext: String(cfg.personalContext || "").trim(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    } });
    if (!isCurrentNavigation(navigationVersion)) return;
    closeAgentStream();
    if (result.detected) {
      const cart = { ...result.suggestion, detectedDish: local.verification.dish, frameTimestamp, addedAt: Date.now(), status: "ready" };
      state.carts.push(cart); persistVideoState(); renderCartHistory(); showToast({ suggestion: cart });
    } else removeToast();
    return local.verification;
  } catch (error) {
    if (!isCurrentNavigation(navigationVersion)) return;
    closeAgentStream();
    state.error = error.message; renderDebug();
    if (vlmConfirmed) showToast({ error: error.message });
    if (throwOnError) throw error;
  } finally {
    cartBuildLock.release(cartBuildClaim);
  }
}

function normalizeDish(value) { return String(value || "food").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function histogramDistance(a, b) { return !a || !b ? Infinity : a.reduce((sum, value, index) => sum + Math.abs(value - (b[index] || 0)), 0); }
function storageKey() { return `${VIDEO_STORE_PREFIX}${state.videoId}`; }
function cartStorageKey() { return `${storageKey()}${CART_STORE_SUFFIX}`; }
function persistVideoState() {
  if (!state.videoId) return;
  localStorage.setItem(storageKey(), JSON.stringify({ foodHistory: state.foodHistory }));
  sessionStorage.setItem(cartStorageKey(), JSON.stringify({ carts: state.carts, cartsHidden: state.cartsHidden }));
}
function loadVideoState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) || "{}");
    const session = JSON.parse(sessionStorage.getItem(cartStorageKey()) || "{}");
    state.foodHistory = Array.isArray(saved.foodHistory) ? saved.foodHistory : [];
    state.carts = pruneExpiredCarts(Array.isArray(session.carts) ? session.carts : Array.isArray(saved.carts) ? saved.carts : []);
    state.cartsHidden = Boolean(session.cartsHidden);
    persistVideoState();
  } catch { state.foodHistory = []; state.carts = []; state.cartsHidden = false; }
}

function pruneExpiredCarts(carts) {
  return carts.filter((cart) => cart.status === "ordered" || !isCartExpired(cart));
}
function isCartExpired(cart) {
  const expiresAt = Date.parse(cart?.expiresAt || "");
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

function connectAgentStream(apiUrl, streamId) {
  return new Promise((resolve, reject) => {
    const socket = io(apiUrl, { transports: ["websocket"], reconnection: true, timeout: 8000 });
    state.agentSocket = socket;
    socket.on("agent:event", appendAgentEvent);
    socket.on("connect_error", (error) => reject(new Error(`Agent event stream unavailable: ${error.message}`)));
    socket.on("disconnect", () => reject(new Error("Agent event stream disconnected")));
    socket.on("connect", () => socket.timeout(5000).emit("agent:subscribe", streamId, (error, response) => {
      if (error || !response?.ok) reject(new Error(response?.error || "Unable to subscribe to agent progress"));
      else resolve();
    }));
  });
}

function closeAgentStream() {
  state.agentSocket?.disconnect();
  state.agentSocket = null;
}

function appendAgentEvent(payload) {
  if (["completed", "failed"].includes(payload.event) && payload.details?.runId) fallbackDecisions.delete(payload.details.runId);
  if (payload.event === "model:fallback-required" && payload.details?.runId) {
    void requestHostedFallbackDecision(payload.details);
  }
  const message = agentEventMessage(payload);
  if (!message) return;
  if (["tool_complete", "tool_failed"].includes(payload.event)) {
    const index = state.agentEvents.findLastIndex?.((item) => item.tool === payload.details?.tool) ?? -1;
    if (index >= 0) {
      state.agentEvents[index] = { ...state.agentEvents[index], message, state: payload.event === "tool_failed" ? "failed" : "done" };
      renderAgentEvents();
      return;
    }
  }
  state.agentEvents = state.agentEvents.map((item) => ({ ...item, state: item.state === "active" ? "done" : item.state }));
  state.agentEvents.push({ message, tool: payload.event === "tool_call" ? payload.details?.tool : undefined, state: payload.event === "failed" ? "failed" : ["cart_ready", "completed", "tool_complete"].includes(payload.event) ? "done" : "active" });
  state.agentEvents = state.agentEvents.slice(-6);
  renderAgentEvents();
}

async function requestHostedFallbackDecision(details) {
  const existingDecision = fallbackDecisions.get(details.runId);
  const approved = existingDecision === undefined
    ? window.confirm(`The local ${details.provider || "AI"} model stopped responding. Allow this cart run to send its model context to the configured ${details.hostedProvider || "hosted"} provider? No order will be placed without your normal confirmation.`)
    : existingDecision;
  fallbackDecisions.set(details.runId, approved);
  try {
    await api(`/api/orchestrate/${encodeURIComponent(details.runId)}/fallback`, { method: "POST", body: { decision: approved ? "approve" : "deny" } });
    state.agentEvents.push({ message: approved ? "Hosted fallback approved for this run" : "Hosted fallback denied", state: approved ? "active" : "failed" });
    renderAgentEvents();
  } catch (error) {
    fallbackDecisions.delete(details.runId);
    state.agentEvents.push({ message: `Fallback decision failed: ${error.message}`, state: "failed" });
    renderAgentEvents();
  }
}

function agentEventMessage({ event, details = {} }) {
  const tools = {
    get_addresses: "Checking your selected delivery address",
    get_food_orders: "Reviewing your recent orders",
    get_food_order_details: "Learning your food preferences",
    search_restaurants: "Finding open restaurants nearby",
    search_menu: "Searching orderable menu matches",
    get_restaurant_menu: "Comparing menu options",
    flush_food_cart: "Refreshing the Swiggy cart",
    update_food_cart: "Adding the best match to your cart",
    get_food_cart: "Verifying prices and charges",
    fetch_food_coupons: "Looking for applicable offers",
    apply_food_coupon: "Applying the best available offer",
    metadata_retry: "Refreshing restaurant details",
  };
  if (event === "orchestration_started") return `Preparing a ${details.dish || "food"} cart`;
  if (event === "orchestration_joined") return `Using the ${details.dish || "food"} cart build already in progress`;
  if (event === "customization_started") return "Understanding your requested changes";
  if (event === "started") return "Personalization agent started";
  if (event === "tools_ready") return `${details.count || 0} Swiggy tools connected`;
  if (event === "reasoning_started") return "Planning the best cart for you";
  if (event === "model:fallback-required") return "Waiting for approval before using a hosted model";
  if (event === "model:fallback-approved") return `Hosted fallback approved · continuing with ${details.hostedProvider || "the configured provider"}`;
  if (event === "metadata_retry") return tools.metadata_retry;
  if (event === "tool_call") return tools[details.tool] || `Using ${String(details.tool || "Swiggy")}`;
  if (event === "tool_skipped") return details.reason === "DUPLICATE_SEARCH"
    ? "Skipping a repeated search"
    : "Search limit reached · choosing from current results";
  if (event === "tool_complete") return tools[details.tool] ? `${tools[details.tool]} · done` : null;
  if (event === "completed") return "Cart research and personalization complete";
  if (event === "cart_ready") return `Cart ready from ${details.restaurant || "Swiggy"}`;
  if (event === "failed" || event === "tool_failed") return details.error || "The cart agent hit an error";
  return null;
}

function renderAgentEvents() {
  const list = document.getElementById("cravelens-root")?.shadowRoot?.getElementById("agent-events");
  if (!list) return;
  list.innerHTML = state.agentEvents.map((item) => `<li class="${item.state}"><i></i><span>${escapeHtml(item.message)}</span></li>`).join("");
  list.lastElementChild?.scrollIntoView({ block: "nearest" });
}

async function tick() {
  const navigationVersion = state.navigationVersion;
  const video = getActiveVideo(); const cfg = await settings();
  if (video) observePlaybackPosition(video);
  if (!cfg.enabled || !video || video.paused || video.readyState < 2 || state.running) return;
  state.running = true;
  try {
    const cached = state.cache.find((d) => video.currentTime >= d.startTime && video.currentTime <= d.endTime);
    if (video.currentTime - state.lastTrigger <= 45 && !cached) return;
    if (cached) await triggerScheduledDetection(video, cached.confidence);
    else {
      const shot = capture(video, 640);
      const result = await detectFood(shot.canvas, cfg.sensitivity);
      if (!isCurrentNavigation(navigationVersion)) return;
      state.lastResult = { ...result, timestamp: video.currentTime, source: "scheduled" }; state.error = ""; renderDebug();
      if (result.detections.length) {
        console.info(`[CraveLens] Scheduled ONNX scan found ${result.detections.length} food detection(s)`);
        await triggerScheduledDetection(video, result.detections[0].score, frameFeatures(shot.imageData).histogram);
      }
    }
  } catch (error) { if (isCurrentNavigation(navigationVersion)) { state.error = error.message; renderDebug(); } }
  finally { if (isCurrentNavigation(navigationVersion)) state.running = false; }
}

async function triggerScheduledDetection(video, confidence, signature) {
  const navigationVersion = state.navigationVersion;
  const replayVerification = state.replayPending;
  const verification = await trigger(video, confidence, signature, { forceVerification: replayVerification });
  if (!isCurrentNavigation(navigationVersion)) return;
  if (replayVerification && verification) state.replayPending = false;
  else if (replayVerification) state.lastTrigger = -120;
}

function scheduleDetectorScan(delay = DEFAULT_SCAN_INTERVAL_MS) {
  if (extensionContextStopped) return;
  clearTimeout(detectorScanTimer);
  detectorScanTimer = setTimeout(runScheduledDetectorScan, normalizeScanInterval(delay));
}

async function runScheduledDetectorScan() {
  let delay = DEFAULT_SCAN_INTERVAL_MS;
  try {
    await tick();
    delay = (await settings()).scanIntervalMs;
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      stopInvalidatedExtensionContext();
      return;
    }
    state.error = error.message;
    renderDebug();
  } finally {
    if (!extensionContextStopped) scheduleDetectorScan(delay);
  }
}

async function detectFood(canvas, threshold, forceDebug = false) {
  state.modelStatus = "running"; renderDebug(forceDebug);
  const response = await chrome.runtime.sendMessage({ type: "CRAVELENS_YOLO_DETECT", imageDataUrl: canvas.toDataURL("image/jpeg", .82), threshold });
  if (!response?.ok) throw new Error(response?.error || "YOLO inference failed");
  state.modelStatus = "ready";
  const { debug } = await settings();
  if (debug || forceDebug) renderDetectorOverlay(response.detections); else removeDetectorOverlay();
  return response;
}

function removeDetectorOverlay() {
  clearTimeout(detectorOverlayTimer); detectorOverlayTimer = undefined;
  document.getElementById("cravelens-detection-overlay")?.remove();
}
function renderDetectorOverlay(detections) {
  const video = getActiveVideo();
  if (!video?.parentElement) return;
  if (!detections.length) { removeDetectorOverlay(); return; }
  let canvas = document.getElementById("cravelens-detection-overlay");
  if (!canvas) {
    canvas = document.createElement("canvas"); canvas.id = "cravelens-detection-overlay";
    canvas.style.cssText = "position:absolute;pointer-events:none;z-index:2147483645;background:transparent";
    video.parentElement.append(canvas);
  }
  const dpr = devicePixelRatio || 1; const width = video.clientWidth; const height = video.clientHeight;
  canvas.style.left = `${video.offsetLeft}px`; canvas.style.top = `${video.offsetTop}px`; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  const context = canvas.getContext("2d"); context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
  for (const box of detections) {
    const x = box.x1 * width; const y = box.y1 * height; const w = (box.x2 - box.x1) * width; const h = (box.y2 - box.y1) * height;
    const label = `${box.label} ${(box.score * 100).toFixed(0)}%`;
    context.strokeStyle = "#65e887"; context.lineWidth = 3; context.strokeRect(x, y, w, h);
    context.font = "700 13px Inter,Arial,sans-serif"; const labelWidth = context.measureText(label).width + 16;
    context.fillStyle = "#176b36"; context.fillRect(x, Math.max(0, y - 25), labelWidth, 25);
    context.fillStyle = "white"; context.fillText(label, x + 8, Math.max(17, y - 8));
  }
  clearTimeout(detectorOverlayTimer);
  detectorOverlayTimer = setTimeout(removeDetectorOverlay, DETECTOR_OVERLAY_TTL_MS);
}

async function debugScan(forceDebug = false) {
  const navigationVersion = state.navigationVersion;
  const video = getActiveVideo();
  if (!video || video.readyState < 2) throw new Error("No ready YouTube video found");
  state.running = true; state.error = ""; renderDebug(forceDebug);
  try {
    state.modelStatus = "bypassed";
    const result = { detections: [], allDetections: [], inferenceMs: 0, timestamp: video.currentTime, source: "manual · ONNX bypassed" };
    state.lastResult = result;
    renderDebug(forceDebug);
    console.info("[CraveLens] Manual scan bypassing ONNX and invoking the configured VLM directly");
    const verification = await trigger(video, 1, undefined, { forceVerification: true, throwOnError: true });
    if (!isCurrentNavigation(navigationVersion)) return result;
    return { ...result, verification };
  } catch (error) { if (isCurrentNavigation(navigationVersion)) state.error = error.message; throw error; }
  finally {
    if (isCurrentNavigation(navigationVersion)) {
      state.running = false; renderDebug(forceDebug);
      const { debug } = await settings();
      if (forceDebug && !debug) setTimeout(() => document.getElementById("cravelens-debug")?.remove(), 4500);
    }
  }
}

async function renderDebug(forceDebug = false) {
  let cfg;
  try {
    cfg = await settings();
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      stopInvalidatedExtensionContext();
      return;
    }
    throw error;
  }
  state.themeMode = cfg.themeMode || state.themeMode;
  document.getElementById("cravelens-debug")?.remove();
  if (!cfg.debug && !forceDebug) return;
  const video = getActiveVideo();
  const panel = document.createElement("div"); panel.id = "cravelens-debug";
  const top = state.lastResult?.allDetections?.map((item) => `${item.label} ${(item.score * 100).toFixed(0)}%`).join(" · ") || "No detections yet";
  const food = state.lastResult?.detections?.map((item) => `${item.label} ${(item.score * 100).toFixed(0)}%`).join(", ") || "none";
  const lightTheme = resolvedInterfaceTheme() === "light";
  const currentSecond = Math.floor(video?.currentTime || 0);
  const detectorTime = state.lastResult ? `${Number(state.lastResult.inferenceMs || 0).toLocaleString()} ms` : "—";
  const gemmaTime = state.vlmResult ? `${Number(state.vlmResult.inferenceMs || 0).toLocaleString()} ms` : "—";
  const gemmaResult = state.vlmResult
    ? `<div class="debug-gemma-result"><strong>${escapeHtml(state.vlmResult.dish || "Food")}</strong><b>${(state.vlmResult.confidence * 100).toFixed(0)}%</b></div><p>${state.vlmResult.isFood ? "Food detected" : "Not food"} · ${escapeHtml(humanizeDebugValue(state.vlmResult.context))}</p>`
    : `<div class="debug-gemma-empty">${escapeHtml(humanizeDebugValue(state.vlmStatus))}</div>`;
  panel.setAttribute("role", "status");
  panel.setAttribute("aria-live", "polite");
  panel.innerHTML = `<style>
    #cravelens-debug{--debug-bg:${lightTheme ? "linear-gradient(155deg,#ffffffdc,#f8f8f4b3)" : "linear-gradient(160deg,#181814dc,#0d0d0bc4)"};--debug-card:${lightTheme ? "#ffffff73" : "#ffffff07"};--debug-line:${lightTheme ? "#8f887b8f" : "#ffffff2e"};--debug-rule:${lightTheme ? "#1818141c" : "#ffffff12"};--debug-text:${lightTheme ? "#181814" : "#f8f5ea"};--debug-muted:${lightTheme ? "#716f65" : "#aaa69d"};--debug-coral:${lightTheme ? "#b74628" : "#ff8f6e"};--debug-coral-bg:${lightTheme ? "#fff0e8c7" : "#ff704310"};--debug-green:${lightTheme ? "#216a37" : "#9ce8ad"};--debug-green-bg:${lightTheme ? "#e6f4e9c7" : "#62c87a14"};position:fixed;left:16px;bottom:16px;width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 32px);z-index:2147483647;box-sizing:border-box;padding:14px;overflow:auto;border:1px solid var(--debug-line);border-radius:20px;background:var(--debug-bg);background-clip:padding-box;color:var(--debug-text);box-shadow:${lightTheme ? "0 20px 64px #1b1b1845,inset 0 1px 0 #ffffffed" : "0 24px 72px #0009,inset 0 1px 0 #ffffff18"};-webkit-backdrop-filter:blur(22px) saturate(130%);backdrop-filter:blur(22px) saturate(130%);font:10px/1.4 Inter,Arial,sans-serif;pointer-events:none}
    #cravelens-debug *{box-sizing:border-box}
    #cravelens-debug .debug-head{display:flex;align-items:center;justify-content:space-between;gap:9px;margin-bottom:10px}
    #cravelens-debug .debug-brand{display:flex;align-items:center;min-width:0;gap:7px}
    #cravelens-debug .debug-brand-mark{display:grid;place-items:center;width:27px;height:27px;flex:none;border-radius:9px;background:#ff6440;color:#fff;box-shadow:0 6px 18px #ff593733;font-size:14px}
    #cravelens-debug .debug-brand small,#cravelens-debug .debug-brand strong{display:block}
    #cravelens-debug .debug-brand small{color:var(--debug-coral);font-size:7px;font-weight:900;letter-spacing:1.3px}
    #cravelens-debug .debug-brand strong{margin-top:1px;font-size:11px;line-height:1.1}
    #cravelens-debug .debug-status{max-width:130px;overflow:hidden;padding:4px 7px;border:1px solid ${lightTheme ? "#8fc7a0" : "#62c87a32"};border-radius:8px;background:var(--debug-green-bg);color:var(--debug-green);font-size:7.5px;font-weight:800;text-overflow:ellipsis;white-space:nowrap}
    #cravelens-debug .debug-status.bad{border-color:${lightTheme ? "#e58c78" : "#ff796b38"};background:${lightTheme ? "#ffe7df" : "#ff796b18"};color:${lightTheme ? "#8f2918" : "#ff9d91"}}
    #cravelens-debug .debug-video{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:6px;margin-bottom:7px;padding:8px 9px;border:1px solid var(--debug-line);border-radius:12px;background:var(--debug-card);box-shadow:inset 0 1px 0 ${lightTheme ? "#fff" : "#ffffff0b"}}
    #cravelens-debug .debug-video span,#cravelens-debug .debug-row dt,#cravelens-debug .debug-stat span{color:var(--debug-muted);font-size:7px;font-weight:800;letter-spacing:.55px;text-transform:uppercase}
    #cravelens-debug .debug-video strong{overflow:hidden;font-size:9px;text-overflow:ellipsis;white-space:nowrap}
    #cravelens-debug .debug-video time{color:var(--debug-muted);font:8px ui-monospace,SFMono-Regular,monospace}
    #cravelens-debug .debug-detector{margin:0;padding:8px 9px;border:1px solid var(--debug-line);border-radius:12px;background:var(--debug-card);box-shadow:inset 0 1px 0 ${lightTheme ? "#fff" : "#ffffff0b"}}
    #cravelens-debug .debug-row{display:grid;grid-template-columns:62px minmax(0,1fr) auto;align-items:start;gap:6px;margin:0}
    #cravelens-debug .debug-row+.debug-row{margin-top:5px;padding-top:5px;border-top:1px solid var(--debug-rule)}
    #cravelens-debug .debug-row dd{min-width:0;margin:0;overflow-wrap:anywhere;font:9px/1.35 ui-monospace,SFMono-Regular,monospace}
    #cravelens-debug .debug-row em{color:var(--debug-muted);font:8px ui-monospace,SFMono-Regular,monospace;white-space:nowrap}
    #cravelens-debug .debug-gemma{margin-top:7px;padding:9px 10px;border:1px solid ${lightTheme ? "#e2b09f" : "#ff8d6a42"};border-radius:12px;background:var(--debug-coral-bg)}
    #cravelens-debug .debug-gemma-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--debug-coral);font-size:8px;font-weight:900;letter-spacing:1px;text-transform:uppercase}
    #cravelens-debug .debug-gemma-head time{font:9px ui-monospace,SFMono-Regular,monospace;letter-spacing:0;text-transform:none}
    #cravelens-debug .debug-gemma-result{display:flex;align-items:baseline;justify-content:space-between;gap:7px;margin-top:5px}
    #cravelens-debug .debug-gemma-result strong{font-size:13px;overflow-wrap:anywhere}
    #cravelens-debug .debug-gemma-result b{color:var(--debug-coral);font-size:11px}
    #cravelens-debug .debug-gemma p{margin:2px 0 0;color:${lightTheme ? "#65483e" : "#d7b8ae"};font-size:8px}
    #cravelens-debug .debug-gemma-empty{margin-top:5px;color:var(--debug-muted);font-weight:750}
    #cravelens-debug .debug-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:7px}
    #cravelens-debug .debug-stat{display:flex;align-items:center;justify-content:space-between;gap:4px;padding:7px 8px;border:1px solid var(--debug-line);border-radius:10px;background:var(--debug-card);box-shadow:inset 0 1px 0 ${lightTheme ? "#fff" : "#ffffff0b"}}
    #cravelens-debug .debug-stat b{font:800 10px ui-monospace,SFMono-Regular,monospace}
  </style><div class="debug-head"><div class="debug-brand"><span class="debug-brand-mark">◉</span><div><small>CRAVELENS</small><strong>Detection debug</strong></div></div><div class="debug-status ${state.error ? "bad" : ""}">${escapeHtml(state.error || `ONNX ${state.modelStatus}${state.running ? " · scanning" : ""}`)}</div></div><div class="debug-video"><span>Video</span><strong>${escapeHtml(state.videoId || "—")}</strong><time>@ ${currentSecond}s</time></div><dl class="debug-detector"><div class="debug-row"><dt>Detector</dt><dd>${escapeHtml(state.lastResult?.source || "—")}</dd><em>${detectorTime}</em></div><div class="debug-row"><dt>Food gate</dt><dd>${escapeHtml(food)}</dd><em></em></div><div class="debug-row"><dt>Boxes</dt><dd>${escapeHtml(top)}</dd><em></em></div></dl><section class="debug-gemma"><div class="debug-gemma-head"><span>Configured VLM</span><time>${gemmaTime}</time></div>${gemmaResult}</section><div class="debug-stats"><div class="debug-stat"><span>Foods</span><b>${state.foodHistory.length}</b></div><div class="debug-stat"><span>Carts</span><b>${state.carts.length}</b></div><div class="debug-stat"><span>Frame</span><b>${state.vlmResult ? `${Math.floor(state.vlmResult.timestamp)}s` : `${currentSecond}s`}</b></div></div>`;
  document.body.append(panel);
}

function humanizeDebugValue(value) {
  const text = String(value || "pending").replace(/[_-]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "Pending";
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "CRAVELENS_PING") { respond({ ok: true }); return; }
  if (message.type === "CRAVELENS_DEBUG_SCAN") { debugScan(Boolean(message.forceDebug)).then((result) => respond({ ok: true, result })).catch((error) => respond({ ok: false, error: error.message })); return true; }
  if (message.type === "CRAVELENS_DEBUG_CHANGED") { renderDebug(); respond({ ok: true }); }
  if (message.type === "CRAVELENS_ENABLED_CHANGED") { handleEnabledChange(); respond({ ok: true }); }
  if (message.type === "CRAVELENS_THEME_CHANGED") { updateInterfaceTheme(message.themeMode); respond({ ok: true }); }
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.debug) { renderDebug(); if (!changes.debug.newValue) removeDetectorOverlay(); }
  if (changes.enabled) handleEnabledChange(changes.enabled.newValue);
  if (changes.scanIntervalMs) scheduleDetectorScan(changes.scanIntervalMs.newValue);
  if (changes.themeMode) updateInterfaceTheme(changes.themeMode.newValue);
});

async function handleEnabledChange(enabled) {
  const active = typeof enabled === "boolean" ? enabled : (await settings()).enabled;
  if (active) return;
  state.running = false;
  closeAgentStream();
  removeToast();
  removeDetectorOverlay();
  document.getElementById("cravelens-debug")?.remove();
}

async function initialize() {
  const id = getVideoId();
  if (!id) {
    if (state.videoId) {
      state.navigationVersion += 1;
      state.running = false;
      closeAgentStream();
      state.videoId = ""; state.lastPlaybackTime = null; state.replayPending = false; state.cache = []; state.foodHistory = []; state.carts = [];
      document.getElementById("cravelens-cart-history")?.remove();
      removeToast(); removeDetectorOverlay();
    }
    return;
  }
  if (id === state.videoId) return;
  const navigationVersion = ++state.navigationVersion;
  state.running = false;
  closeAgentStream();
  document.getElementById("cravelens-cart-history")?.remove(); removeToast();
  removeDetectorOverlay();
  state.videoId = id; state.cache = []; state.lastTrigger = -120; state.lastPlaybackTime = null; state.replayPending = false; state.vlmStatus = "idle"; state.vlmResult = null;
  console.info(`[CraveLens] YouTube navigation detected; initialized video ${id}`);
  loadVideoState(); renderCartHistory();
  scheduleDetectorScan(500);
  try {
    const detections = (await api(`/api/videos/${id}/detections`)).detections;
    if (isCurrentNavigation(navigationVersion) && state.videoId === id) state.cache = detections;
  } catch { /* local detection remains available */ }
}

document.addEventListener("yt-navigate-finish", queueInitialize);
document.addEventListener("yt-page-data-updated", queueInitialize);
window.addEventListener("popstate", queueInitialize);
document.addEventListener("pause", (event) => { if (event.target instanceof HTMLVideoElement) removeDetectorOverlay(); }, true);
document.addEventListener("seeking", (event) => { if (event.target instanceof HTMLVideoElement) { observePlaybackPosition(event.target); removeDetectorOverlay(); } }, true);
document.addEventListener("timeupdate", (event) => { if (event.target instanceof HTMLVideoElement) observePlaybackPosition(event.target); }, true);
document.addEventListener("ended", (event) => { if (event.target instanceof HTMLVideoElement) removeDetectorOverlay(); }, true);

function removeToast() {
  clearTimeout(paymentPollTimer); clearInterval(paymentCountdownTimer);
  paymentPollTimer = undefined; paymentCountdownTimer = undefined;
  document.getElementById("cravelens-root")?.remove();
}

function queueInitialize() {
  if (extensionContextStopped) return;
  void initialize().catch((error) => {
    if (isExtensionContextInvalidated(error)) stopInvalidatedExtensionContext();
    else console.warn("[CraveLens] Page initialization failed:", error);
  });
}

function isExtensionContextInvalidated(error) {
  return !chrome.runtime?.id || /extension context invalidated/i.test(error?.message || String(error || ""));
}

function stopInvalidatedExtensionContext() {
  if (extensionContextStopped) return;
  extensionContextStopped = true;
  clearInterval(initializeTimer);
  clearTimeout(detectorScanTimer);
  clearTimeout(detectorOverlayTimer);
  clearTimeout(paymentPollTimer);
  clearInterval(paymentCountdownTimer);
  state.running = false;
  state.agentSocket?.disconnect();
  state.agentSocket = null;
  document.getElementById("cravelens-debug")?.remove();
  document.getElementById("cravelens-detection-overlay")?.remove();
}
function resolvedInterfaceTheme(mode = state.themeMode) {
  return mode === "dark" || mode === "light"
    ? mode
    : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function applyThemeToHost(host) {
  if (host) host.dataset.theme = resolvedInterfaceTheme();
}
function updateInterfaceTheme(mode = "system") {
  state.themeMode = ["system", "light", "dark"].includes(mode) ? mode : "system";
  applyThemeToHost(document.getElementById("cravelens-root"));
  applyThemeToHost(document.getElementById("cravelens-cart-history"));
  renderDebug();
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (state.themeMode === "system") updateInterfaceTheme("system");
});
function renderCartHistory() {
  document.getElementById("cravelens-cart-history")?.remove();
  const activeCarts = pruneExpiredCarts(state.carts);
  if (activeCarts.length !== state.carts.length) {
    state.carts = activeCarts;
    persistVideoState();
  }
  if (!state.videoId || !state.carts.length) return;
  const root = document.createElement("div"); root.id = "cravelens-cart-history";
  applyThemeToHost(root);
  const shadow = root.attachShadow({ mode: "open" });
  const carts = [...state.carts].reverse().map((cart) => {
    const action = cartAction(cart);
    const cartName = cart.detectedDish || cart.item;
    return `<details data-thread="${escapeHtml(cart.threadId)}"><summary><span>${escapeHtml(cartName)}</span><small>${formatTimestamp(cart.frameTimestamp)} · ${escapeHtml(cartStatusLabel(cart))}</small></summary><div class="cart"><b>${escapeHtml(cart.item)}</b><span>${escapeHtml(cart.restaurant)}</span><div><strong>${currency(cart.finalAmount ?? cart.price)}</strong><span class="cart-actions"><button class="history-order" data-thread="${escapeHtml(cart.threadId)}" ${action.disabled ? "disabled" : ""}>${action.label}</button><button class="history-delete" data-thread="${escapeHtml(cart.threadId)}" aria-label="Delete ${escapeHtml(cartName)} cart" title="Delete cart"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg></button></span></div></div></details>`;
  }).join("");
  shadow.innerHTML = `<style>:host{all:initial}${historyThemeCss}.panel,.reveal{position:fixed;left:20px;top:92px;z-index:2147483646;border-radius:18px;background:#12120ff2;color:#f6f2e8;border:1px solid #ffffff18;box-shadow:0 18px 60px #0008;font:13px/1.4 Inter,Arial,sans-serif}.panel{width:310px;max-height:calc(100vh - 130px);overflow:auto}.reveal{padding:11px 15px;color:#ff7043;font-size:10px;font-weight:900;letter-spacing:1.2px;cursor:pointer}.head{position:sticky;top:0;padding:14px 16px;background:#191915;color:#ff7043;font-size:10px;font-weight:900;letter-spacing:1.5px}.head-main{display:flex;align-items:center;justify-content:space-between;gap:10px}.head-title{display:flex;align-items:center;flex-wrap:wrap;gap:7px;min-width:0}.head b{color:#f6f2e8}.head button{display:grid;place-items:center;width:26px;height:26px;border:0;border-radius:8px;padding:0;background:#ffffff10;color:#bbb6aa;cursor:pointer}.head button:hover{background:#ffffff1c;color:white}.head svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.swiggy-powered{display:inline-flex;align-items:center;gap:4px;margin:0;padding:3px 5px;border:1px solid #fc801933;border-radius:999px;background:#2f1b0d;color:#ffad63;font-size:6px;font-weight:900;letter-spacing:.45px}.swiggy-powered img{display:block;width:auto;height:11px;object-fit:contain}:host([data-theme="light"]) .swiggy-powered{border-color:#fc80192b;background:#fff4ec;color:#a74900}details{border-top:1px solid #ffffff10}summary{padding:13px 16px;cursor:pointer;list-style:none}summary span,summary small{display:block}summary span{font-weight:750}summary small{color:#969288;margin-top:2px;font-size:10px}.cart{display:grid;gap:4px;padding:0 16px 15px;color:#aaa69c}.cart>b{color:#f6f2e8}.cart>div{display:flex;align-items:center;justify-content:space-between;margin-top:7px}.cart-actions{display:flex;align-items:center;gap:6px}.cart button{border:0;border-radius:9px;padding:8px 11px;background:#ff603d;color:white;font-weight:750;cursor:pointer}.cart button:disabled{background:#315b3d;color:#bde7c7;cursor:default}.cart .history-delete{display:grid;place-items:center;width:31px;height:31px;padding:0;border:1px solid #ffffff12;background:#ffffff09;color:#9e988e}.cart .history-delete:hover{border-color:#ff6b5155;background:#4b211b;color:#ff9a84}.cart .history-delete:disabled{border-color:#ffffff12;background:#ffffff09;color:#68645d;cursor:wait}.history-delete svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}</style>${state.cartsHidden ? `<button class="reveal">SHOW VIDEO CARTS · ${state.carts.length}</button>` : `<section class="panel"><div class="head"><div class="head-main"><span class="head-title"><span>CARTS FOR THIS VIDEO</span>${swiggyPoweredHtml()}</span><span><button class="hide" aria-label="Hide video carts" title="Hide video carts"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button><b>${state.carts.length}</b></span></div></div>${carts}</section>`}`;
  document.body.append(root);
  shadow.querySelectorAll(".history-order").forEach((button) => button.addEventListener("click", () => {
    const cart = state.carts.find((item) => item.threadId === button.dataset.thread);
    if (cart) showToast({ suggestion: cart });
  }));
  shadow.querySelectorAll(".history-delete").forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await deleteStoredCart(button.dataset.thread, button);
  }));
  shadow.querySelectorAll("details[data-thread]").forEach((details) => details.addEventListener("toggle", () => { if (details.open) { const cart = state.carts.find((item) => item.threadId === details.dataset.thread); if (cart) showToast({ suggestion: cart }); } }));
  shadow.querySelector(".hide")?.addEventListener("click", () => { state.cartsHidden = true; persistVideoState(); renderCartHistory(); });
  shadow.querySelector(".reveal")?.addEventListener("click", () => { state.cartsHidden = false; persistVideoState(); renderCartHistory(); });
}
function formatTimestamp(seconds) { const value = Math.max(0, Math.floor(Number(seconds) || 0)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`; }
function cartStatusLabel(cart) {
  if (cart.status === "ordered") return "Ordered";
  if (cart.status === "payment_pending") return "UPI payment pending";
  if (cart.status === "payment_failed") return "Payment expired";
  if (cart.status === "payment_cancelled") return "UPI payment cancelled";
  return cart.restaurant;
}
function cartAction(cart) {
  if (cart.status === "ordered") return { disabled: true, label: "Ordered" };
  if (cart.status === "payment_failed") return { disabled: true, label: "Expired" };
  if (cart.status === "payment_cancelled") return { disabled: true, label: "Cancelled" };
  if (cart.status === "payment_pending") return { disabled: false, label: "Finish UPI" };
  return { disabled: false, label: "Review & pay" };
}
async function deleteStoredCart(threadId, button) {
  const cart = state.carts.find((item) => item.threadId === threadId);
  if (!cart) return;
  button.disabled = true;
  try {
    if (cart.status === "payment_pending") {
      const payment = await api(`/api/orchestrate/${threadId}/cancel-payment`, { method: "POST" });
      if (payment.status === "paid") {
        const confirmed = await api(`/api/orchestrate/${threadId}/confirm-payment`, { method: "POST" });
        cart.status = "ordered"; cart.order = confirmed.order; persistVideoState(); renderCartHistory();
        showOrderSuccess(cart, confirmed.order);
        return;
      }
      if (payment.status === "ordered") {
        cart.status = "ordered"; cart.order = payment.order; persistVideoState(); renderCartHistory();
        showOrderSuccess(cart, payment.order);
        return;
      }
      if (!["cancelled", "failed"].includes(payment.status)) throw new Error("Payment is still being checked. Try again shortly.");
    } else if (!["ordered", "payment_failed", "payment_cancelled"].includes(cart.status)) {
      await api(`/api/orchestrate/${threadId}/decision`, { method: "POST", body: { decision: "reject" } }).catch(() => {});
    }
    state.carts = state.carts.filter((item) => item.threadId !== threadId);
    if (document.getElementById("cravelens-root")?.dataset.thread === threadId) removeToast();
    persistVideoState();
    renderCartHistory();
  } catch (error) {
    button.disabled = false;
    showNoticeToast("Couldn’t delete cart", error.message || "Please try again.");
  }
}
async function orderStoredCart(threadId, button, paymentMethod) {
  const cart = state.carts.find((item) => item.threadId === threadId);
  if (!cart || isCartExpired(cart)) {
    state.carts = pruneExpiredCarts(state.carts);
    persistVideoState();
    renderCartHistory();
    showToast({ error: "Cart expired. Build a fresh Swiggy cart." });
    return;
  }
  if (!["COD", "UPI"].includes(paymentMethod)) { button.textContent = "Choose a payment method"; return; }
  button.disabled = true; button.textContent = paymentMethod === "UPI" ? "Starting UPI…" : "Placing COD order…";
  try {
    const data = await api(`/api/orchestrate/${threadId}/decision`, { method: "POST", body: { decision: "approve", paymentMethod } });
    if (data.status === "payment_pending" || data.status === "payment_paid") {
      cart.status = "payment_pending"; cart.paymentMethod = "UPI"; cart.payment = data.payment; persistVideoState(); renderCartHistory();
      showPaymentToast(cart, data.payment);
      return;
    }
    cart.status = "ordered"; cart.paymentMethod = paymentMethod; cart.order = data.order; persistVideoState();
    renderCartHistory();
    showOrderSuccess(cart, data.order);
  } catch (error) { button.disabled = false; button.textContent = error.message || "Try again"; }
}
function showToast(view) {
  if (view.suggestion?.status === "payment_pending" && view.suggestion.payment) { showPaymentToast(view.suggestion, view.suggestion.payment); return; }
  if (view.suggestion?.status === "payment_cancelled") { showNoticeToast("UPI payment cancelled", "No order was placed. Build a fresh cart whenever you’re ready."); return; }
  if (view.suggestion?.status === "payment_failed") { showNoticeToast("UPI payment expired", "No order was placed. Build a fresh cart to try again."); return; }
  removeToast(); const root = document.createElement("div"); root.id = "cravelens-root";
  applyThemeToHost(root);
  if (view.suggestion || view.cart) root.dataset.thread = (view.suggestion || view.cart).threadId;
  const shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${toastCss}${productCss}${cartUiExtraCss}${agentEventCss}${paymentCss}${interfaceThemeCss}</style><aside>${brandRowHtml()}${view.loading ? `<div class="scan"><i></i></div><h3>That looked delicious.</h3><p class="loading-copy">${escapeHtml(view.dish)} was confirmed as food. Building a cart…</p><ol id="agent-events" class="agent-events"></ol>` : view.updating ? updatingCartHtml(view) : view.error ? `<h3>Couldn’t build your cart</h3><p>${escapeHtml(view.error)}</p><button class="quiet">Dismiss</button>` : suggestionHtml(view.suggestion, view)}</aside>`;
  document.body.append(root);
  if (view.loading || view.updating) renderAgentEvents();
  shadow.querySelector(".quiet")?.addEventListener("click", removeToast);
  shadow.querySelectorAll('input[name="payment-method"]').forEach((input) => input.addEventListener("change", () => updateConfirmButton(shadow, view.suggestion)));
  const customizationInput = shadow.querySelector(".customize-form textarea");
  for (const eventName of ["keydown", "keypress", "keyup"]) {
    customizationInput?.addEventListener(eventName, (event) => event.stopPropagation());
    shadow.querySelectorAll(".agent-follow-up-form input,.agent-follow-up-form textarea,.agent-follow-up-form select").forEach((control) =>
      control.addEventListener(eventName, (event) => event.stopPropagation()));
  }
  shadow.querySelectorAll(".expand-item-image").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    showExpandedItemImage(shadow, button.dataset.imageUrl, button.dataset.itemName, button.dataset.itemDescription);
  }));
  shadow.querySelector("img.restaurant-logo")?.addEventListener("error", (event) => {
    const fallback = document.createElement("span");
    fallback.className = "restaurant-logo restaurant-logo-fallback";
    fallback.setAttribute("aria-hidden", "true");
    fallback.textContent = event.currentTarget.dataset.fallbackLetter || "R";
    event.currentTarget.replaceWith(fallback);
  }, { once: true });
  shadow.querySelectorAll(".quantity-change").forEach((button) => button.addEventListener("click", async () => {
    const item = view.suggestion.receipt?.items?.find((candidate) => candidate.id === button.dataset.itemId);
    if (!item) return;
    const quantity = Number(button.dataset.quantity);
    if (quantity > item.quantity && item.requiresQuantityConfirmation) {
      const confirmed = await confirmSameCustomizations(shadow, item);
      if (!confirmed) return;
      await mutateStoredCart(view.suggestion, { action: "set_quantity", itemId: item.id, quantity, confirmSameCustomizations: true }, button, shadow);
      return;
    }
    await mutateStoredCart(view.suggestion, { action: "set_quantity", itemId: item.id, quantity }, button, shadow);
  }));
  shadow.querySelectorAll(".item-remove").forEach((button) => button.addEventListener("click", () => mutateStoredCart(view.suggestion, {
    action: "set_quantity", itemId: button.dataset.itemId, quantity: 0,
  }, button, shadow)));
  shadow.querySelector(".open-menu")?.addEventListener("click", () => showMenuPicker(shadow, view.suggestion));
  shadow.querySelectorAll(".promo-option").forEach((button) => button.addEventListener("click", () => selectPromo(view.suggestion, button.dataset.couponCode, button)));
  shadow.querySelector(".customize-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await customizeStoredCart(view.suggestion, event.currentTarget);
  });
  shadow.querySelector(".agent-follow-up-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitAgentFollowUp(view.suggestion, event.currentTarget);
  });
  shadow.querySelector(".order")?.addEventListener("click", async (event) => {
    const method = shadow.querySelector('input[name="payment-method"]:checked')?.value;
    await orderStoredCart(view.suggestion.threadId, event.currentTarget, method);
  });
  if (view.suggestion) {
    updateConfirmButton(shadow, view.suggestion);
    scrollToAgentInteraction(shadow, view.suggestion);
  }
}

function scrollToAgentInteraction(shadow, suggestion) {
  const responses = Array.isArray(suggestion.agentResponses) ? suggestion.agentResponses : [];
  const agentPrompt = separateAgentMessage(suggestion.rationale, suggestion.agentPrompt).agentPrompt;
  const hasFollowUp = Boolean(normalizeAgentFollowUp(suggestion.agentFollowUp) || agentPrompt);
  if (!responses.length && !hasFollowUp) return;

  const responseSection = shadow.querySelector(".agent-responses");
  const target = hasFollowUp ? shadow.querySelector(".agent-composer") : responseSection;
  const scroller = shadow.querySelector("aside");
  if (!target || !scroller) return;

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (responseSection) responseSection.scrollTop = responseSection.scrollHeight;
    const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const scrollerTop = scroller.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    scroller.scrollTo({
      top: Math.max(0, scroller.scrollTop + targetTop - scrollerTop - 14),
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }));
}

function updatingCartHtml(view) {
  return `<div class="scan"><i></i></div><div class="food-update" aria-hidden="true"><svg viewBox="0 0 64 64"><path class="steam steam-one" d="M24 25c-5-6 5-8 0-14"/><path class="steam steam-two" d="M39 25c-5-6 5-8 0-14"/><path class="bowl" d="M12 30h40c-1 13-8 20-20 20S13 43 12 30Z"/><path class="bowl" d="M24 51h16"/></svg></div><h3>Updating your cart</h3><p class="loading-copy">Applying “${escapeHtml(view.instruction)}” and verifying the new cart with Swiggy…</p><ol id="agent-events" class="agent-events"></ol>`;
}

function suggestionHtml(s, view = {}) {
  const receipt = s.receipt || { items: [], charges: [], subtotal: s.price || 0, discount: s.savings || 0, finalAmount: s.finalAmount ?? (s.price || 0) - (s.savings || 0) };
  const restaurantLogoUrl = safeImageUrl(s.restaurantLogoUrl);
  const restaurantFallbackLetter = String(s.restaurant || "R").trim().charAt(0).toUpperCase();
  const restaurantLogo = restaurantLogoUrl
    ? `<img class="restaurant-logo" src="${escapeHtml(restaurantLogoUrl)}" data-fallback-letter="${escapeHtml(restaurantFallbackLetter)}" alt="${escapeHtml(s.restaurant)} logo">`
    : `<span class="restaurant-logo restaurant-logo-fallback" aria-hidden="true">${escapeHtml(restaurantFallbackLetter)}</span>`;
  const restaurantMeta = [s.deliveryEta, s.restaurantLocation].filter(Boolean).map(escapeHtml).join("<i>·</i>");
  const restaurantRating = Number(s.restaurantRating || 0) > 0
    ? `<div class="restaurant-rating" aria-label="${escapeHtml(s.restaurantRating)} star restaurant rating"><b>${escapeHtml(s.restaurantRating)} ★</b>${Number(s.restaurantRatingCount || 0) > 0 ? `<small>${formatRatingCount(s.restaurantRatingCount)} ratings</small>` : ""}</div>`
    : "";
  const items = receipt.items.length ? receipt.items.map((item) => {
    const itemImageUrl = safeImageUrl(item.imageUrl);
    const itemImage = itemImageUrl ? expandableItemImage(itemImageUrl, item.name, "receipt-item-image", item.description) : "";
    const dietaryIcon = dietaryIconHtml(item.dietaryType);
    const productRating = Number(item.rating || 0) > 0
      ? `<span class="product-rating">★ ${escapeHtml(item.rating)}${Number(item.ratingCount || 0) > 0 ? ` <small>(${formatRatingCount(item.ratingCount)})</small>` : ""}</span>`
      : "";
    const description = item.description ? `<details class="item-description"><summary>Item description</summary><div tabindex="0">${escapeHtml(item.description)}</div></details>` : "";
    const original = Number(item.originalTotal || 0);
    const current = Number(item.total || 0);
    const price = original > current
      ? `<span style="display:flex;gap:7px;align-items:center"><del style="color:#77746d;font-size:11px">${currency(original)}</del><b>${currency(current)}</b></span>`
      : `<span>${currency(current)}</span>`;
    const controls = item.id ? `<div class="item-controls"><div class="quantity-control" aria-label="Quantity for ${escapeHtml(item.name)}"><button type="button" class="quantity-change" data-item-id="${escapeHtml(item.id)}" data-quantity="${Math.max(1, Number(item.quantity) - 1)}" ${Number(item.quantity) <= 1 ? "disabled" : ""} aria-label="Decrease ${escapeHtml(item.name)} quantity">−</button><span>${escapeHtml(item.quantity)}</span><button type="button" class="quantity-change" data-item-id="${escapeHtml(item.id)}" data-quantity="${Number(item.quantity) + 1}" aria-label="Increase ${escapeHtml(item.name)} quantity">+</button></div><button type="button" class="item-remove" data-item-id="${escapeHtml(item.id)}">Remove</button></div>` : "";
    return `<div class="receipt-row item"><div class="receipt-item">${itemImage}<div class="receipt-item-copy"><div class="receipt-item-name">${dietaryIcon}<b>${escapeHtml(item.name)}</b></div>${productRating}${description}${item.customizations?.length ? `<small>${item.customizations.map(escapeHtml).join(" · ")}</small>` : ""}${controls}</div></div>${price}</div>`;
  }).join("") : `<div class="receipt-row item"><b>${escapeHtml(s.item)}</b><span>${currency(receipt.subtotal)}</span></div>`;
  const charges = (receipt.charges || []).map((charge) => `<div class="receipt-row muted"><span>${escapeHtml(charge.label)}</span><span>${currency(charge.amount)}</span></div>`).join("");
  const discounts = Array.isArray(receipt.discounts) && receipt.discounts.length
    ? receipt.discounts
    : receipt.discount > 0 ? [{ label: s.coupon ? `Coupon ${s.coupon}` : "Swiggy savings", amount: receipt.discount }] : [];
  const discountRows = discounts.map((discount) =>
    `<div class="receipt-row discount"><span>${escapeHtml(discount.label)}</span><span>−${currency(discount.amount)}</span></div>`
  ).join("");
  const agentCopy = separateAgentMessage(s.rationale, s.agentPrompt);
  const rationale = safeAgentMarkdown(agentCopy.rationale);
  return `<div class="cart-surface"><div class="eyebrow">A craving, understood</div><header class="restaurant-head">${restaurantLogo}<div class="restaurant-copy"><h3>${escapeHtml(s.restaurant)}</h3>${restaurantMeta ? `<p>${restaurantMeta}</p>` : ""}</div>${restaurantRating}</header><section class="receipt"><div class="section-title-row"><div class="section-title">Cart summary</div><div class="receipt-heading-actions">${receipt.discount > 0 ? `<span class="deal">SAVE ${currency(receipt.discount)}</span>` : ""}<button type="button" class="open-menu">+ Add items</button></div></div><div class="cart-edit-status" role="status" aria-live="polite"></div><div class="receipt-items">${items}</div><div class="receipt-bill"><div class="receipt-row subtotal"><span>Item subtotal</span><span>${currency(receipt.subtotal)}</span></div>${charges}${discountRows}</div><div class="receipt-row total"><strong>To pay</strong><strong>${currency(receipt.finalAmount)}</strong></div>${promoHtml(s)}${s.cartLimitExceeded ? `<div class="cart-limit-warning">Reduce the cart below ₹1,000 before checkout.</div>` : ""}</section><div class="delivery"><span>⌖</span><div><small>DELIVERING TO</small><b>${escapeHtml(s.deliveryAddress || "Selected Swiggy address")}</b></div></div></div>${agentResponsesHtml(s)}${customizationHtml(s, view.customizationError, view.draftInstruction, agentCopy.agentPrompt, s.agentFollowUp)}<div class="checkout-surface">${paymentChoiceHtml(s)}<details><summary>Why this cart?</summary><div class="markdown">${rationale}</div></details><div class="actions"><button class="quiet">Not now</button><button class="order">Confirm · ${currency(receipt.finalAmount)}</button></div></div>`;
}

function promoHtml(s) {
  const promos = Array.isArray(s.availablePromos) ? s.availablePromos : [];
  if (!promos.length) {
    const message = s.promoLookupStatus === "unavailable"
      ? "Swiggy offer information is temporarily unavailable."
      : "Swiggy returned no promo codes for this cart.";
    return `<div class="promos promo-empty" role="status"><div class="promo-empty-copy"><span class="section-title">Available promo codes</span><small>${escapeHtml(message)}</small></div></div>`;
  }
  const selectedPromo = promos.find((promo) => promo.selected || promo.code === s.coupon);
  const orderedPromos = [...promos].sort((left, right) =>
    Number(right.selected || right.code === s.coupon) - Number(left.selected || left.code === s.coupon)
  );
  return `<details class="promos"><summary><span><span class="section-title">Available promo codes</span><small>${selectedPromo ? `${escapeHtml(selectedPromo.code)} · ${s.promoSelectionMode === "manual" ? "Selected by you" : "Best match selected"}` : "Choose an eligible offer"}</small></span><i aria-hidden="true"></i></summary><div class="promo-list" tabindex="0" aria-label="Available promo codes">${orderedPromos.map((promo) => {
    const selected = promo.selected || promo.code === s.coupon;
    const disabled = promo.selectable === false || !promo.applicable;
    const reason = promo.requiresOnlinePayment
      ? "Requires online payment"
      : promo.ineligibilityReason || promo.description || promo.title;
    return `<button type="button" class="promo-option ${selected ? "selected" : ""}" data-coupon-code="${escapeHtml(promo.code)}" ${disabled ? "disabled" : ""}><span><b>${escapeHtml(promo.code)}</b><small>${escapeHtml(reason)}</small></span><span class="promo-badges">${promo.bestMatch ? `<em class="best-match">BEST MATCH</em>` : ""}${promo.requiresOnlinePayment ? `<em class="online-payment">ONLINE PAYMENT</em>` : ""}${!promo.applicable ? `<em class="not-eligible">NOT ELIGIBLE</em>` : ""}${selected ? `<i class="selected-badge">${s.promoSelectionMode === "manual" ? "SELECTED" : "AUTO-SELECTED"}</i>` : ""}</span></button>`;
  }).join("")}</div></details>`;
}

function agentResponsesHtml(s) {
  const responses = Array.isArray(s.agentResponses) ? s.agentResponses : [];
  if (!responses.length) return "";
  return `<section class="agent-responses"><div class="agent-response-title"><span aria-hidden="true">✦</span><div><small>AGENT UPDATES</small><b>What changed</b></div></div>${responses.map((entry, index) => `<article ${index === responses.length - 1 ? 'class="latest"' : ""}><blockquote class="agent-instruction"><small>Your request</small>${escapeHtml(entry.instruction)}</blockquote><div class="agent-answer"><small>Agent response</small>${safeAgentMarkdown(entry.response)}</div></article>`).join("")}</section>`;
}

function formatRatingCount(value) {
  return Math.max(0, Number(value) || 0).toLocaleString("en-IN");
}

function safeAgentMarkdown(value) {
  return DOMPurify.sanitize(marked.parse(String(value || ""), { async: false, breaks: true }), {
    ALLOWED_TAGS: ["p", "strong", "em", "ul", "ol", "li", "code", "br"],
    ALLOWED_ATTR: [],
  });
}

function separateAgentMessage(rationale, explicitPrompt = "") {
  if (explicitPrompt) return { rationale: String(rationale || ""), agentPrompt: String(explicitPrompt) };
  const text = String(rationale || "");
  const match = text.match(/\n\s*(?=(?:Would you like(?:\s+me)?\s+to|Which (?:option|one)|What would you prefer|Please (?:choose|select|confirm))\b)/i);
  if (match?.index === undefined) return { rationale: text, agentPrompt: "" };
  return {
    rationale: text.slice(0, match.index).trim(),
    agentPrompt: text.slice(match.index).trim(),
  };
}

function expandableItemImage(url, itemName, imageClass, itemDescription = "") {
  return `<button type="button" class="expand-item-image" data-image-url="${escapeHtml(url)}" data-item-name="${escapeHtml(itemName)}" data-item-description="${escapeHtml(itemDescription)}" aria-label="Expand image of ${escapeHtml(itemName)}" title="Expand image"><img class="${imageClass}" src="${escapeHtml(url)}" alt="${escapeHtml(itemName)}"></button>`;
}

function showExpandedItemImage(shadow, url, itemName, itemDescription = "") {
  if (!url) return;
  shadow.querySelector(".item-image-lightbox")?.remove();
  const dialog = document.createElement("dialog");
  dialog.className = "item-image-lightbox";
  dialog.setAttribute("aria-label", `${itemName || "Cart item"} image`);
  dialog.innerHTML = `<div><button type="button" class="image-lightbox-close" aria-label="Close expanded image" title="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button><img src="${escapeHtml(url)}" alt="${escapeHtml(itemName || "Cart item")}"><div class="image-lightbox-copy"><p class="image-lightbox-name">${escapeHtml(itemName || "Cart item")}</p>${itemDescription ? `<p class="image-lightbox-description">${escapeHtml(itemDescription)}</p>` : `<p class="image-lightbox-description muted">No item description is available.</p>`}</div></div>`;
  shadow.append(dialog);
  dialog.querySelector(".image-lightbox-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
}

function dietaryIconHtml(type) {
  if (!["veg", "non_veg"].includes(type)) return "";
  const label = type === "veg" ? "Vegetarian" : "Non-vegetarian";
  return `<span class="dietary-icon ${type}" role="img" aria-label="${label}" title="${label}"><i></i></span>`;
}

function genericFoodIconHtml() {
  return `<span class="menu-image-fallback" role="img" aria-label="Food item image unavailable"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M9 25h30c-.8 9.3-6.1 14-15 14S9.8 34.3 9 25Z"/><path d="M17 42h14M17 19c-3-3.8 3-5 0-9m8 9c-3-3.8 3-5 0-9m8 9c-3-3.8 3-5 0-9"/></svg></span>`;
}

function swiggyPoweredHtml() {
  return `<div class="swiggy-powered" aria-label="Powered by Swiggy"><span>Powered by</span><img src="${escapeHtml(swiggyLogoUrl())}" alt="Swiggy"></div>`;
}

function brandRowHtml() {
  return `<div class="brand-row"><div class="brand"><span>◉</span> CRAVELENS</div>${swiggyPoweredHtml()}</div>`;
}

function swiggyLogoUrl() {
  return chrome.runtime.getURL("provider-icons/swiggy.png");
}

function customizationHtml(s, error = "", draftInstruction = "", agentPrompt = "", agentFollowUp) {
  if (s.status !== "ready") return "";
  const followUp = normalizeAgentFollowUp(agentFollowUp);
  if (followUp) return agentFollowUpHtml(followUp, error);
  const prompt = agentPrompt ? `<div class="agent-question"><span aria-hidden="true"></span><div><small>CART AGENT NEEDS YOUR INPUT</small><div class="agent-question-copy">${safeAgentMarkdown(agentPrompt)}</div></div></div>` : "";
  const label = agentPrompt ? "Reply to the cart agent" : "Want to change anything?";
  const placeholder = agentPrompt ? "Type your choice or tell the agent what to do…" : "Make it vegetarian, add a drink, or choose something different";
  return `<section class="agent-composer">${prompt}<form class="customize-form"><label for="cravelens-custom-instruction">${label}</label><div><textarea id="cravelens-custom-instruction" name="instruction" maxlength="500" rows="2" placeholder="${placeholder}">${escapeHtml(draftInstruction)}</textarea><button type="submit" aria-label="Update cart" title="Update cart"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13m-5-5 5 5-5 5"/></svg></button></div><small class="customize-status ${error ? "error" : ""}" role="status">${escapeHtml(error || "The cart agent will continue this conversation.")}</small></form></section>`;
}

function normalizeAgentFollowUp(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.fields) || !value.fields.length) return undefined;
  const allowedTypes = new Set(["radio", "checkbox", "select", "text", "textarea"]);
  const fields = value.fields.slice(0, 4).filter((field) => field && /^[a-z][a-z0-9_]{0,39}$/i.test(field.id)
    && allowedTypes.has(field.type) && String(field.label || "").trim());
  if (!fields.length || fields.some((field) => ["radio", "checkbox", "select"].includes(field.type) && !field.options?.length)) return undefined;
  return { ...value, fields };
}

function agentFollowUpHtml(followUp, error = "") {
  const fields = followUp.fields.map((field) => {
    const required = field.required === false ? "" : "required";
    if (field.type === "select") {
      return `<label class="generated-field"><span>${escapeHtml(field.label)}</span><select name="${escapeHtml(field.id)}" ${required}><option value="">Choose one</option>${field.options.map((option) => `<option value="${escapeHtml(option.value)}" ${field.defaultValue === option.value ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select></label>`;
    }
    if (field.type === "text" || field.type === "textarea") {
      const control = field.type === "textarea"
        ? `<textarea name="${escapeHtml(field.id)}" rows="3" maxlength="300" placeholder="${escapeHtml(field.placeholder || "")}" ${required}></textarea>`
        : `<input type="text" name="${escapeHtml(field.id)}" maxlength="200" placeholder="${escapeHtml(field.placeholder || "")}" ${required}>`;
      return `<label class="generated-field"><span>${escapeHtml(field.label)}</span>${control}</label>`;
    }
    const defaults = new Set(Array.isArray(field.defaultValue) ? field.defaultValue : field.defaultValue ? [field.defaultValue] : []);
    return `<fieldset class="generated-field generated-options"><legend>${escapeHtml(field.label)}</legend>${field.options.map((option, index) => `<label><input type="${field.type}" name="${escapeHtml(field.id)}" value="${escapeHtml(option.value)}" ${defaults.has(option.value) ? "checked" : ""} ${field.type === "radio" && index === 0 ? required : ""}><i></i><span><b>${escapeHtml(option.label)}</b>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</span></label>`).join("")}</fieldset>`;
  }).join("");
  return `<section class="agent-composer generated-agent-ui"><div class="agent-question"><span aria-hidden="true"></span><div><small>CART AGENT NEEDS YOUR INPUT</small><div class="agent-question-copy"><strong>${escapeHtml(followUp.title)}</strong>${followUp.description ? `<p>${escapeHtml(followUp.description)}</p>` : ""}</div></div></div><form class="agent-follow-up-form">${fields}<button type="submit" class="generated-submit">${escapeHtml(followUp.submitLabel || "Continue")}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13m-5-5 5 5-5 5"/></svg></button><small class="customize-status ${error ? "error" : ""}" role="status">${escapeHtml(error || "Your selection will be sent to the cart agent.")}</small></form></section>`;
}

function confirmSameCustomizations(shadow, item) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "cart-editor-dialog confirm-customizations";
    dialog.innerHTML = `<div><button type="button" class="dialog-close" aria-label="Close">×</button><div class="dialog-icon">＋</div><h3>Use the same customizations?</h3><p>The additional ${escapeHtml(item.name)} will use the same variants and add-ons as the current item.</p><div class="dialog-actions"><button type="button" class="dialog-cancel">Cancel</button><button type="button" class="dialog-confirm">Use same choices</button></div></div>`;
    shadow.append(dialog);
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; resolve(value); dialog.close(); };
    dialog.querySelector(".dialog-close").addEventListener("click", () => finish(false));
    dialog.querySelector(".dialog-cancel").addEventListener("click", () => finish(false));
    dialog.querySelector(".dialog-confirm").addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
    dialog.addEventListener("close", () => { if (!settled) resolve(false); dialog.remove(); }, { once: true });
    dialog.showModal();
  });
}

async function mutateStoredCart(cart, mutation, button, shadow) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "…";
  setCartEditStatus(shadow, "Updating your cart with Swiggy…");
  try {
    const result = await api(`/api/orchestrate/${cart.threadId}/cart`, { method: "POST", body: mutation });
    if (result.status === "deleted") {
      state.carts = state.carts.filter((item) => item.threadId !== cart.threadId);
      persistVideoState();
      renderCartHistory();
      showNoticeToast("Cart cleared", "The final item was removed from your Swiggy cart.");
      return;
    }
    applyUpdatedSuggestion(cart, result.suggestion);
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    setCartEditStatus(shadow, error.message || "Couldn’t update the cart. Please try again.", true);
  }
}

function setCartEditStatus(shadow, message, isError = false) {
  const status = shadow?.querySelector(".menu-picker[open] .menu-mutation-status")
    || shadow?.querySelector(".cart-edit-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("error", isError);
  status.classList.toggle("visible", Boolean(message));
}

async function selectPromo(cart, couponCode, button) {
  if (!couponCode || couponCode === cart.coupon) return;
  button.disabled = true;
  try {
    const result = await api(`/api/orchestrate/${cart.threadId}/coupon`, { method: "POST", body: { couponCode } });
    applyUpdatedSuggestion(cart, result.suggestion);
  } catch (error) {
    button.disabled = false;
    showNoticeToast("Promo couldn’t be applied", error.message || "Choose another available promo.");
  }
}

function applyUpdatedSuggestion(cart, suggestion) {
  const localState = {
    detectedDish: cart.detectedDish,
    frameTimestamp: cart.frameTimestamp,
    addedAt: cart.addedAt,
    status: "ready",
    conversationId: suggestion.conversationId || cart.conversationId || cart.threadId,
  };
  Object.assign(cart, suggestion, localState);
  persistVideoState();
  renderCartHistory();
  showToast({ suggestion: cart });
}

async function showMenuPicker(shadow, cart) {
  const dialog = document.createElement("dialog");
  dialog.className = "cart-editor-dialog menu-picker";
  dialog.innerHTML = `<div><button type="button" class="dialog-close" aria-label="Close menu">×</button><div class="section-title">Add from ${escapeHtml(cart.restaurant)}</div><h3>Restaurant menu</h3><form class="menu-search" role="search"><input type="search" name="query" maxlength="80" autocomplete="off" placeholder="Search this restaurant's menu" aria-label="Search restaurant menu"><button type="submit" aria-label="Search menu"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg></button></form><div class="menu-filters" aria-label="Filter and sort menu"><div role="group" aria-label="Dietary preference"><button type="button" class="active" data-dietary="all">All</button><button type="button" data-dietary="veg">${dietaryIconHtml("veg")} Veg</button><button type="button" data-dietary="non_veg">${dietaryIconHtml("non_veg")} Non-veg</button></div><label>Sort <select aria-label="Sort menu items"><option value="recommended">Recommended</option><option value="price-asc">Cost: low to high</option><option value="price-desc">Cost: high to low</option></select></label></div><p class="menu-mutation-status" role="status" aria-live="polite"></p><p class="menu-state">Loading available items…</p><div class="menu-list"></div></div>`;
  shadow.append(dialog);
  dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
  for (const eventName of ["keydown", "keypress", "keyup"]) {
    dialog.querySelector(".menu-search input").addEventListener(eventName, (event) => event.stopPropagation());
  }
  let searchTimer;
  let searchRequest = 0;
  dialog.addEventListener("close", () => {
    clearTimeout(searchTimer);
    searchRequest += 1;
    dialog.remove();
  }, { once: true });
  dialog.showModal();
  const stateText = dialog.querySelector(".menu-state");
  const list = dialog.querySelector(".menu-list");
  let loadedItems = [];
  let loadedQuery = "";
  let dietaryFilter = "all";
  let sortOrder = "recommended";
  const visibleItems = () => {
    const filtered = dietaryFilter === "all" ? [...loadedItems] : loadedItems.filter((item) => item.dietaryType === dietaryFilter);
    if (sortOrder === "price-asc") filtered.sort((left, right) => Number(left.price || 0) - Number(right.price || 0));
    if (sortOrder === "price-desc") filtered.sort((left, right) => Number(right.price || 0) - Number(left.price || 0));
    return filtered;
  };
  const renderItems = () => {
    const items = visibleItems();
    stateText.textContent = items.length ? "" : loadedQuery ? `No matching menu items found for “${loadedQuery}”.` : "No menu items match these filters.";
    list.innerHTML = items.length ? items.map((item) => {
      const image = safeImageUrl(item.imageUrl);
      const rating = Number(item.rating || 0) > 0 ? `<span class="menu-item-rating" aria-label="${escapeHtml(item.rating)} star item rating">★ ${escapeHtml(item.rating)}${Number(item.ratingCount || 0) > 0 ? ` <small>(${formatRatingCount(item.ratingCount)})</small>` : ""}</span>` : "";
      return `<article>${image ? expandableItemImage(image, item.name, "menu-item-image", item.description) : genericFoodIconHtml()}<div><div class="menu-item-name">${dietaryIconHtml(item.dietaryType)}<b>${escapeHtml(item.name)}</b></div>${rating}${item.description ? `<small tabindex="0">${escapeHtml(item.description)}</small>` : ""}<strong>${currency(item.price)}</strong></div><button type="button" class="menu-add agent-add" data-item-id="${escapeHtml(item.id)}" data-item-name="${escapeHtml(item.name)}">Add</button></article>`;
    }).join("") : "";
    list.querySelectorAll(".expand-item-image").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      showExpandedItemImage(shadow, button.dataset.imageUrl, button.dataset.itemName, button.dataset.itemDescription);
    }));
    list.querySelectorAll(".menu-add").forEach((button) => button.addEventListener("click", async () => {
      const item = loadedItems.find((candidate) => candidate.id === button.dataset.itemId);
      if (!item) return;
      await addMenuItemWithAgent(cart, item, button);
    }));
  };
  const loadItems = async (query = "") => {
    const requestId = ++searchRequest;
    stateText.textContent = query ? `Searching for “${query}”…` : "Loading available items…";
    list.replaceChildren();
    try {
      const suffix = query ? `?q=${encodeURIComponent(query)}` : "";
      const data = await api(`/api/orchestrate/${cart.threadId}/menu${suffix}`);
      if (requestId !== searchRequest || !dialog.isConnected) return;
      loadedItems = Array.isArray(data.items) ? data.items : [];
      loadedQuery = query;
      renderItems();
    } catch (error) {
      if (requestId !== searchRequest || !dialog.isConnected) return;
      stateText.textContent = error.message || "Couldn’t load this menu.";
    }
  };
  dialog.querySelector(".menu-search").addEventListener("submit", async (event) => {
    event.preventDefault();
    clearTimeout(searchTimer);
    await loadItems(event.currentTarget.elements.query.value.trim());
  });
  dialog.querySelector(".menu-search input").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    const query = event.currentTarget.value.trim();
    searchTimer = setTimeout(() => loadItems(query), 320);
  });
  dialog.querySelectorAll("[data-dietary]").forEach((button) => button.addEventListener("click", () => {
    dietaryFilter = button.dataset.dietary;
    dialog.querySelectorAll("[data-dietary]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
    renderItems();
  }));
  dialog.querySelector(".menu-filters select").addEventListener("change", (event) => {
    sortOrder = event.currentTarget.value;
    renderItems();
  });
  try {
    await loadItems();
  } catch (error) {
    stateText.textContent = error.message || "Couldn’t load this menu.";
  }
}

async function addMenuItemWithAgent(cart, item, button) {
  const cfg = await settings();
  const itemIdentity = [item.id ? `Swiggy menu item ID ${item.id}` : "", Number(item.price || 0) > 0 ? `listed at ${currency(item.price)}` : ""].filter(Boolean).join(", ");
  const instruction = `Add ${item.name} from ${cart.restaurant} to this cart${itemIdentity ? ` (${itemIdentity})` : ""}. Use the exact orderable menu item and choose the lowest-cost required configuration that fits my current preferences. If a required choice cannot be safely inferred, keep the cart valid and ask me one concise question with the available options.`;
  const streamId = crypto.randomUUID();
  button.disabled = true;
  button.textContent = "Adding…";
  closeAgentStream();
  state.agentEvents = [
    { message: `${item.name} selected`, state: "done" },
    { message: "Asking the cart agent to add and verify it…", state: "active" },
  ];
  showToast({ updating: true, cart, instruction });
  renderAgentEvents();
  try {
    await connectAgentStream(cfg.apiUrl, streamId);
    const result = await api(`/api/orchestrate/${cart.threadId}/customize`, { method: "POST", body: {
      instruction,
      streamId,
      personalContext: String(cfg.personalContext || "").trim(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    } });
    closeAgentStream();
    applyUpdatedSuggestion(cart, result.suggestion);
  } catch (error) {
    closeAgentStream();
    showToast({ suggestion: cart, customizationError: error.message || "Couldn’t add that item." });
  }
}

async function customizeStoredCart(cart, form) {
  const input = form.elements.instruction;
  const status = form.querySelector(".customize-status");
  const instruction = input.value.trim();
  if (!instruction) {
    status.textContent = "Enter an instruction for the cart agent.";
    input.focus();
    return;
  }
  await runCartCustomization(cart, instruction, form, input);
}

async function submitAgentFollowUp(cart, form) {
  const followUp = normalizeAgentFollowUp(cart.agentFollowUp);
  const status = form.querySelector(".customize-status");
  if (!followUp) {
    status.textContent = "This question is no longer available. Reopen the cart and try again.";
    status.classList.add("error");
    return;
  }
  const data = new FormData(form);
  const answers = [];
  for (const field of followUp.fields) {
    const values = data.getAll(field.id).map((value) => String(value).trim()).filter(Boolean);
    if (field.required !== false && !values.length) {
      status.textContent = `Choose or enter an answer for “${field.label}”.`;
      status.classList.add("error");
      form.elements[field.id]?.focus?.();
      return;
    }
    if (!values.length) continue;
    const labels = values.map((value) => field.options?.find((option) => option.value === value)?.label || value);
    answers.push(`${field.label}: ${labels.join(", ")}`);
  }
  if (!answers.length) {
    status.textContent = "Choose at least one option before continuing.";
    status.classList.add("error");
    return;
  }
  const instruction = `Response to the cart agent's follow-up:\n${answers.join("\n")}`.slice(0, 500);
  await runCartCustomization(cart, instruction, form, form.querySelector("input,textarea,select"));
}

async function runCartCustomization(cart, instruction, form, focusControl) {
  const button = form.querySelector('button[type="submit"]');
  const status = form.querySelector(".customize-status");
  for (const control of form.querySelectorAll("input,textarea,select,button")) control.disabled = true;
  status.classList.remove("error");
  status.textContent = "Updating and verifying your cart…";
  closeAgentStream();
  const streamId = crypto.randomUUID();
  state.agentEvents = [
    { message: "Change request received", state: "done" },
    { message: "Connecting to the cart agent…", state: "active" },
  ];
  showToast({ updating: true, cart, instruction });
  renderAgentEvents();
  try {
    const cfg = await settings();
    await connectAgentStream(cfg.apiUrl, streamId);
    const result = await api(`/api/orchestrate/${cart.threadId}/customize`, { method: "POST", body: {
      instruction,
      streamId,
      personalContext: String(cfg.personalContext || "").trim(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    } });
    closeAgentStream();
    const localState = {
      detectedDish: cart.detectedDish,
      frameTimestamp: cart.frameTimestamp,
      addedAt: cart.addedAt,
      status: "ready",
      conversationId: result.conversationId || cart.conversationId || cart.threadId,
      lastInstruction: instruction,
    };
    Object.assign(cart, result.suggestion, localState);
    persistVideoState();
    renderCartHistory();
    showToast({ suggestion: cart });
  } catch (error) {
    closeAgentStream();
    showToast({ suggestion: cart, customizationError: error.message || "Couldn’t update the cart. Try again.", draftInstruction: instruction });
    const nextShadow = document.getElementById("cravelens-root")?.shadowRoot;
    (nextShadow?.querySelector(".agent-follow-up-form input,.agent-follow-up-form textarea,.agent-follow-up-form select")
      || nextShadow?.querySelector(".customize-form textarea")
      || focusControl)?.focus?.();
  }
}

function paymentChoiceHtml(s) {
  const options = s.paymentOptions || {
    upi: { available: s.availablePaymentMethods?.includes("UPI") },
    cod: { available: s.availablePaymentMethods?.some((item) => /cod|cash/i.test(item)) },
  };
  const choices = [
    options.upi?.available && { value: "UPI", title: "UPI", note: "Scan a secure QR and pay in your UPI app", icon: "⌁" },
    options.cod?.available && { value: "COD", title: "Cash on delivery", note: "Pay when your order arrives", icon: "₹" },
  ].filter(Boolean);
  if (!choices.length) return `<section class="payment-choice unavailable"><div class="section-title">Payment method</div><p>No supported payment method is available for this cart.</p></section>`;
  const selected = choices.some((choice) => choice.value === s.paymentMethod) ? s.paymentMethod : choices[0].value;
  return `<fieldset class="payment-choice"><legend>Payment method</legend><div class="payment-options">${choices.map((choice) => `<label><input type="radio" name="payment-method" value="${choice.value}" ${choice.value === selected ? "checked" : ""}><span class="payment-icon payment-icon-${choice.value.toLowerCase()}">${choice.icon}</span><span><b>${choice.title}</b><small>${choice.note}</small></span><i></i></label>`).join("")}</div></fieldset>`;
}

function updateConfirmButton(shadow, suggestion) {
  const button = shadow.querySelector(".order");
  if (!button) return;
  if (suggestion.cartLimitExceeded) {
    button.disabled = true;
    button.textContent = "Reduce cart below ₹1,000";
    return;
  }
  const method = shadow.querySelector('input[name="payment-method"]:checked')?.value;
  button.disabled = !method;
  button.textContent = method === "UPI"
    ? `Pay ${currency(suggestion.finalAmount)} with UPI`
    : method === "COD" ? `Place COD order · ${currency(suggestion.finalAmount)}` : "Payment unavailable";
}

async function showPaymentToast(cart, payment) {
  removeToast(); const root = document.createElement("div"); root.id = "cravelens-root";
  applyThemeToHost(root);
  root.dataset.thread = cart.threadId;
  const shadow = root.attachShadow({ mode: "open" });
  const appLink = safePaymentUrl(payment.upiString);
  const bridgeLink = safePaymentUrl(payment.bridgeUrl);
  shadow.innerHTML = `<style>${toastCss}${productCss}${paymentCss}${interfaceThemeCss}</style><aside class="payment-view">${brandRowHtml()}<div class="eyebrow">UPI payment</div><h3>Scan to pay ${currency(payment.amount || cart.finalAmount)}</h3><p class="payment-lede">Open any UPI app on your phone and scan this secure Swiggy QR.</p><div class="qr-shell"><span>Generating QR…</span></div><div class="payment-status" role="status"><i></i><span>Waiting for payment</span><b class="payment-countdown"></b></div><p class="payment-note">Keep this window open. Your order is confirmed only after Swiggy reports the payment as successful.</p><div class="payment-actions">${appLink ? `<a class="upi-link" href="${escapeHtml(appLink)}">Open UPI app</a>` : ""}${bridgeLink ? `<a class="quiet-link" href="${escapeHtml(bridgeLink)}" target="_blank" rel="noopener noreferrer">Open payment page</a>` : ""}<button class="cancel-payment">Cancel UPI payment</button><button class="quiet">Close</button></div></aside>`;
  document.body.append(root);
  shadow.querySelector(".quiet")?.addEventListener("click", removeToast);
  shadow.querySelector(".cancel-payment")?.addEventListener("click", (event) => cancelUPIPayment(cart, root, event.currentTarget));
  try {
    const dataUrl = await QRCode.toDataURL(payment.upiString, { width: 228, margin: 1, errorCorrectionLevel: "M", color: { dark: "#171713", light: "#ffffff" } });
    if (document.getElementById("cravelens-root") === root) shadow.querySelector(".qr-shell").innerHTML = `<img src="${dataUrl}" alt="UPI payment QR code">`;
  } catch { if (shadow.querySelector(".qr-shell")) shadow.querySelector(".qr-shell").textContent = "Use the UPI payment link below."; }
  updatePaymentCountdown(shadow, payment.expiresAt);
  paymentCountdownTimer = setInterval(() => updatePaymentCountdown(shadow, payment.expiresAt), 1000);
  paymentPollTimer = setTimeout(() => pollUPIPayment(cart, root), 2500);
}

function updatePaymentCountdown(shadow, expiresAt) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt || "") - Date.now()) / 1000));
  const target = shadow.querySelector(".payment-countdown");
  if (target) target.textContent = seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Expired";
}

async function pollUPIPayment(cart, root) {
  if (document.getElementById("cravelens-root") !== root) return;
  const shadow = root.shadowRoot;
  try {
    const data = await api(`/api/orchestrate/${cart.threadId}/payment-status`);
    if (data.status === "pending") { paymentPollTimer = setTimeout(() => pollUPIPayment(cart, root), 3000); return; }
    if (data.status === "paid") {
      await finalizePaidUPI(cart, shadow); return;
    }
    if (data.status === "ordered") { cart.status = "ordered"; cart.order = data.order; persistVideoState(); renderCartHistory(); showOrderSuccess(cart, data.order); return; }
    if (data.status === "cancelled") { markPaymentCancelled(cart); return; }
    cart.status = "payment_failed"; persistVideoState(); renderCartHistory();
    setPaymentStatus(shadow, "Payment window closed · no order placed", "failed");
    clearInterval(paymentCountdownTimer);
  } catch (error) {
    setPaymentStatus(shadow, `${error.message || "Couldn’t check payment"} · retrying…`, "");
    paymentPollTimer = setTimeout(() => pollUPIPayment(cart, root), 4000);
  }
}

async function cancelUPIPayment(cart, root, button) {
  clearTimeout(paymentPollTimer); clearInterval(paymentCountdownTimer);
  button.disabled = true; button.textContent = "Checking payment…";
  const shadow = root.shadowRoot;
  try {
    const data = await api(`/api/orchestrate/${cart.threadId}/cancel-payment`, { method: "POST" });
    if (data.status === "paid") { await finalizePaidUPI(cart, shadow); return; }
    if (data.status === "ordered") { cart.status = "ordered"; cart.order = data.order; persistVideoState(); renderCartHistory(); showOrderSuccess(cart, data.order); return; }
    if (data.status === "failed") {
      cart.status = "payment_failed"; persistVideoState(); renderCartHistory();
      showNoticeToast("UPI payment expired", "No order was placed. Build a fresh cart to try again."); return;
    }
    markPaymentCancelled(cart);
  } catch (error) {
    button.disabled = false; button.textContent = "Cancel UPI payment";
    setPaymentStatus(shadow, `${error.message || "Couldn’t cancel payment"} · payment check resumed`, "");
    paymentPollTimer = setTimeout(() => pollUPIPayment(cart, root), 3000);
    paymentCountdownTimer = setInterval(() => updatePaymentCountdown(shadow, cart.payment.expiresAt), 1000);
  }
}

async function finalizePaidUPI(cart, shadow) {
  setPaymentStatus(shadow, "Payment received · confirming order…", "paid");
  const confirmed = await api(`/api/orchestrate/${cart.threadId}/confirm-payment`, { method: "POST" });
  cart.status = "ordered"; cart.order = confirmed.order; persistVideoState(); renderCartHistory(); showOrderSuccess(cart, confirmed.order);
}

function markPaymentCancelled(cart) {
  cart.status = "payment_cancelled"; persistVideoState(); renderCartHistory();
  showNoticeToast("UPI payment cancelled", "No order was placed. Don’t complete the old request in your UPI app; Swiggy will let it expire.");
}

function setPaymentStatus(shadow, label, stateName) {
  const status = shadow.querySelector(".payment-status");
  if (!status) return;
  status.className = `payment-status ${stateName}`;
  status.querySelector("span").textContent = label;
}

function showOrderSuccess(cart, order) {
  removeToast(); const root = document.createElement("div"); root.id = "cravelens-root";
  applyThemeToHost(root);
  const shadow = root.attachShadow({ mode: "open" });
  const eta = orderEta(order);
  shadow.innerHTML = `<style>${toastCss}${paymentCss}${interfaceThemeCss}</style><aside class="success-view">${brandRowHtml()}<div class="success-mark">✓</div><h3>Order confirmed</h3><p>${escapeHtml(cart.item)} is on its way${eta ? ` · ${escapeHtml(eta)}` : ""}.</p><button class="quiet">Done</button></aside>`;
  document.body.append(root); shadow.querySelector(".quiet")?.addEventListener("click", removeToast);
}

function showNoticeToast(title, detail) {
  removeToast(); const root = document.createElement("div"); root.id = "cravelens-root";
  applyThemeToHost(root);
  const shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${toastCss}${paymentCss}${interfaceThemeCss}</style><aside class="success-view">${brandRowHtml()}<div class="notice-mark">!</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p><button class="quiet">Done</button></aside>`;
  document.body.append(root); shadow.querySelector(".quiet")?.addEventListener("click", removeToast);
}

function orderEta(order) {
  const value = order?.etaMinutes ?? order?.deliveryTimeInMinutes ?? order?.eta ?? order?.deliveryEta;
  if (!value) return "";
  return typeof value === "number" ? `${value} min` : String(value);
}

function safePaymentUrl(value) {
  try { const url = new URL(String(value || "")); return ["https:", "upi:"].includes(url.protocol) ? url.href : ""; }
  catch { return ""; }
}
function currency(value) { return `₹${Math.max(0, Number(value) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function safeImageUrl(value) { try { const url = new URL(String(value)); return url.protocol === "https:" ? url.href : ""; } catch { return ""; } }
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const productCss = `.product-head{display:flex;gap:13px;align-items:flex-start}.product-copy{flex:1;min-width:0}.product-image{width:88px;height:88px;flex:none;object-fit:cover;border-radius:15px;background:#272722;border:1px solid #ffffff12}.eta{display:inline-block;margin-top:8px;padding:4px 8px;border-radius:8px;background:#ffffff0b;color:#d8d3c8;font-size:10px;font-weight:700}`;
const cartUiExtraCss = `.cart-limit-warning{margin-top:10px;padding:8px 9px;border:1px solid #d66b473f;border-radius:9px;background:#411f17;color:#ffac95;font-size:9px;font-weight:750}.item-remove:disabled{opacity:.35;cursor:not-allowed}.menu-search{display:grid;grid-template-columns:minmax(0,1fr) 38px;gap:7px;margin:11px 0 4px}.menu-search input{box-sizing:border-box;width:100%;min-width:0;height:38px;padding:0 11px;border:1px solid #ffffff18;border-radius:11px;background:#0e0e0c;color:#f4f0e6;font:10px Inter,Arial,sans-serif;outline:none}.menu-search input::placeholder{color:#77736b}.menu-search input:focus{border-color:#ff7043;box-shadow:0 0 0 2px #ff70431c}.menu-search button{display:grid;place-items:center;width:38px;height:38px;padding:0;border:1px solid #ff704344;border-radius:11px;background:#342018;color:#ff9677}.menu-search svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}.menu-mutation-status{display:none;margin:8px 0 0;padding:7px 8px;border-radius:8px;background:#223729;color:#a9ddb4;font-size:8.5px}.menu-mutation-status.visible{display:block}.menu-mutation-status.error{background:#442019;color:#ffab96}.menu-state:empty{display:none}.menu-filters{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px}.menu-filters>div{display:flex;gap:5px}.menu-filters button,.menu-filters select{height:28px;border:1px solid #ffffff14;border-radius:8px;background:#ffffff08;color:#aaa69d;font:700 8px Inter,Arial,sans-serif}.menu-filters button{display:flex;align-items:center;gap:4px;padding:0 7px}.menu-filters button.active{border-color:#ff70435c;background:#3b2119;color:#ff9a7c}.menu-filters .dietary-icon{width:9px;height:9px;margin:0}.menu-filters .dietary-icon i{width:4px;height:4px}.menu-filters label{display:flex;align-items:center;gap:5px;color:#817d74;font-size:8px}.menu-filters select{max-width:125px;padding:0 6px;outline:none}.menu-item-rating{display:inline-flex!important;align-items:center;gap:2px;margin-top:3px;padding:2px 5px;border-radius:6px;background:#143c32;color:#66d5b3;font-size:8px;font-weight:800}.menu-item-rating small{display:inline!important;max-height:none!important;margin:0!important;padding:0!important;overflow:visible!important;color:inherit!important;font-size:7px!important}.menu-add.customize{white-space:nowrap}.menu-options{max-height:min(82vh,720px);overflow:hidden}.menu-options>form{box-sizing:border-box;max-height:min(82vh,720px);padding:18px;overflow-y:auto}.menu-options>form>p{margin:5px 0 12px}.option-groups{display:grid;gap:10px}.option-groups fieldset{margin:0;padding:10px;border:1px solid #ffffff10;border-radius:12px;background:#ffffff04}.option-groups legend{display:flex;align-items:baseline;justify-content:space-between;gap:12px;width:100%;padding:0 2px 7px;color:#eee9de;font-weight:800}.option-groups legend small{color:#8d897f;font-size:7.5px;font-weight:650}.option-groups label{display:flex;align-items:center;gap:8px;padding:8px 2px;border-top:1px solid #ffffff0b;cursor:pointer}.option-groups label.unavailable{opacity:.4;cursor:not-allowed}.option-groups input{position:absolute;opacity:0;pointer-events:none}.option-groups label>span{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;flex:1}.option-groups label b{font-size:9.5px}.option-groups label small{color:#9b978d;font-size:8px}.option-groups label>i{display:grid;place-items:center;width:14px;height:14px;flex:none;border:1.5px solid #6f6b63;border-radius:4px}.option-groups input[type="radio"]+span+i{border-radius:50%}.option-groups input:checked+span+i{border-color:#ff7043;background:#ff7043;box-shadow:inset 0 0 0 3px #211711}.option-groups input:focus-visible+span+i{outline:2px solid #ff9a7c;outline-offset:2px}.option-error{min-height:14px;margin:8px 0 0!important;color:#ff947b!important;font-size:8.5px}.menu-options .dialog-actions{position:sticky;bottom:-18px;margin:10px -18px -18px;padding:12px 18px 18px;background:#151512eF;backdrop-filter:blur(8px)}`;
const agentEventCss = `.scan{margin-bottom:12px}.loading-copy{color:#aaa79d;margin:7px 0 15px}.food-update{display:grid;place-items:center;width:72px;height:72px;margin:2px 0 15px;border-radius:22px;background:#2b1c15;color:#ff8a64}.food-update svg{width:48px;height:48px;overflow:visible}.food-update .bowl,.food-update .steam{fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.food-update .bowl{transform-origin:32px 42px;animation:bowl-rock 1.4s ease-in-out infinite}.food-update .steam{animation:steam-rise 1.4s ease-in-out infinite}.food-update .steam-two{animation-delay:.28s}.agent-events{list-style:none;margin:-5px 0 0;padding:5px 6px 7px;display:grid;gap:8px;max-height:190px;overflow:auto}.agent-events li{display:flex;align-items:center;gap:9px;color:#aaa79d;font-size:12px;transition:.2s}.agent-events li i{width:8px;height:8px;flex:none;border-radius:50%;background:#68665f}.agent-events li.active{color:#f5f0e4}.agent-events li.active i{background:#ff7043;box-shadow:0 0 0 4px #ff704326;animation:pulse 1.2s infinite}.agent-events li.done i{background:#62c87a}.agent-events li.failed{color:#ff8b76}.agent-events li.failed i{background:#ff6040}@keyframes pulse{50%{opacity:.35;transform:scale(.75)}}@keyframes steam-rise{0%,100%{opacity:.25;transform:translateY(3px)}50%{opacity:1;transform:translateY(-3px)}}@keyframes bowl-rock{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(2deg)}}@media(prefers-reduced-motion:reduce){.food-update .bowl,.food-update .steam,.agent-events li.active i{animation:none}}`;
const paymentCss = `.payment-choice{min-width:0;margin:14px 0;padding:0;border:0}.payment-choice legend{width:100%;margin-bottom:9px;color:#88867e;font-size:10px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase}.payment-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.payment-options label{position:relative;display:grid;grid-template-columns:30px minmax(0,1fr) 14px;align-items:center;gap:9px;min-height:62px;padding:10px;border:1px solid #ffffff12;border-radius:14px;background:#ffffff07;cursor:pointer;transition:.18s}.payment-options label:hover{border-color:#ff704370;background:#ff70430c}.payment-options input{position:absolute;opacity:0}.payment-options label:has(input:checked){border-color:#ff7043;background:#ff704314;box-shadow:0 0 0 2px #ff70431e}.payment-icon{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:#ffffff0c;color:#ff8663;font-size:15px;font-weight:900}.payment-options b,.payment-options small{display:block}.payment-options b{font-size:11px}.payment-options small{margin-top:2px;color:#918d84;font-size:8.5px;line-height:1.25}.payment-options label>i{width:12px;height:12px;border:1px solid #77736a;border-radius:50%}.payment-options label:has(input:checked)>i{border:3px solid #ff7043;background:#fff}.payment-choice.unavailable{padding:11px 12px;border:1px solid #7e3027;border-radius:12px;background:#431c18}.payment-choice.unavailable p{margin:0;color:#ffb5a7;font-size:11px}.order:disabled{opacity:.5;cursor:not-allowed}.payment-view{text-align:center}.payment-view .brand{text-align:left}.payment-lede{max-width:310px;margin:8px auto 15px;color:#aaa69d;font-size:12px}.qr-shell{display:grid;place-items:center;width:244px;height:244px;margin:0 auto;padding:8px;border-radius:20px;background:#fff;color:#4b4942;font-size:12px}.qr-shell img{display:block;width:228px;height:228px;border-radius:11px}.payment-status{display:flex;align-items:center;gap:8px;margin:13px auto 0;padding:10px 12px;border-radius:12px;background:#ffffff08;color:#d9d4ca;text-align:left;font-size:11px}.payment-status i{width:8px;height:8px;flex:none;border-radius:50%;background:#ff7043;box-shadow:0 0 0 4px #ff704326;animation:pulse 1.2s infinite}.payment-status span{flex:1}.payment-status b{font-variant-numeric:tabular-nums;color:#ff9a7c}.payment-status.paid i{background:#67d982;box-shadow:0 0 0 4px #67d98222;animation:none}.payment-status.failed i{background:#ff6040;animation:none}.payment-note{margin:11px 4px;color:#7f7c74;font-size:10px;line-height:1.45}.payment-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:13px}.payment-actions a{display:inline-flex;align-items:center;justify-content:center;border-radius:12px;padding:11px 14px;text-decoration:none;font-size:11px;font-weight:750}.upi-link{background:#ff603d;color:#fff}.quiet-link{background:#ffffff0c;color:#d9d4c8}.cancel-payment{width:100%;border:1px solid #ff6f5a55;background:#431c18;color:#ffab9d}.cancel-payment:hover{background:#59231d}.cancel-payment:disabled{opacity:.55;cursor:wait}.payment-actions .quiet{width:100%}.success-view{text-align:center}.success-mark,.notice-mark{display:grid;place-items:center;width:58px;height:58px;margin:2px auto 16px;border-radius:18px;font-size:28px}.success-mark{background:#285c38;color:#9cf0ad}.notice-mark{background:#4e271f;color:#ff9a7c}.success-view p{margin:8px 0 19px;color:#aaa79d}.success-view .quiet{width:100%}@media(max-width:460px){aside{right:10px!important;bottom:10px!important;width:calc(100vw - 20px)!important;max-height:calc(100vh - 20px)!important}.payment-options{grid-template-columns:1fr}}`;
const toastCss = `:host{all:initial}aside{position:fixed;right:24px;bottom:28px;width:400px;max-height:calc(100vh - 56px);overflow:auto;box-sizing:border-box;padding:22px;border-radius:26px;background:linear-gradient(160deg,#171713,#0e0e0c);color:#f8f5ea;box-shadow:0 28px 90px #000a;font:14px/1.45 Inter,Arial,sans-serif;z-index:2147483647;border:1px solid #ffffff17}.brand-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px;margin-bottom:16px}.brand{font-size:10px;letter-spacing:2.4px;color:#ff7043;font-weight:900;margin:0}.brand span{font-size:16px}.swiggy-powered{display:inline-flex;align-items:center;gap:6px;margin:0;padding:5px 8px;border:1px solid #fc801933;border-radius:999px;background:#2f1b0d;color:#ffad63;font-size:8px;font-weight:900;letter-spacing:.75px;text-transform:uppercase}.swiggy-powered img{display:block;width:auto;height:15px;flex:none;object-fit:contain}.eyebrow{font-size:11px;color:#8f8d84;margin-bottom:5px}.title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.title-row h3,h3{font:600 25px/1.12 Georgia,serif;margin:0 0 5px}.restaurant{color:#c7c3b8;margin:0}.deal{flex:none;padding:6px 8px;border-radius:9px;background:#183c23;color:#9cf0ad;font-size:10px;font-weight:900}.receipt{margin-top:18px;padding:15px;border-radius:16px;background:#ffffff08;border:1px solid #ffffff0d}.section-title{font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:#88867e;margin-bottom:10px}.receipt-row{display:flex;justify-content:space-between;gap:15px;margin:7px 0}.receipt-row>div{min-width:0}.receipt-row b{font-weight:650}.receipt-row small{display:block;color:#8f8d85;font-size:11px;margin-top:2px}.receipt-row.muted{color:#aaa79d;font-size:12px}.receipt-row.discount{color:#8ce49f}.receipt-row.total{font-size:17px;margin:12px 0 1px}.rule{height:1px;background:#ffffff12;margin:11px 0}.delivery{display:flex;gap:11px;margin:14px 0;padding:12px 13px;border-radius:14px;background:#211b14}.delivery>span{color:#ff7043}.delivery small{display:block;color:#9d978d;font-size:9px;letter-spacing:1.2px}.delivery b{display:block;font-size:12px;margin:2px 0}.delivery em{display:block;color:#aaa49a;font-size:11px;font-style:normal}details{border-top:1px solid #ffffff10;padding-top:11px}summary{cursor:pointer;color:#c9c4b9;font-size:12px;font-weight:700}.markdown{color:#aaa79e;font-size:12px;line-height:1.55;max-height:170px;overflow:auto;padding-right:4px}.markdown p{margin:8px 0}.markdown ul,.markdown ol{padding-left:18px;margin:8px 0}.markdown code{color:#ff9a7c}.actions{display:flex;gap:9px;margin:17px -4px -4px;padding:12px 4px 4px;border-top:1px solid #ffffff0d}button{border:0;border-radius:13px;padding:12px 16px;font-weight:750;cursor:pointer}.quiet{background:#ffffff0c;color:#d9d4c8}.order{flex:1;background:linear-gradient(135deg,#ff744d,#ff5234);color:#fff;box-shadow:0 8px 24px #ff593733}.scan{height:3px;background:#ffffff12;overflow:hidden;margin-bottom:5px;}.scan i{display:block;width:45%;height:100%;background:#ff6338;animation:s 1s infinite}@keyframes s{from{transform:translateX(-100%)}to{transform:translateX(260%)}}`;

settings().then((value) => updateInterfaceTheme(value.themeMode)).catch(() => {});
queueInitialize();
void renderDebug().catch((error) => { if (isExtensionContextInvalidated(error)) stopInvalidatedExtensionContext(); });
initializeTimer = setInterval(queueInitialize, 1000);
scheduleDetectorScan();
