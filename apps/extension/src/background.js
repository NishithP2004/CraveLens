import { io } from "socket.io-client";
import { LITERT_TEXT_MODELS, getLiteRtTextModel, getLiteRtVlmModelByProvider } from "./litert-models.js";

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_LOCAL_CONTEXT_TOKENS = 16_384;
const defaults = { enabled: true, debug: false, apiUrl: "http://localhost:8787", addressId: "", addressLabel: "", sensitivity: 0.38, scanIntervalMs: 4000, autoDetectYouTube: true, autoDetectInstagram: true, autoDetectFacebook: true, shortcutBehavior: "auto-supported", personalContext: "", themeMode: "system", modelSettings: { version: 1, vlm: { provider: "auto" }, orchestration: { provider: "auto", contextTokens: DEFAULT_LOCAL_CONTEXT_TOKENS, thinkingEnabled: false }, ollama: { baseUrl: DEFAULT_OLLAMA_BASE_URL }, hostedFallback: "ask" } };
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const existing = await chrome.storage.local.get(Object.keys(defaults));
  await chrome.storage.local.set({ ...defaults, ...existing, ...(reason === "install" ? { debug: false } : {}) });
  await ensureDeviceSession();
  await connectInferenceSocket();
});
chrome.runtime.onStartup.addListener(() => { ensureDeviceSession().then(connectInferenceSocket).catch((error) => console.warn("[CraveLens] Device session startup failed", error)); });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === "CRAVELENS_INFERENCE_CHUNK") {
    inferenceSocket?.emit("inference:chunk", { version: 1, requestId: message.requestId, content: message.content });
    respond({ ok: true });
    return;
  }
  if (message.type === "CRAVELENS_LITERT_DOWNLOAD_STATUS") {
    chrome.storage.local.set({ liteRtDownloadState: message.state }).then(() => respond({ ok: true }));
    return true;
  }
  if (message.type === "CRAVELENS_CANCEL_LITERT_DOWNLOAD") {
    chrome.runtime.sendMessage({ type: "CRAVELENS_OFFSCREEN_CANCEL_LITERT_DOWNLOAD", modelId: message.modelId })
      .then(() => respond({ ok: true }))
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "CRAVELENS_REMOVE_LITERT_MODEL") {
    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({ type: "CRAVELENS_OFFSCREEN_REMOVE_LITERT_MODEL", modelId: message.modelId }))
      .then(async (result) => {
        if (!result?.ok) throw new Error(result?.error || "Unable to remove the LiteRT model");
        await chrome.storage.local.set({ liteRtDownloadState: {
          modelId: message.modelId,
          modelName: result.modelName,
          state: "removed",
          updatedAt: Date.now(),
          downloadedBytes: 0,
          totalBytes: 0,
        } });
        respond({ ok: true, ...result });
      })
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "CRAVELENS_MODEL_SETTINGS_CHANGED") {
    connectInferenceSocket().then(async () => {
      const { modelSettings = defaults.modelSettings } = await chrome.storage.local.get(["modelSettings"]);
      if (["auto", "litert"].includes(modelSettings?.orchestration?.provider || "auto")) {
        await ensureOffscreenDocument();
        // The offscreen document owns the long-lived download and Cache Storage
        // write; do not make the Settings popup wait for multi-gigabyte weights.
        void chrome.runtime.sendMessage({
          type: "CRAVELENS_OFFSCREEN_PRELOAD_LITERT",
          modelId: getLiteRtTextModel(modelSettings.orchestration.model).id,
          modelUrl: getLiteRtTextModel(modelSettings.orchestration.model).url,
          contextTokens: modelSettings.orchestration.contextTokens,
        }).catch((error) => console.warn("[CraveLens] LiteRT model preload failed", error));
      }
      const vlmModel = getLiteRtVlmModelByProvider(modelSettings?.vlm?.provider);
      if (vlmModel) {
        await ensureOffscreenDocument();
        void chrome.runtime.sendMessage({
          type: "CRAVELENS_OFFSCREEN_VERIFY_PRELOAD",
          modelId: vlmModel.id,
          modelUrl: vlmModel.url,
        }).catch((error) => console.warn("[CraveLens] LiteRT VLM preload failed", error));
      }
      respond({ ok: true });
    }).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "CRAVELENS_YOUTUBE_CAPTION_TRACKS") {
    (async () => {
      if (!sender.tab?.id || !chrome.scripting?.executeScript) return { tracks: [] };
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        world: "MAIN",
        func: () => {
          const player = document.getElementById("movie_player")
            || document.querySelector("ytd-player #movie_player, #shorts-player");
          const response = player?.getPlayerResponse?.() || globalThis.ytInitialPlayerResponse;
          const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          return (Array.isArray(tracks) ? tracks : []).map((track) => ({
            baseUrl: track.baseUrl,
            languageCode: track.languageCode,
            kind: track.kind,
            name: track.name?.simpleText || track.name?.runs?.map((run) => run.text).join("") || "",
          }));
        },
      });
      return { tracks: Array.isArray(result?.result) ? result.result : [] };
    })().then((data) => respond({ ok: true, ...data })).catch((error) => {
      console.warn("[CraveLens] Unable to read live YouTube caption tracks:", error);
      respond({ ok: false, tracks: [], error: error.message });
    });
    return true;
  }
  if (message.type === "CRAVELENS_CAPTURE_VISIBLE_TAB") {
    (async () => {
      if (!sender.tab?.windowId) throw new Error("No active tab is available to capture");
      const imageDataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
      return { ok: true, imageDataUrl };
    })().then(respond).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "CRAVELENS_YOLO_DETECT") {
    (async () => {
      await ensureOffscreenDocument();
      return chrome.runtime.sendMessage({ type: "CRAVELENS_OFFSCREEN_DETECT", imageDataUrl: message.imageDataUrl, threshold: message.threshold });
    })().then(respond).catch((error) => {
      console.error("[CraveLens] ONNX detection failed before completion:", error);
      respond({ ok: false, error: error.message });
    });
    return true;
  }
  if (message.type === "CRAVELENS_VLM_VERIFY") {
    (async () => {
      await ensureOffscreenDocument();
      const stored = { ...defaults, ...await chrome.storage.local.get(["apiUrl", "modelSettings"]) };
      return runConfiguredVerification(message, stored);
    })().then(respond).catch((error) => {
      console.error("[CraveLens] VLM verification failed before completion:", error);
      respond({ ok: false, error: error.message });
    });
    return true;
  }
  if (message.type !== "CRAVELENS_API") return;
  (async () => {
    const stored = { ...defaults, ...await chrome.storage.local.get(Object.keys(defaults)) };
    let accessToken = (await ensureDeviceSession()).accessToken;
    let response = await fetch(`${stored.apiUrl}${message.path}`, { method: message.method || "GET", headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` }, body: message.body ? JSON.stringify(message.body) : undefined });
    if (response.status === 401) {
      accessToken = (await ensureDeviceSession(true)).accessToken;
      response = await fetch(`${stored.apiUrl}${message.path}`, { method: message.method || "GET", headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` }, body: message.body ? JSON.stringify(message.body) : undefined });
    }
    if (response.status === 204) return undefined;
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  })().then((data) => respond({ ok: true, data })).catch((error) => respond({ ok: false, error: error.message }));
  return true;
});

async function runConfiguredVerification(message, stored) {
  const configured = stored.modelSettings?.vlm?.provider || "auto";
  const ollamaBaseUrl = normalizeOllamaBaseUrl(stored.modelSettings?.ollama?.baseUrl);
  if (configured === "ollama" || configured === "gemini-nano") return chrome.runtime.sendMessage({ ...message, type: "CRAVELENS_OFFSCREEN_VERIFY", provider: configured, model: stored.modelSettings?.vlm?.model, ollamaBaseUrl });
  if (configured === "litert-gemma4" || configured === "litert-gemma4-e4b") throw new Error("Server-installed Gemma 4 VLM options are temporarily disabled. Choose Gemini Nano, Gemma 3n, or Ollama in Settings.");
  if (configured === "litert-gemma3n") {
    const vlmModel = getLiteRtVlmModelByProvider(configured);
    return chrome.runtime.sendMessage({ ...message, type: "CRAVELENS_OFFSCREEN_VERIFY", provider: configured, model: vlmModel.id, modelUrl: vlmModel.url });
  }
  const nano = await chrome.runtime.sendMessage({ ...message, type: "CRAVELENS_OFFSCREEN_VERIFY", provider: "gemini-nano" });
  if (nano?.ok) return nano;
  const gemma3n = getLiteRtVlmModelByProvider("litert-gemma3n");
  if (gemma3n) return chrome.runtime.sendMessage({ ...message, type: "CRAVELENS_OFFSCREEN_VERIFY", provider: gemma3n.provider, model: gemma3n.id, modelUrl: gemma3n.url });
  const ollamaVision = await discoverOllamaModel("vision", ollamaBaseUrl);
  if (ollamaVision) return chrome.runtime.sendMessage({ ...message, type: "CRAVELENS_OFFSCREEN_VERIFY", provider: "ollama", model: ollamaVision, ollamaBaseUrl });
  throw new Error("No compatible local VLM is available. Enable Gemini Nano image input, select Gemma 3n, or install an Ollama vision model.");
}

async function discoverOllamaModel(capability, baseUrl = DEFAULT_OLLAMA_BASE_URL) {
  try {
    const tags = await fetch(ollamaApiUrl(baseUrl, "/api/tags"), { signal: AbortSignal.timeout(1500) });
    if (!tags.ok) return undefined;
    for (const { name } of (await tags.json()).models || []) {
      const detail = await fetch(ollamaApiUrl(baseUrl, "/api/show"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(1500) });
      if (detail.ok && (await detail.json()).capabilities?.includes(capability)) return name;
    }
  } catch { /* Ollama is optional. */ }
  return undefined;
}

function normalizeOllamaBaseUrl(value) {
  const url = new URL(String(value || DEFAULT_OLLAMA_BASE_URL));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid Ollama host configuration");
  return url.origin;
}

function ollamaApiUrl(baseUrl, path) { return new URL(path, `${normalizeOllamaBaseUrl(baseUrl)}/`).toString(); }

chrome.commands.onCommand.addListener((command) => {
  if (command !== "scan-current-frame") return;
  handleScanShortcut().catch((error) => console.warn("[CraveLens] Shortcut scan failed", error));
});

async function handleScanShortcut() {
  const { enabled, shortcutBehavior } = { ...defaults, ...await chrome.storage.local.get(["enabled", "shortcutBehavior"]) };
  if (!enabled) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isCaptureSupportedUrl(tab.url)) return;
  if (shortcutBehavior !== "lasso-always" && isSupportedVideoUrl(tab.url)) {
    await scanActiveSupportedFrame(tab);
    return;
  }
  await startActiveTabLasso(tab);
}

async function scanActiveSupportedFrame(tab) {
  const message = { type: "CRAVELENS_DEBUG_SCAN", forceDebug: true };
  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(error.message)) throw error;
    if (chrome.scripting?.executeScript) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    else {
      await chrome.tabs.reload(tab.id);
      await waitForTabLoad(tab.id);
    }
    await waitForReceiver(tab.id);
    await chrome.tabs.sendMessage(tab.id, message);
  }
}

async function startActiveTabLasso(tab) {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isCaptureSupportedUrl(tab.url)) return;
  const message = { type: "CRAVELENS_START_LASSO" };
  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(error.message)) throw error;
    if (!chrome.scripting?.executeScript) throw new Error("Script injection is unavailable in this browser");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await waitForReceiver(tab.id);
    await chrome.tabs.sendMessage(tab.id, message);
  }
}

let sessionPromise;
async function ensureDeviceSession(forceRefresh = false) {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const storedSession = await chrome.storage.session.get(["deviceAccessToken", "deviceAccessExpiresAt"]);
    if (!forceRefresh && storedSession.deviceAccessToken && Number(storedSession.deviceAccessExpiresAt) > Date.now() + 30_000) return { accessToken: storedSession.deviceAccessToken, accessExpiresAt: storedSession.deviceAccessExpiresAt };
    const local = await chrome.storage.local.get(["deviceId", "deviceRefreshToken", "apiUrl"]);
    const apiUrl = local.apiUrl || defaults.apiUrl;
    let response;
    if (local.deviceRefreshToken) response = await fetch(`${apiUrl}/api/device/session/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: local.deviceRefreshToken }) });
    if (!response?.ok) response = await fetch(`${apiUrl}/api/device/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error(`Unable to create CraveLens device session (${response.status})`);
    const session = await response.json();
    await Promise.all([
      chrome.storage.session.set({ deviceAccessToken: session.accessToken, deviceAccessExpiresAt: session.accessExpiresAt }),
      chrome.storage.local.set({ deviceId: session.deviceId, deviceRefreshToken: session.refreshToken, deviceRefreshExpiresAt: session.refreshExpiresAt }),
    ]);
    return { accessToken: session.accessToken, accessExpiresAt: session.accessExpiresAt };
  })().finally(() => { sessionPromise = undefined; });
  return sessionPromise;
}

let inferenceSocket;
async function connectInferenceSocket() {
  const [{ accessToken }, { apiUrl = defaults.apiUrl, modelSettings = defaults.modelSettings }] = await Promise.all([ensureDeviceSession(), chrome.storage.local.get(["apiUrl", "modelSettings"])]);
  inferenceSocket?.disconnect();
  inferenceSocket = io(`${apiUrl}/inference`, { transports: ["websocket"], auth: { token: accessToken }, reconnection: true, timeout: 8_000 });
  inferenceSocket.on("connect", async () => {
    const providers = await discoverLocalProviders(modelSettings?.ollama?.baseUrl);
    inferenceSocket.emit("inference:register", { version: 1, providers });
  });
  inferenceSocket.on("inference:invoke", async (request, acknowledge) => {
    try {
      await ensureOffscreenDocument();
      const { apiUrl = defaults.apiUrl, modelSettings: currentSettings = defaults.modelSettings } = await chrome.storage.local.get(["apiUrl", "modelSettings"]);
      const offscreenRequest = request.provider === "ollama"
        ? { ...request, ollamaBaseUrl: normalizeOllamaBaseUrl(currentSettings?.ollama?.baseUrl) }
        : { ...request, modelUrl: getLiteRtTextModel(request.model).url };
      const response = await chrome.runtime.sendMessage({ type: "CRAVELENS_OFFSCREEN_CHAT", request: offscreenRequest });
      if (!response?.ok) throw Object.assign(new Error(response?.error || "Local inference failed"), { code: response?.code });
      acknowledge({ ok: true, result: response.result });
    } catch (error) { acknowledge({ ok: false, error: { code: error.code || "INFERENCE_FAILED", message: error.message } }); }
  });
  inferenceSocket.on("inference:cancel", ({ requestId }) => chrome.runtime.sendMessage({ type: "CRAVELENS_OFFSCREEN_CANCEL", requestId }).catch(() => {}));
  setInterval(() => inferenceSocket?.connected && inferenceSocket.emit("inference:heartbeat", { version: 1, timestamp: Date.now() }), 25_000);
}

async function discoverLocalProviders(ollamaBaseUrl = DEFAULT_OLLAMA_BASE_URL) {
  const providers = await discoverLiteRtProviders();
  try {
    const response = await fetch(ollamaApiUrl(ollamaBaseUrl, "/api/tags"), { signal: AbortSignal.timeout(1500) });
    if (response.ok) for (const model of (await response.json()).models || []) providers.push({ provider: "ollama", model: model.name, capabilities: ["text"] });
  } catch { /* Ollama is optional. */ }
  return providers;
}

async function discoverLiteRtProviders() {
  return LITERT_TEXT_MODELS.map((model) => ({ provider: "litert", model: model.id, capabilities: ["text", "tools"] }));
}

function isSupportedVideoUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname.endsWith("youtube.com")) return url.pathname === "/watch" || url.pathname.startsWith("/shorts/");
    if (url.hostname.endsWith("instagram.com")) return url.pathname.startsWith("/reel/") || url.pathname.startsWith("/reels/");
    if (url.hostname.endsWith("facebook.com")) return url.pathname.startsWith("/watch") || url.pathname.includes("/videos/") || url.searchParams.has("v");
    return false;
  } catch { return false; }
}

function isCaptureSupportedUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch { return false; }
}

async function waitForReceiver(tabId) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { const response = await chrome.tabs.sendMessage(tabId, { type: "CRAVELENS_PING" }); if (response?.ok) return; }
    catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`CraveLens content script did not start: ${lastError?.message || "unknown error"}`);
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error("Supported video page reload timed out")); }, 15_000);
    const listener = (updatedTabId, info) => {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); setTimeout(resolve, 300);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

let creatingOffscreen;
let offscreenCreated = false;
async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL("src/offscreen.html");
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    if (contexts.length) { offscreenCreated = true; return; }
    offscreenCreated = false;
  } else if (offscreenCreated) return;
  if (!creatingOffscreen) creatingOffscreen = chrome.offscreen.createDocument({ url: "src/offscreen.html", reasons: ["BLOBS"], justification: "Run bundled YOLO, local VLM, and browser chat inference outside the YouTube page origin" }).then(() => { offscreenCreated = true; }).finally(() => { creatingOffscreen = undefined; });
  await creatingOffscreen;
}
