import { frameFeatures, selectKeyframe } from "./detector.js";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { io } from "socket.io-client";

const state = { running: false, navigationVersion: 0, lastTrigger: -120, lastPlaybackTime: null, replayPending: false, cache: [], videoId: "", modelStatus: "idle", lastResult: null, vlmStatus: "idle", vlmResult: null, error: "", agentSocket: null, agentEvents: [], foodHistory: [], carts: [], cartsHidden: false };
const VIDEO_STORE_PREFIX = "cravelens:video:";
const CART_STORE_SUFFIX = ":session-carts";
const DETECTOR_OVERLAY_TTL_MS = 350;
const DEFAULT_SCAN_INTERVAL_MS = 4000;
const MIN_SCAN_INTERVAL_MS = 2000;
const MAX_SCAN_INTERVAL_MS = 30000;
let detectorOverlayTimer;
let detectorScanTimer;
const api = (path, options = {}) => chrome.runtime.sendMessage({ type: "CRAVELENS_API", path, ...options }).then((r) => { if (!r.ok) throw new Error(r.error); return r.data; });
const settings = () => chrome.storage.local.get({ enabled: true, debug: false, apiUrl: "http://localhost:8787", addressId: "", addressLabel: "", sensitivity: .38, scanIntervalMs: DEFAULT_SCAN_INTERVAL_MS });
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
    frames.push({ ...features, dataUrl: shot.canvas.toDataURL("image/jpeg", .82) });
    await new Promise((r) => setTimeout(r, 330));
  }
  return selectKeyframe(frames).dataUrl;
}

async function trigger(video, confidence, signature, { forceVerification = false, forceAgent = false, throwOnError = false } = {}) {
  const navigationVersion = state.navigationVersion;
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
    console.info("[CraveLens] ONNX-positive frame accepted; preparing Gemma 3n keyframe");
    const keyframeDataUrl = await burst(video);
    if (!isCurrentNavigation(navigationVersion)) return;
    state.vlmStatus = "running"; renderDebug();
    console.info("[CraveLens] Sending keyframe to Gemma 3n");
    const local = await chrome.runtime.sendMessage({ type: "CRAVELENS_VLM_VERIFY", imageDataUrl: keyframeDataUrl, videoTitle: document.title.replace(" - YouTube", "") });
    if (!isCurrentNavigation(navigationVersion)) return;
    if (!local?.ok) { state.vlmStatus = "failed"; renderDebug(); throw new Error(local?.error || "Local Gemma 3n verification failed"); }
    state.vlmStatus = "ready"; state.vlmResult = { ...local.verification, inferenceMs: local.vlmInferenceMs, timestamp: video.currentTime }; renderDebug();
    if (!local.verification.isFood || local.verification.confidence < .65) return local.verification;
    vlmConfirmed = true;
    const dishKey = normalizeDish(local.verification.dish);
    const existing = state.foodHistory.find((entry) => entry.dishKey === dishKey);
    const existingCart = state.carts.find((cart) => normalizeDish(cart.detectedDish || cart.item) === dishKey && !isCartExpired(cart));
    if (existing && existingCart && !forceAgent) {
      console.info(`[CraveLens] Agent flow skipped: an active ${local.verification.dish} cart already exists for this video`);
      return local.verification;
    }
    if (!existing) {
      state.foodHistory.push({ dish: local.verification.dish, dishKey, timestamp: video.currentTime, confidence: local.verification.confidence, signature: signature || null, confirmedAt: Date.now() });
      persistVideoState();
    }
    state.agentEvents = [{ message: `${local.verification.dish} confirmed by Gemma 3n`, state: "done" }, { message: "Connecting to the cart agent…", state: "active" }];
    showToast({ loading: true, dish: local.verification.dish });
    renderAgentEvents();
    const streamId = crypto.randomUUID();
    await connectAgentStream(cfg.apiUrl, streamId);
    if (!isCurrentNavigation(navigationVersion)) { closeAgentStream(); return; }
    const result = await api("/api/orchestrate", { method: "POST", body: { videoId: state.videoId, timestamp: video.currentTime, triggerConfidence: confidence, verification: local.verification, videoTitle: document.title.replace(" - YouTube", ""), addressId: cfg.addressId || undefined, streamId } });
    if (!isCurrentNavigation(navigationVersion)) return;
    closeAgentStream();
    if (result.detected) {
      const cart = { ...result.suggestion, detectedDish: local.verification.dish, frameTimestamp: video.currentTime, addedAt: Date.now(), status: "ready" };
      state.carts.push(cart); persistVideoState(); renderCartHistory(); showToast({ suggestion: cart });
    } else removeToast();
    return local.verification;
  } catch (error) {
    if (!isCurrentNavigation(navigationVersion)) return;
    closeAgentStream();
    state.error = error.message; renderDebug();
    if (vlmConfirmed) showToast({ error: error.message });
    if (throwOnError) throw error;
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
  };
  if (event === "orchestration_started") return `Preparing a ${details.dish || "food"} cart`;
  if (event === "started") return "Personalization agent started";
  if (event === "tools_ready") return `${details.count || 0} Swiggy tools connected`;
  if (event === "reasoning_started") return "Planning the best cart for you";
  if (event === "tool_call") return tools[details.tool] || `Using ${String(details.tool || "Swiggy")}`;
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
  clearTimeout(detectorScanTimer);
  detectorScanTimer = setTimeout(runScheduledDetectorScan, normalizeScanInterval(delay));
}

async function runScheduledDetectorScan() {
  let delay = DEFAULT_SCAN_INTERVAL_MS;
  try {
    await tick();
    delay = (await settings()).scanIntervalMs;
  } catch (error) {
    state.error = error.message;
    renderDebug();
  } finally {
    scheduleDetectorScan(delay);
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
  const cfg = await settings();
  state.running = true; state.error = ""; renderDebug(forceDebug);
  try {
    const shot = capture(video, 640);
    const result = await detectFood(shot.canvas, cfg.sensitivity, forceDebug);
    if (!isCurrentNavigation(navigationVersion)) return result;
    state.lastResult = { ...result, timestamp: video.currentTime, source: "manual" };
    let verification;
    if (result.detections.length) {
      console.info(`[CraveLens] Manual ONNX scan found ${result.detections.length} food detection(s); invoking Gemma 3n`);
      verification = await trigger(video, result.detections[0].score, frameFeatures(shot.imageData).histogram, { forceVerification: true, forceAgent: true, throwOnError: true });
    } else console.info("[CraveLens] Gemma skipped: manual ONNX scan returned no food detections");
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
  const cfg = await settings();
  document.getElementById("cravelens-debug")?.remove();
  if (!cfg.debug && !forceDebug) return;
  const video = getActiveVideo();
  const panel = document.createElement("div"); panel.id = "cravelens-debug";
  const top = state.lastResult?.allDetections?.map((item) => `${item.label} ${(item.score * 100).toFixed(0)}%`).join(" · ") || "No detections yet";
  const food = state.lastResult?.detections?.map((item) => `${item.label} ${(item.score * 100).toFixed(0)}%`).join(", ") || "none";
  const vlm = state.vlmResult ? `isFood=${state.vlmResult.isFood} · ${state.vlmResult.dish} · ${(state.vlmResult.confidence * 100).toFixed(0)}% · ${state.vlmResult.context}` : state.vlmStatus;
  panel.innerHTML = `<b>CRAVELENS DEBUG</b><span class="${state.error ? "bad" : ""}">${state.error || `ONNX detector ${state.modelStatus}${state.running ? " · scanning" : ""}`}</span><dl><dt>Video</dt><dd>${escapeHtml(state.videoId || "—")} @ ${Math.floor(video?.currentTime || 0)}s</dd><dt>Detector</dt><dd>${state.lastResult ? `${state.lastResult.source} · ${state.lastResult.inferenceMs}ms` : "—"}</dd><dt>Food gate</dt><dd>${escapeHtml(food)}</dd><dt>Boxes</dt><dd>${escapeHtml(top)}</dd><dt class="vlm-label">Gemma 3n</dt><dd class="vlm-value">${escapeHtml(vlm)}</dd><dt>VLM time</dt><dd>${state.vlmResult ? `${state.vlmResult.inferenceMs}ms @ ${Math.floor(state.vlmResult.timestamp)}s` : "—"}</dd><dt>History</dt><dd>${state.foodHistory.length} foods · ${state.carts.length} carts</dd></dl>`;
  panel.style.cssText = "position:fixed;left:18px;bottom:18px;width:360px;z-index:2147483647;background:#0d0f0eeF;color:#dce5dc;border:1px solid #ffffff24;border-radius:14px;padding:14px;font:12px/1.45 ui-monospace,SFMono-Regular,monospace;box-shadow:0 18px 60px #0008;pointer-events:none";
  panel.querySelector("b").style.cssText = "display:block;color:#ff7043;letter-spacing:1.3px;margin-bottom:7px";
  panel.querySelector("span").style.cssText = `display:block;color:${state.error ? "#ff796b" : "#78db87"};margin-bottom:8px`;
  panel.querySelector("dl").style.cssText = "display:grid;grid-template-columns:76px 1fr;gap:4px;margin:0";
  for (const node of panel.querySelectorAll("dt")) node.style.color = "#788078";
  for (const node of panel.querySelectorAll("dd")) node.style.margin = "0";
  panel.querySelector(".vlm-label").style.color = "#ff8a65";
  panel.querySelector(".vlm-value").style.cssText = "margin:0;color:#ffc0aa;font-weight:700";
  document.body.append(panel);
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "CRAVELENS_PING") { respond({ ok: true }); return; }
  if (message.type === "CRAVELENS_DEBUG_SCAN") { debugScan(Boolean(message.forceDebug)).then((result) => respond({ ok: true, result })).catch((error) => respond({ ok: false, error: error.message })); return true; }
  if (message.type === "CRAVELENS_DEBUG_CHANGED") { renderDebug(); respond({ ok: true }); }
  if (message.type === "CRAVELENS_ENABLED_CHANGED") { handleEnabledChange(); respond({ ok: true }); }
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.debug) { renderDebug(); if (!changes.debug.newValue) removeDetectorOverlay(); }
  if (changes.enabled) handleEnabledChange(changes.enabled.newValue);
  if (changes.scanIntervalMs) scheduleDetectorScan(changes.scanIntervalMs.newValue);
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

document.addEventListener("yt-navigate-finish", initialize);
document.addEventListener("yt-page-data-updated", initialize);
window.addEventListener("popstate", initialize);
document.addEventListener("pause", (event) => { if (event.target instanceof HTMLVideoElement) removeDetectorOverlay(); }, true);
document.addEventListener("seeking", (event) => { if (event.target instanceof HTMLVideoElement) { observePlaybackPosition(event.target); removeDetectorOverlay(); } }, true);
document.addEventListener("timeupdate", (event) => { if (event.target instanceof HTMLVideoElement) observePlaybackPosition(event.target); }, true);
document.addEventListener("ended", (event) => { if (event.target instanceof HTMLVideoElement) removeDetectorOverlay(); }, true);

function removeToast() { document.getElementById("cravelens-root")?.remove(); }
function renderCartHistory() {
  document.getElementById("cravelens-cart-history")?.remove();
  const activeCarts = pruneExpiredCarts(state.carts);
  if (activeCarts.length !== state.carts.length) {
    state.carts = activeCarts;
    persistVideoState();
  }
  if (!state.videoId || !state.carts.length) return;
  const root = document.createElement("div"); root.id = "cravelens-cart-history";
  const shadow = root.attachShadow({ mode: "open" });
  const carts = [...state.carts].reverse().map((cart) => `<details data-thread="${escapeHtml(cart.threadId)}"><summary><span>${escapeHtml(cart.detectedDish || cart.item)}</span><small>${formatTimestamp(cart.frameTimestamp)} · ${escapeHtml(cart.status === "ordered" ? "Ordered" : cart.restaurant)}</small></summary><div class="cart"><b>${escapeHtml(cart.item)}</b><span>${escapeHtml(cart.restaurant)}</span><div><strong>${currency(cart.finalAmount ?? cart.price)}</strong><button class="history-order" data-thread="${escapeHtml(cart.threadId)}" ${cart.status === "ordered" ? "disabled" : ""}>${cart.status === "ordered" ? "Ordered" : "Place order"}</button></div></div></details>`).join("");
  shadow.innerHTML = `<style>:host{all:initial}.panel,.reveal{position:fixed;left:20px;top:92px;z-index:2147483646;border-radius:18px;background:#12120ff2;color:#f6f2e8;border:1px solid #ffffff18;box-shadow:0 18px 60px #0008;font:13px/1.4 Inter,Arial,sans-serif}.panel{width:310px;max-height:calc(100vh - 130px);overflow:auto}.reveal{padding:11px 15px;color:#ff7043;font-size:10px;font-weight:900;letter-spacing:1.2px;cursor:pointer}.head{position:sticky;top:0;padding:14px 16px;background:#191915;color:#ff7043;font-size:10px;font-weight:900;letter-spacing:1.5px}.head b{float:right;color:#f6f2e8}.head button{float:right;display:grid;place-items:center;width:26px;height:26px;margin:-6px 0 -6px 10px;border:0;border-radius:8px;padding:0;background:#ffffff10;color:#bbb6aa;cursor:pointer}.head button:hover{background:#ffffff1c;color:white}.head svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}details{border-top:1px solid #ffffff10}summary{padding:13px 16px;cursor:pointer;list-style:none}summary span,summary small{display:block}summary span{font-weight:750}summary small{color:#969288;margin-top:2px;font-size:10px}.cart{display:grid;gap:4px;padding:0 16px 15px;color:#aaa69c}.cart>b{color:#f6f2e8}.cart>div{display:flex;align-items:center;justify-content:space-between;margin-top:7px}.cart button{border:0;border-radius:9px;padding:8px 11px;background:#ff603d;color:white;font-weight:750;cursor:pointer}.cart button:disabled{background:#315b3d;color:#bde7c7;cursor:default}</style>${state.cartsHidden ? `<button class="reveal">SHOW VIDEO CARTS · ${state.carts.length}</button>` : `<section class="panel"><div class="head">CARTS FOR THIS VIDEO <button class="hide" aria-label="Hide video carts" title="Hide video carts"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button><b>${state.carts.length}</b></div>${carts}</section>`}`;
  document.body.append(root);
  shadow.querySelectorAll(".history-order").forEach((button) => button.addEventListener("click", () => orderStoredCart(button.dataset.thread, button)));
  shadow.querySelectorAll("details[data-thread]").forEach((details) => details.addEventListener("toggle", () => { if (details.open) { const cart = state.carts.find((item) => item.threadId === details.dataset.thread); if (cart) showToast({ suggestion: cart }); } }));
  shadow.querySelector(".hide")?.addEventListener("click", () => { state.cartsHidden = true; persistVideoState(); renderCartHistory(); });
  shadow.querySelector(".reveal")?.addEventListener("click", () => { state.cartsHidden = false; persistVideoState(); renderCartHistory(); });
}
function formatTimestamp(seconds) { const value = Math.max(0, Math.floor(Number(seconds) || 0)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`; }
async function orderStoredCart(threadId, button) {
  const cart = state.carts.find((item) => item.threadId === threadId);
  if (!cart || isCartExpired(cart)) {
    state.carts = pruneExpiredCarts(state.carts);
    persistVideoState();
    renderCartHistory();
    showToast({ error: "Cart expired. Build a fresh Swiggy cart." });
    return;
  }
  button.disabled = true; button.textContent = "Ordering…";
  try {
    const data = await api(`/api/orchestrate/${threadId}/decision`, { method: "POST", body: { decision: "approve" } });
    if (cart) { cart.status = "ordered"; cart.order = data.order; persistVideoState(); }
    button.textContent = `On its way · ${data.order.etaMinutes} min`;
    renderCartHistory();
  } catch (error) { button.disabled = false; button.textContent = error.message || "Try again"; }
}
function showToast(view) {
  removeToast(); const root = document.createElement("div"); root.id = "cravelens-root";
  const shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${toastCss}${productCss}${agentEventCss}</style><aside><div class="brand"><span>◉</span> CRAVELENS</div>${view.loading ? `<div class="scan"><i></i></div><br/><h3>That looked delicious.</h3><p class="loading-copy">${escapeHtml(view.dish)} was confirmed as food. Building a cart…</p><ol id="agent-events" class="agent-events"></ol>` : view.error ? `<h3>Couldn’t build your cart</h3><p>${escapeHtml(view.error)}</p><button class="quiet">Dismiss</button>` : suggestionHtml(view.suggestion)}</aside>`;
  document.body.append(root);
  if (view.loading) renderAgentEvents();
  shadow.querySelector(".quiet")?.addEventListener("click", () => { if (view.suggestion) decide(view.suggestion.threadId, "reject"); removeToast(); });
  shadow.querySelector(".order")?.addEventListener("click", async (event) => { await orderStoredCart(view.suggestion.threadId, event.target); });
}
function suggestionHtml(s) {
  const receipt = s.receipt || { items: [], charges: [], subtotal: s.price || 0, discount: s.savings || 0, finalAmount: s.finalAmount ?? (s.price || 0) - (s.savings || 0) };
  const payment = s.availablePaymentMethods?.[0];
  const imageUrl = safeImageUrl(s.imageUrl || receipt.items?.[0]?.imageUrl);
  const heroImage = imageUrl ? `<img class="product-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(s.item)}">` : "";
  const eta = s.deliveryEta ? `<span class="eta">◷ ${escapeHtml(s.deliveryEta)}</span>` : "";
  const items = receipt.items.length ? receipt.items.map((item) => {
    const original = Number(item.originalTotal || 0);
    const current = Number(item.total || 0);
    const price = original > current
      ? `<span style="display:flex;gap:7px;align-items:center"><del style="color:#77746d;font-size:11px">${currency(original)}</del><b>${currency(current)}</b></span>`
      : `<span>${currency(current)}</span>`;
    return `<div class="receipt-row item"><div><b>${escapeHtml(item.quantity)}× ${escapeHtml(item.name)}</b>${item.customizations?.length ? `<small>${item.customizations.map(escapeHtml).join(" · ")}</small>` : ""}</div>${price}</div>`;
  }).join("") : `<div class="receipt-row item"><b>${escapeHtml(s.item)}</b><span>${currency(receipt.subtotal)}</span></div>`;
  const charges = (receipt.charges || []).map((charge) => `<div class="receipt-row muted"><span>${escapeHtml(charge.label)}</span><span>${currency(charge.amount)}</span></div>`).join("");
  const rationale = DOMPurify.sanitize(marked.parse(String(s.rationale || ""), { async: false, breaks: true }), { ALLOWED_TAGS: ["p", "strong", "em", "ul", "ol", "li", "code", "br"], ALLOWED_ATTR: [] });
  return `<div class="eyebrow">A craving, understood</div><div class="product-head">${heroImage}<div class="product-copy"><div class="title-row"><div><h3>${escapeHtml(s.item)}</h3><p class="restaurant">${escapeHtml(s.restaurant)}</p></div>${receipt.discount > 0 ? `<span class="deal">SAVE ${currency(receipt.discount)}</span>` : ""}</div>${eta}</div></div><section class="receipt"><div class="section-title">Cart summary</div>${items}<div class="rule"></div><div class="receipt-row"><span>Item subtotal</span><span>${currency(receipt.subtotal)}</span></div>${charges}${receipt.discount > 0 ? `<div class="receipt-row discount"><span>${escapeHtml(`Item savings${s.coupon ? ` · ${s.coupon}` : ""}`)}</span><span>−${currency(receipt.discount)}</span></div>` : ""}<div class="receipt-row total"><strong>To pay</strong><strong>${currency(receipt.finalAmount)}</strong></div></section><div class="delivery"><span>⌖</span><div><small>DELIVERING TO</small><b>${escapeHtml(s.deliveryAddress || "Selected Swiggy address")}</b>${payment ? `<em>${escapeHtml(payment)}</em>` : ""}</div></div><details><summary>Why this cart?</summary><div class="markdown">${rationale}</div></details><div class="actions"><button class="quiet">Not now</button><button class="order">Confirm · ${currency(receipt.finalAmount)}</button></div>`;
}
function currency(value) { return `₹${Math.max(0, Number(value) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function safeImageUrl(value) { try { const url = new URL(String(value)); return url.protocol === "https:" ? url.href : ""; } catch { return ""; } }
async function decide(threadId, decision) { try { await api(`/api/orchestrate/${threadId}/decision`, { method: "POST", body: { decision } }); } catch {} }
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const productCss = `.product-head{display:flex;gap:13px;align-items:flex-start}.product-copy{flex:1;min-width:0}.product-image{width:88px;height:88px;flex:none;object-fit:cover;border-radius:15px;background:#272722;border:1px solid #ffffff12}.eta{display:inline-block;margin-top:8px;padding:4px 8px;border-radius:8px;background:#ffffff0b;color:#d8d3c8;font-size:10px;font-weight:700}`;
const agentEventCss = `.scan{margin-bottom:12px}.loading-copy{color:#aaa79d;margin:7px 0 15px}.agent-events{list-style:none;margin:0;padding:0;display:grid;gap:8px;max-height:190px;overflow:auto}.agent-events li{display:flex;align-items:center;gap:9px;color:#aaa79d;font-size:12px;transition:.2s}.agent-events li i{width:8px;height:8px;flex:none;border-radius:50%;background:#68665f}.agent-events li.active{color:#f5f0e4}.agent-events li.active i{background:#ff7043;box-shadow:0 0 0 4px #ff704326;animation:pulse 1.2s infinite}.agent-events li.done i{background:#62c87a}.agent-events li.failed{color:#ff8b76}.agent-events li.failed i{background:#ff6040}@keyframes pulse{50%{opacity:.35;transform:scale(.75)}}`;
const toastCss = `:host{all:initial}aside{position:fixed;right:24px;bottom:28px;width:400px;max-height:calc(100vh - 56px);overflow:auto;box-sizing:border-box;padding:22px;border-radius:26px;background:linear-gradient(160deg,#171713,#0e0e0c);color:#f8f5ea;box-shadow:0 28px 90px #000a;font:14px/1.45 Inter,Arial,sans-serif;z-index:2147483647;border:1px solid #ffffff17}.brand{font-size:10px;letter-spacing:2.4px;color:#ff7043;font-weight:900;margin-bottom:17px}.brand span{font-size:16px}.eyebrow{font-size:11px;color:#8f8d84;margin-bottom:5px}.title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.title-row h3,h3{font:600 25px/1.12 Georgia,serif;margin:0 0 5px}.restaurant{color:#c7c3b8;margin:0}.deal{flex:none;padding:6px 8px;border-radius:9px;background:#183c23;color:#9cf0ad;font-size:10px;font-weight:900}.receipt{margin-top:18px;padding:15px;border-radius:16px;background:#ffffff08;border:1px solid #ffffff0d}.section-title{font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:#88867e;margin-bottom:10px}.receipt-row{display:flex;justify-content:space-between;gap:15px;margin:7px 0}.receipt-row>div{min-width:0}.receipt-row b{font-weight:650}.receipt-row small{display:block;color:#8f8d85;font-size:11px;margin-top:2px}.receipt-row.muted{color:#aaa79d;font-size:12px}.receipt-row.discount{color:#8ce49f}.receipt-row.total{font-size:17px;margin:12px 0 1px}.rule{height:1px;background:#ffffff12;margin:11px 0}.delivery{display:flex;gap:11px;margin:14px 0;padding:12px 13px;border-radius:14px;background:#211b14}.delivery>span{color:#ff7043}.delivery small{display:block;color:#9d978d;font-size:9px;letter-spacing:1.2px}.delivery b{display:block;font-size:12px;margin:2px 0}.delivery em{display:block;color:#aaa49a;font-size:11px;font-style:normal}details{border-top:1px solid #ffffff10;padding-top:11px}summary{cursor:pointer;color:#c9c4b9;font-size:12px;font-weight:700}.markdown{color:#aaa79e;font-size:12px;line-height:1.55;max-height:170px;overflow:auto;padding-right:4px}.markdown p{margin:8px 0}.markdown ul,.markdown ol{padding-left:18px;margin:8px 0}.markdown code{color:#ff9a7c}.actions{position:sticky;bottom:-22px;display:flex;gap:9px;margin:17px -4px -4px;padding:12px 4px 4px;background:linear-gradient(#0f0f0d00,#0f0f0d 25%)}button{border:0;border-radius:13px;padding:12px 16px;font-weight:750;cursor:pointer}.quiet{background:#ffffff0c;color:#d9d4c8}.order{flex:1;background:linear-gradient(135deg,#ff744d,#ff5234);color:#fff;box-shadow:0 8px 24px #ff593733}.scan{height:3px;background:#ffffff12;overflow:hidden;margin-bottom:5px;}.scan i{display:block;width:45%;height:100%;background:#ff6338;animation:s 1s infinite}@keyframes s{from{transform:translateX(-100%)}to{transform:translateX(260%)}}`;

initialize(); renderDebug(); setInterval(initialize, 1000); scheduleDetectorScan();
