import { frameFeatures, selectKeyframe } from "./detector.js";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { io } from "socket.io-client";

const state = { running: false, lastTrigger: -120, cache: [], videoId: "", modelStatus: "idle", lastResult: null, vlmStatus: "idle", vlmResult: null, error: "", agentSocket: null, agentEvents: [] };
const api = (path, options = {}) => chrome.runtime.sendMessage({ type: "CRAVELENS_API", path, ...options }).then((r) => { if (!r.ok) throw new Error(r.error); return r.data; });
const settings = () => chrome.storage.local.get({ enabled: true, debug: false, apiUrl: "http://localhost:8787", addressId: "", addressLabel: "", sensitivity: .58 });

function getVideoId() { return new URL(location.href).searchParams.get("v") || ""; }
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

async function trigger(video, confidence) {
  state.lastTrigger = video.currentTime;
  closeAgentStream();
  state.agentEvents = [{ message: "Analyzing the frame locally…", state: "active" }];
  showToast({ loading: true });
  try {
    const cfg = await settings();
    const keyframeDataUrl = await burst(video);
    state.vlmStatus = "running"; renderDebug();
    const local = await chrome.runtime.sendMessage({ type: "CRAVELENS_VLM_VERIFY", imageDataUrl: keyframeDataUrl, videoTitle: document.title.replace(" - YouTube", "") });
    if (!local?.ok) { state.vlmStatus = "failed"; renderDebug(); throw new Error(local?.error || "Local Gemma 3n verification failed"); }
    state.vlmStatus = "ready"; state.vlmResult = { ...local.verification, inferenceMs: local.vlmInferenceMs, timestamp: video.currentTime }; renderDebug();
    state.agentEvents = [{ message: `${local.verification.dish} identified locally`, state: "done" }, { message: "Connecting to the cart agent…", state: "active" }];
    renderAgentEvents();
    const streamId = crypto.randomUUID();
    await connectAgentStream(cfg.apiUrl, streamId);
    const result = await api("/api/orchestrate", { method: "POST", body: { videoId: state.videoId, timestamp: video.currentTime, triggerConfidence: confidence, verification: local.verification, videoTitle: document.title.replace(" - YouTube", ""), addressId: cfg.addressId || undefined, streamId } });
    closeAgentStream();
    if (result.detected) showToast({ suggestion: result.suggestion }); else removeToast();
  } catch (error) { closeAgentStream(); showToast({ error: error.message }); }
}

function connectAgentStream(apiUrl, streamId) {
  return new Promise((resolve, reject) => {
    const socket = io(apiUrl, { transports: ["websocket"], reconnection: true, timeout: 8000 });
    state.agentSocket = socket;
    socket.on("agent:event", appendAgentEvent);
    socket.on("connect_error", (error) => reject(new Error(`Agent event stream unavailable: ${error.message}`)));
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
  const video = document.querySelector("video"); const cfg = await settings();
  if (!cfg.enabled || !video || video.paused || video.readyState < 2 || state.running) return;
  state.running = true;
  try {
    const cached = state.cache.find((d) => video.currentTime >= d.startTime && video.currentTime <= d.endTime);
    if (video.currentTime - state.lastTrigger <= 45 && !cached) return;
    if (cached) await trigger(video, cached.confidence);
    else {
      const shot = capture(video, 640);
      const result = await detectFood(shot.canvas, cfg.sensitivity);
      state.lastResult = { ...result, timestamp: video.currentTime, source: "scheduled" }; state.error = ""; renderDebug();
      if (result.detections.length) await trigger(video, result.detections[0].score);
    }
  } catch (error) { state.error = error.message; renderDebug(); }
  finally { state.running = false; }
}

async function detectFood(canvas, threshold) {
  state.modelStatus = "running"; renderDebug();
  const response = await chrome.runtime.sendMessage({ type: "CRAVELENS_YOLO_DETECT", imageDataUrl: canvas.toDataURL("image/jpeg", .82), threshold });
  if (!response?.ok) throw new Error(response?.error || "YOLO inference failed");
  state.modelStatus = "ready";
  return response;
}

async function debugScan() {
  const video = document.querySelector("video");
  if (!video || video.readyState < 2) throw new Error("No ready YouTube video found");
  const cfg = await settings();
  state.running = true; state.error = ""; renderDebug();
  try {
    const result = await detectFood(capture(video, 640).canvas, cfg.sensitivity);
    state.lastResult = { ...result, timestamp: video.currentTime, source: "manual" };
    return result;
  } catch (error) { state.error = error.message; throw error; }
  finally { state.running = false; renderDebug(); }
}

async function renderDebug() {
  const cfg = await settings();
  document.getElementById("cravelens-debug")?.remove();
  if (!cfg.debug) return;
  const video = document.querySelector("video");
  const panel = document.createElement("div"); panel.id = "cravelens-debug";
  const top = state.lastResult?.allDetections?.map((item) => `${item.label} ${(item.score * 100).toFixed(0)}%`).join(" · ") || "No detections yet";
  const food = state.lastResult?.detections?.map((item) => `${item.label} ${(item.score * 100).toFixed(0)}%`).join(", ") || "none";
  const vlm = state.vlmResult ? `${state.vlmResult.dish} · ${(state.vlmResult.confidence * 100).toFixed(0)}% · ${state.vlmResult.context}` : state.vlmStatus;
  panel.innerHTML = `<b>CRAVELENS DEBUG</b><span class="${state.error ? "bad" : ""}">${state.error || `LiteRT FoodNet ${state.modelStatus}${state.running ? " · scanning" : ""}`}</span><dl><dt>Video</dt><dd>${escapeHtml(state.videoId || "—")} @ ${Math.floor(video?.currentTime || 0)}s</dd><dt>FoodNet</dt><dd>${state.lastResult ? `${state.lastResult.source} · ${state.lastResult.inferenceMs}ms` : "—"}</dd><dt>Food gate</dt><dd>${escapeHtml(food)}</dd><dt>Classes</dt><dd>${escapeHtml(top)}</dd><dt class="vlm-label">Gemma 3n</dt><dd class="vlm-value">${escapeHtml(vlm)}</dd><dt>VLM time</dt><dd>${state.vlmResult ? `${state.vlmResult.inferenceMs}ms @ ${Math.floor(state.vlmResult.timestamp)}s` : "—"}</dd><dt>Cache</dt><dd>${state.cache.length} detection windows</dd></dl>`;
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
  if (message.type === "CRAVELENS_DEBUG_SCAN") { debugScan().then((result) => respond({ ok: true, result })).catch((error) => respond({ ok: false, error: error.message })); return true; }
  if (message.type === "CRAVELENS_DEBUG_CHANGED") { renderDebug(); respond({ ok: true }); }
});
chrome.storage.onChanged.addListener((changes) => { if (changes.debug) renderDebug(); });

async function initialize() {
  const id = getVideoId(); if (!id || id === state.videoId) return;
  state.videoId = id; state.cache = []; state.lastTrigger = -120; state.vlmStatus = "idle"; state.vlmResult = null;
  try { state.cache = (await api(`/api/videos/${id}/detections`)).detections; } catch { /* local detection remains available */ }
}

function removeToast() { document.getElementById("cravelens-root")?.remove(); }
function showToast(view) {
  removeToast(); const root = document.createElement("div"); root.id = "cravelens-root";
  const shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${toastCss}${productCss}${agentEventCss}</style><aside><div class="brand"><span>◉</span> CRAVELENS</div>${view.loading ? `<div class="scan"><i></i></div><br/><h3>That looked delicious.</h3><p class="loading-copy">Building a cart around your taste…</p><ol id="agent-events" class="agent-events"></ol>` : view.error ? `<h3>Couldn’t build your cart</h3><p>${escapeHtml(view.error)}</p><button class="quiet">Dismiss</button>` : suggestionHtml(view.suggestion)}</aside>`;
  document.body.append(root);
  if (view.loading) renderAgentEvents();
  shadow.querySelector(".quiet")?.addEventListener("click", () => { if (view.suggestion) decide(view.suggestion.threadId, "reject"); removeToast(); });
  shadow.querySelector(".order")?.addEventListener("click", async (event) => { event.target.textContent = "Ordering…"; const data = await api(`/api/orchestrate/${view.suggestion.threadId}/decision`, { method: "POST", body: { decision: "approve" } }); event.target.textContent = `On its way · ${data.order.etaMinutes} min`; });
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
  return `<div class="eyebrow">A craving, understood</div><div class="product-head">${heroImage}<div class="product-copy"><div class="title-row"><div><h3>${escapeHtml(s.item)}</h3><p class="restaurant">${escapeHtml(s.restaurant)}</p></div>${receipt.discount > 0 ? `<span class="deal">SAVE ${currency(receipt.discount)}</span>` : ""}</div>${eta}</div></div><section class="receipt"><div class="section-title">Cart summary</div>${items}<div class="rule"></div><div class="receipt-row"><span>Item subtotal</span><span>${currency(receipt.subtotal)}</span></div>${charges}${receipt.discount > 0 ? `<div class="receipt-row discount"><span>${escapeHtml(s.coupon ? `Coupon · ${s.coupon}` : "Item savings")}</span><span>−${currency(receipt.discount)}</span></div>` : ""}<div class="receipt-row total"><strong>To pay</strong><strong>${currency(receipt.finalAmount)}</strong></div></section><div class="delivery"><span>⌖</span><div><small>DELIVERING TO</small><b>${escapeHtml(s.deliveryAddress || "Selected Swiggy address")}</b>${payment ? `<em>${escapeHtml(payment)}</em>` : ""}</div></div><details><summary>Why this cart?</summary><div class="markdown">${rationale}</div></details><div class="actions"><button class="quiet">Not now</button><button class="order">Confirm · ${currency(receipt.finalAmount)}</button></div>`;
}
function currency(value) { return `₹${Math.max(0, Number(value) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function safeImageUrl(value) { try { const url = new URL(String(value)); return url.protocol === "https:" ? url.href : ""; } catch { return ""; } }
async function decide(threadId, decision) { try { await api(`/api/orchestrate/${threadId}/decision`, { method: "POST", body: { decision } }); } catch {} }
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const productCss = `.product-head{display:flex;gap:13px;align-items:flex-start}.product-copy{flex:1;min-width:0}.product-image{width:88px;height:88px;flex:none;object-fit:cover;border-radius:15px;background:#272722;border:1px solid #ffffff12}.eta{display:inline-block;margin-top:8px;padding:4px 8px;border-radius:8px;background:#ffffff0b;color:#d8d3c8;font-size:10px;font-weight:700}`;
const agentEventCss = `.scan{margin-bottom:12px}.loading-copy{color:#aaa79d;margin:7px 0 15px}.agent-events{list-style:none;margin:0;padding:0;display:grid;gap:8px;max-height:190px;overflow:auto}.agent-events li{display:flex;align-items:center;gap:9px;color:#aaa79d;font-size:12px;transition:.2s}.agent-events li i{width:8px;height:8px;flex:none;border-radius:50%;background:#68665f}.agent-events li.active{color:#f5f0e4}.agent-events li.active i{background:#ff7043;box-shadow:0 0 0 4px #ff704326;animation:pulse 1.2s infinite}.agent-events li.done i{background:#62c87a}.agent-events li.failed{color:#ff8b76}.agent-events li.failed i{background:#ff6040}@keyframes pulse{50%{opacity:.35;transform:scale(.75)}}`;
const toastCss = `:host{all:initial}aside{position:fixed;right:24px;bottom:28px;width:400px;max-height:calc(100vh - 56px);overflow:auto;box-sizing:border-box;padding:22px;border-radius:26px;background:linear-gradient(160deg,#171713,#0e0e0c);color:#f8f5ea;box-shadow:0 28px 90px #000a;font:14px/1.45 Inter,Arial,sans-serif;z-index:2147483647;border:1px solid #ffffff17}.brand{font-size:10px;letter-spacing:2.4px;color:#ff7043;font-weight:900;margin-bottom:17px}.brand span{font-size:16px}.eyebrow{font-size:11px;color:#8f8d84;margin-bottom:5px}.title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.title-row h3,h3{font:600 25px/1.12 Georgia,serif;margin:0 0 5px}.restaurant{color:#c7c3b8;margin:0}.deal{flex:none;padding:6px 8px;border-radius:9px;background:#183c23;color:#9cf0ad;font-size:10px;font-weight:900}.receipt{margin-top:18px;padding:15px;border-radius:16px;background:#ffffff08;border:1px solid #ffffff0d}.section-title{font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:#88867e;margin-bottom:10px}.receipt-row{display:flex;justify-content:space-between;gap:15px;margin:7px 0}.receipt-row>div{min-width:0}.receipt-row b{font-weight:650}.receipt-row small{display:block;color:#8f8d85;font-size:11px;margin-top:2px}.receipt-row.muted{color:#aaa79d;font-size:12px}.receipt-row.discount{color:#8ce49f}.receipt-row.total{font-size:17px;margin:12px 0 1px}.rule{height:1px;background:#ffffff12;margin:11px 0}.delivery{display:flex;gap:11px;margin:14px 0;padding:12px 13px;border-radius:14px;background:#211b14}.delivery>span{color:#ff7043}.delivery small{display:block;color:#9d978d;font-size:9px;letter-spacing:1.2px}.delivery b{display:block;font-size:12px;margin:2px 0}.delivery em{display:block;color:#aaa49a;font-size:11px;font-style:normal}details{border-top:1px solid #ffffff10;padding-top:11px}summary{cursor:pointer;color:#c9c4b9;font-size:12px;font-weight:700}.markdown{color:#aaa79e;font-size:12px;line-height:1.55;max-height:170px;overflow:auto;padding-right:4px}.markdown p{margin:8px 0}.markdown ul,.markdown ol{padding-left:18px;margin:8px 0}.markdown code{color:#ff9a7c}.actions{position:sticky;bottom:-22px;display:flex;gap:9px;margin:17px -4px -4px;padding:12px 4px 4px;background:linear-gradient(#0f0f0d00,#0f0f0d 25%)}button{border:0;border-radius:13px;padding:12px 16px;font-weight:750;cursor:pointer}.quiet{background:#ffffff0c;color:#d9d4c8}.order{flex:1;background:linear-gradient(135deg,#ff744d,#ff5234);color:#fff;box-shadow:0 8px 24px #ff593733}.scan{height:3px;background:#ffffff12;overflow:hidden;margin-bottom:5px;}.scan i{display:block;width:45%;height:100%;background:#ff6338;animation:s 1s infinite}@keyframes s{from{transform:translateX(-100%)}to{transform:translateX(260%)}}`;

initialize(); renderDebug(); setInterval(initialize, 1000); setInterval(tick, 4000);
