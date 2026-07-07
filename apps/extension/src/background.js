const defaults = { enabled: true, debug: false, apiUrl: "http://localhost:8787", addressId: "", addressLabel: "", sensitivity: 0.58 };
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
