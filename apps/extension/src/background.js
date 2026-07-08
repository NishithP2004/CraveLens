const defaults = { enabled: true, debug: false, apiUrl: "http://localhost:8787", addressId: "", addressLabel: "", sensitivity: 0.38 };
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const existing = await chrome.storage.local.get(Object.keys(defaults));
  await chrome.storage.local.set({ ...defaults, ...existing, ...(reason === "install" ? { debug: false } : {}) });
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "CRAVELENS_YOLO_DETECT") {
    (async () => {
      await ensureOffscreenDocument();
      return chrome.runtime.sendMessage({ type: "CRAVELENS_OFFSCREEN_DETECT", imageDataUrl: message.imageDataUrl, threshold: message.threshold });
    })().then(respond).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "CRAVELENS_VLM_VERIFY") {
    (async () => {
      await ensureOffscreenDocument();
      const { apiUrl } = { ...defaults, ...await chrome.storage.local.get(["apiUrl"]) };
      const statusResponse = await fetch(`${apiUrl}/api/local-model/status`);
      if (!statusResponse.ok) throw new Error("Unable to check the local Gemma 3n model");
      const status = await statusResponse.json();
      if (!status.available) throw new Error("Gemma 3n is not installed. Place gemma-3n-E2B-it-int4-Web.litertlm in apps/server/models and restart CraveLens.");
      return chrome.runtime.sendMessage({ ...message, type: "CRAVELENS_OFFSCREEN_VERIFY", modelUrl: `${apiUrl}/models/gemma-3n-E2B-it-int4-Web.litertlm` });
    })().then(respond).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type !== "CRAVELENS_API") return;
  (async () => {
    const stored = { ...defaults, ...await chrome.storage.local.get([...Object.keys(defaults), "swiggySessionId", "swiggyExpiresAt"]) };
    const response = await fetch(`${stored.apiUrl}${message.path}`, { method: message.method || "GET", headers: { "content-type": "application/json", ...(stored.swiggySessionId ? { "x-swiggy-session-id": stored.swiggySessionId } : {}) }, body: message.body ? JSON.stringify(message.body) : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  })().then((data) => respond({ ok: true, data })).catch((error) => respond({ ok: false, error: error.message }));
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "scan-current-frame") return;
  scanActiveYouTubeFrame().catch(() => {});
});

async function scanActiveYouTubeFrame() {
  const { enabled } = { ...defaults, ...await chrome.storage.local.get(["enabled"]) };
  if (!enabled) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isYouTubeVideoUrl(tab.url)) return;
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

function isYouTubeVideoUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.endsWith("youtube.com") && (url.pathname === "/watch" || url.pathname.startsWith("/shorts/"));
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
    const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error("YouTube reload timed out")); }, 15_000);
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
  if (offscreenCreated) return;
  const url = chrome.runtime.getURL("src/offscreen.html");
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    if (contexts.length) { offscreenCreated = true; return; }
  }
  if (!creatingOffscreen) creatingOffscreen = chrome.offscreen.createDocument({ url: "src/offscreen.html", reasons: ["BLOBS"], justification: "Run bundled YOLO ONNX inference outside the YouTube page origin" }).then(() => { offscreenCreated = true; }).finally(() => { creatingOffscreen = undefined; });
  await creatingOffscreen;
}
