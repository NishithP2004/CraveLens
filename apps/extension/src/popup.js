const DEFAULT_SENSITIVITY = .38;
const DEFAULT_SCAN_INTERVAL_MS = 4000;
const MIN_SCAN_INTERVAL_MS = 1000;
const MAX_SCAN_INTERVAL_MS = 30000;
const DEFAULT_SHORTCUT_BEHAVIOR = "auto-supported";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const MIN_LOCAL_CONTEXT_TOKENS = 4_096;
const DEFAULT_LOCAL_CONTEXT_TOKENS = 16_384;
const MAX_LOCAL_CONTEXT_TOKENS = 32_768;
const ids = ["enabled", "debug", "sensitivity", "scanIntervalMs", "autoDetectYouTube", "autoDetectInstagram", "autoDetectFacebook", "shortcutBehavior", "personalContext"];
const defaults = { enabled: true, debug: false, addressId: "", addressLabel: "", sensitivity: DEFAULT_SENSITIVITY, scanIntervalMs: DEFAULT_SCAN_INTERVAL_MS, autoDetectYouTube: true, autoDetectInstagram: true, autoDetectFacebook: true, shortcutBehavior: DEFAULT_SHORTCUT_BEHAVIOR, themeMode: "system", personalContext: "" };
const preferenceKeys = Object.keys(defaults);
const PREFERENCE_CACHE_KEY = "cravelens.preferences.v1";
let selectedAddress;
let modelConfiguration;
let ollamaModels = [];
let availableLiteRtModels = new Set(LITERT_TEXT_MODELS.map((model) => model.id));
let availableLiteRtVlmProviders = new Set();

const PROVIDER_DETAILS = {
  vlmProvider: {
    auto: { title: "Automatic selection", description: "Best available private vision model", icon: "auto", badges: ["Recommended", "Vision"] },
    "litert-gemma4": { title: "Gemma 4 E2B", description: "On-device frame verification with WebGPU", icon: "gemma", badges: ["Local", "Vision"] },
    "litert-gemma4-e4b": { title: "Gemma 4 E4B", description: "Higher-capacity on-device frame verification with WebGPU", icon: "gemma", badges: ["Local", "Vision"] },
    "gemini-nano": { title: "Gemini Nano", description: "Chrome built-in model, when image input is available", icon: "gemini", badges: ["On-device", "Vision"] },
    "litert-gemma3n": { title: "Gemma 3n", description: "On-device frame verification with WebGPU", icon: "gemma", badges: ["Local", "Vision"] },
    ollama: { title: "Ollama", description: "Choose an installed vision-capable model", icon: "ollama", badges: ["Local", "Vision"] },
  },
  agentProvider: {
    auto: { title: "Automatic selection", description: "LiteRT Gemma first, then configured providers", icon: "auto", badges: ["Recommended", "Tools"] },
    litert: { title: "LiteRT · Gemma 4", description: "Choose from E2B through 31B; selected weights download privately in the browser", icon: "gemma", badges: ["Local", "Tools"] },
    ollama: { title: "Ollama", description: "Choose an installed tool-capable model", icon: "ollama", badges: ["Local", "Tools"] },
    "openai-compatible": { title: "OpenAI-compatible", description: "Server default or your private override", icon: "openai", badges: ["Remote", "Tools"] },
    google: { title: "Google Gemini", description: "Server default or your private override", icon: "gemini", badges: ["Remote", "Tools"] },
  },
};

async function main() {
  const contextPanels = [...document.querySelectorAll('details[name="popup-context"]')];
  for (const panel of contextPanels) panel.addEventListener("toggle", () => {
    if (panel.open) for (const other of contextPanels) if (other !== panel) other.open = false;
  });
  const values = await loadPreferences();
  await savePreferences(values);
  applyTheme(values.themeMode);
  for (const id of ids) setPreferenceControlValue(id, values[id]);
  await setupModelSettings();
  updateEnabledState(values.enabled);
  const updateRangeProgress = (input, valueText) => {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const value = Number(input.value);
    const progress = max > min ? ((value - min) / (max - min)) * 100 : 0;
    input.style.setProperty("--range-progress", `${Math.max(0, Math.min(100, progress))}%`);
    input.setAttribute("aria-valuetext", valueText);
  };
  const updateDetectionOutputs = () => {
    const sensitivity = document.getElementById("sensitivity");
    const scanInterval = document.getElementById("scanIntervalMs");
    const sensitivityText = `${Math.round(sensitivity.value * 100)}%`;
    const scanIntervalText = `${Math.round(scanInterval.value / 1000)}s`;
    document.getElementById("sensitivityValue").textContent = sensitivityText;
    document.getElementById("scanIntervalValue").textContent = scanIntervalText;
    updateRangeProgress(sensitivity, sensitivityText);
    updateRangeProgress(scanInterval, scanIntervalText);
  };
  updateDetectionOutputs();
  document.getElementById("sensitivity").addEventListener("input", updateDetectionOutputs);
  document.getElementById("scanIntervalMs").addEventListener("input", updateDetectionOutputs);
  document.getElementById("enabled").addEventListener("change", async (event) => {
    const enabled = event.target.checked;
    if (!enabled) document.getElementById("debug").checked = false;
    await savePreferences({ enabled, ...(enabled ? {} : { debug: false }) });
    updateEnabledState(enabled);
    await sendToYouTube({ type: "CRAVELENS_ENABLED_CHANGED" }).catch(() => {});
    if (!enabled) await sendToYouTube({ type: "CRAVELENS_DEBUG_CHANGED" }).catch(() => {});
    showMessage(enabled ? "CraveLens enabled" : "CraveLens disabled");
  });
  document.getElementById("themeToggle").addEventListener("click", async () => {
    const themeMode = resolvedTheme() === "dark" ? "light" : "dark";
    applyTheme(themeMode);
    await savePreferences({ themeMode });
    await sendToYouTube({ type: "CRAVELENS_THEME_CHANGED", themeMode }).catch(() => {});
    showMessage(`${themeMode === "dark" ? "Dark" : "Light"} mode selected`);
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((readCachedPreferences().themeMode || "system") === "system") applyTheme("system");
  });
  document.getElementById("save").addEventListener("click", async () => {
    const enabled = document.getElementById("enabled").checked;
    if (!enabled) document.getElementById("debug").checked = false;
    const preferences = { enabled, debug: enabled && document.getElementById("debug").checked, addressId: selectedAddress?.id || "", addressLabel: selectedAddress ? addressLabel(selectedAddress) : "", sensitivity: Number(document.getElementById("sensitivity").value), scanIntervalMs: Number(document.getElementById("scanIntervalMs").value), autoDetectYouTube: document.getElementById("autoDetectYouTube").checked, autoDetectInstagram: document.getElementById("autoDetectInstagram").checked, autoDetectFacebook: document.getElementById("autoDetectFacebook").checked, shortcutBehavior: shortcutBehaviorValue(), personalContext: document.getElementById("personalContext").value.trim() };
    await Promise.all([savePreferences(preferences), saveModelSettings()]);
    updateEnabledState(preferences.enabled);
    showMessage("Saved");
  });
  document.getElementById("resetDetectionDefaults").addEventListener("click", async () => {
    document.getElementById("sensitivity").value = DEFAULT_SENSITIVITY;
    document.getElementById("scanIntervalMs").value = DEFAULT_SCAN_INTERVAL_MS;
    document.getElementById("autoDetectYouTube").checked = true;
    document.getElementById("autoDetectInstagram").checked = true;
    document.getElementById("autoDetectFacebook").checked = true;
    setShortcutBehavior(DEFAULT_SHORTCUT_BEHAVIOR);
    updateDetectionOutputs();
    await savePreferences({ sensitivity: DEFAULT_SENSITIVITY, scanIntervalMs: DEFAULT_SCAN_INTERVAL_MS, autoDetectYouTube: true, autoDetectInstagram: true, autoDetectFacebook: true, shortcutBehavior: DEFAULT_SHORTCUT_BEHAVIOR });
    showMessage("Detection defaults restored");
  });
  document.getElementById("connect").addEventListener("click", beginSwiggySignIn);
  document.getElementById("debug").addEventListener("change", async (event) => {
    if (!document.getElementById("enabled").checked) { event.target.checked = false; await savePreferences({ debug: false }); return; }
    await savePreferences({ debug: event.target.checked }); await sendToYouTube({ type: "CRAVELENS_DEBUG_CHANGED" }).catch(() => {});
  });
  document.getElementById("scan").addEventListener("click", scanCurrentFrame);
  document.querySelectorAll('input[name="shortcutBehavior"]').forEach((input) => input.addEventListener("change", () => updateShortcutSlider()));
  document.getElementById("addressTrigger").addEventListener("click", toggleAddressList);
  document.addEventListener("click", (event) => { if (!document.getElementById("addressPicker").contains(event.target)) closeAddressList(); });
  const connection = await getSwiggyConnection();
  if (connection.connected) { showConnected(connection.expiresAt); await loadAddresses(values.addressId); }
  else if (connection.pending) resumePendingSignIn();
  else beginSwiggySignIn();
}

async function scanCurrentFrame() {
  if (!document.getElementById("enabled").checked) { showMessage("Enable CraveLens to scan"); return; }
  const button = document.getElementById("scan"); button.disabled = true; setScanButtonLabel("Checking with local VLM…");
  try {
    const response = await sendToYouTube({ type: "CRAVELENS_DEBUG_SCAN" });
    if (!response?.ok) throw new Error(response?.error || "Scan failed");
    const food = response.result.detections.map((item) => `${item.label} ${Math.round(item.score * 100)}%`).join(", ");
    const verification = response.result.verification;
    document.getElementById("message").textContent = verification
      ? verification.isFood ? `${verification.dish} · Gemma ${Math.round(verification.confidence * 100)}%` : "Gemma did not confirm food"
      : food || "No food class detected";
  } catch (error) { document.getElementById("message").textContent = error.message; }
  finally { updateEnabledState(document.getElementById("enabled").checked); setScanButtonLabel("Scan current frame"); }
}

function setPreferenceControlValue(id, value) {
  if (id === "shortcutBehavior") {
    setShortcutBehavior(value);
    return;
  }
  const control = document.getElementById(id);
  if (!control) return;
  control[isCheckboxPreference(id) ? "checked" : "value"] = value;
}

function isCheckboxPreference(id) {
  return ["enabled", "debug", "autoDetectYouTube", "autoDetectInstagram", "autoDetectFacebook"].includes(id);
}

function setShortcutBehavior(value = DEFAULT_SHORTCUT_BEHAVIOR) {
  const normalized = ["auto-supported", "lasso-always"].includes(value) ? value : DEFAULT_SHORTCUT_BEHAVIOR;
  const input = document.querySelector(`input[name="shortcutBehavior"][value="${normalized}"]`);
  if (input) input.checked = true;
  updateShortcutSlider();
}

function shortcutBehaviorValue() {
  return document.querySelector('input[name="shortcutBehavior"]:checked')?.value || DEFAULT_SHORTCUT_BEHAVIOR;
}

function updateShortcutSlider() {
  const slider = document.getElementById("shortcutBehavior");
  if (slider) slider.dataset.value = shortcutBehaviorValue();
  const hint = document.getElementById("shortcutBehaviorHint");
  if (hint) hint.textContent = shortcutBehaviorValue() === "lasso-always"
    ? "Shortcut always opens the rectangular selector."
    : "Scans video frames on supported sites; uses lasso elsewhere.";
}

async function setupModelSettings() {
  try {
    modelConfiguration = await popupApi("/api/model-settings");
  } catch {
    modelConfiguration = { settings: defaultsModelSettings(), credentials: {} };
  }
  const settings = modelConfiguration.settings || defaultsModelSettings();
  await chrome.storage.local.set({ modelSettings: settings });
  populateLiteRtModelSelect();
  document.getElementById("vlmProvider").value = normalizeVlmProvider(settings.vlm?.provider);
  document.getElementById("agentProvider").value = settings.orchestration?.provider || "auto";
  document.getElementById("agentLiteRtModel").value = normalizeLiteRtModel(settings.orchestration?.model);
  document.getElementById("agentContextTokens").value = normalizeContextTokens(settings.orchestration?.contextTokens);
  document.getElementById("agentThinkingEnabled").checked = settings.orchestration?.thinkingEnabled === true;
  const hostedProvider = ["openai-compatible", "google"].includes(settings.orchestration?.provider);
  document.getElementById("agentModel").value = hostedProvider ? settings.orchestration?.model || "" : "";
  document.getElementById("agentBaseUrl").value = settings.orchestration?.baseUrl || "";
  const ollamaBaseUrl = normalizeOllamaBaseUrl(settings.ollama?.baseUrl || DEFAULT_OLLAMA_BASE_URL);
  document.getElementById("vlmOllamaBaseUrl").value = ollamaBaseUrl;
  document.getElementById("agentOllamaBaseUrl").value = ollamaBaseUrl;
  document.getElementById("vlmProvider").addEventListener("change", updateModelFieldVisibility);
  document.getElementById("agentProvider").addEventListener("change", () => {
    document.getElementById("agentModel").value = "";
    document.getElementById("agentBaseUrl").value = "";
    document.getElementById("agentApiKey").value = "";
    updateModelFieldVisibility();
  });
  document.getElementById("agentContextTokens").addEventListener("input", updateContextLengthOutput);
  document.getElementById("agentLiteRtModel").addEventListener("change", updateModelFieldVisibility);
  document.getElementById("agentThinkingEnabled").addEventListener("change", updateModelFieldVisibility);
  document.getElementById("cancelLiteRtDownload").addEventListener("click", async () => {
    const { liteRtDownloadState } = await chrome.storage.local.get(["liteRtDownloadState"]);
    if (liteRtDownloadState?.modelId) await chrome.runtime.sendMessage({ type: "CRAVELENS_CANCEL_LITERT_DOWNLOAD", modelId: liteRtDownloadState.modelId });
  });
  document.getElementById("removeLiteRtModel").addEventListener("click", async () => {
    const button = document.getElementById("removeLiteRtModel");
    const model = getLiteRtTextModel(document.getElementById("agentLiteRtModel").value);
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "CRAVELENS_REMOVE_LITERT_MODEL", modelId: model.id });
      if (!response?.ok) throw new Error(response?.error || "Unable to remove the cached model");
      renderLiteRtDownloadState({ modelId: model.id, modelName: model.name, modelSize: model.size, state: "removed" });
    } catch (error) {
      renderLiteRtDownloadState({ modelId: model.id, modelName: model.name, modelSize: model.size, state: "error", error: error?.message || String(error) });
    } finally { button.disabled = false; }
  });
  document.getElementById("cancelVlmLiteRtDownload").addEventListener("click", async () => {
    const model = selectedVlmLiteRtDownloadModel();
    if (model) await chrome.runtime.sendMessage({ type: "CRAVELENS_CANCEL_LITERT_DOWNLOAD", modelId: model.id });
  });
  document.getElementById("removeVlmLiteRtModel").addEventListener("click", async () => {
    const button = document.getElementById("removeVlmLiteRtModel");
    const model = selectedVlmLiteRtDownloadModel();
    if (!model) return;
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "CRAVELENS_REMOVE_LITERT_MODEL", modelId: model.id });
      if (!response?.ok) throw new Error(response?.error || "Unable to remove the cached VLM");
      renderLiteRtDownloadState({ modelId: model.id, modelName: model.name, modelSize: model.size, state: "removed" });
    } catch (error) {
      renderLiteRtDownloadState({ modelId: model.id, modelName: model.name, modelSize: model.size, state: "error", error: error?.message || String(error) });
    } finally { button.disabled = false; }
  });
  const { liteRtDownloadState } = await chrome.storage.local.get(["liteRtDownloadState"]);
  renderLiteRtDownloadState(liteRtDownloadState);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.liteRtDownloadState) renderLiteRtDownloadState(changes.liteRtDownloadState.newValue);
  });
  for (const input of [document.getElementById("vlmOllamaBaseUrl"), document.getElementById("agentOllamaBaseUrl")]) {
    input.addEventListener("input", () => {
      const other = input.id === "vlmOllamaBaseUrl" ? document.getElementById("agentOllamaBaseUrl") : document.getElementById("vlmOllamaBaseUrl");
      other.value = input.value;
      scheduleOllamaProbe();
    });
  }
  document.getElementById("testVlmOllama").addEventListener("click", () => loadOllamaModels(currentOllamaSelections(), { requestPermission: true }));
  document.getElementById("testAgentOllama").addEventListener("click", () => loadOllamaModels(currentOllamaSelections(), { requestPermission: true }));
  createModelPicker(document.getElementById("vlmProvider"), (value) => PROVIDER_DETAILS.vlmProvider[value]);
  createModelPicker(document.getElementById("agentProvider"), (value) => PROVIDER_DETAILS.agentProvider[value]);
  await refreshLiteRtAvailability();
  await loadOllamaModels({ vlm: settings.vlm?.model, agent: settings.orchestration?.provider === "ollama" ? settings.orchestration?.model : "" });
  updateContextLengthOutput();
  updateModelFieldVisibility();
}

async function refreshLiteRtAvailability() {
  availableLiteRtVlmProviders = new Set();
  const vlmSelect = document.getElementById("vlmProvider");
  for (const option of vlmSelect.options) {
    if (!["litert-gemma4", "litert-gemma4-e4b"].includes(option.value)) continue;
    option.disabled = !availableLiteRtVlmProviders.has(option.value);
  }
  vlmSelect.modelPicker?.refresh();
}

function populateLiteRtModelSelect() {
  const select = document.getElementById("agentLiteRtModel");
  const selected = normalizeLiteRtModel(select.value);
  select.replaceChildren(...LITERT_TEXT_MODELS.map((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.name} · ${model.size}`;
    return option;
  }));
  select.value = selected;
}

function renderLiteRtDownloadState(state) {
  renderLiteRtDownloadPanel("agentLiteRt", state, getLiteRtTextModel(document.getElementById("agentLiteRtModel")?.value), "model");
  renderLiteRtDownloadPanel("vlmLiteRt", state, selectedVlmLiteRtDownloadModel(), "VLM");
}

function renderLiteRtDownloadPanel(prefix, state, selected, label) {
  const panel = document.getElementById(`${prefix}Download`);
  if (!panel || !selected) return;
  const title = document.getElementById(`${prefix}DownloadTitle`);
  const percent = document.getElementById(`${prefix}DownloadPercent`);
  const progress = document.getElementById(`${prefix}DownloadProgress`);
  const detail = document.getElementById(`${prefix}DownloadDetail`);
  const cancel = document.getElementById(prefix === "agentLiteRt" ? "cancelLiteRtDownload" : "cancelVlmLiteRtDownload");
  const remove = document.getElementById(prefix === "agentLiteRt" ? "removeLiteRtModel" : "removeVlmLiteRtModel");
  const current = state?.modelId === selected.id
    ? state
    : { modelId: selected.id, modelName: selected.name, modelSize: selected.size, state: "idle" };
  title.textContent = current.modelName || selected.name;
  const total = Number(current.totalBytes) || 0;
  const downloaded = Number(current.downloadedBytes) || 0;
  const percentage = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
  progress.style.width = `${percentage}%`;
  cancel.hidden = current.state !== "downloading";
  remove.hidden = current.state === "downloading" || current.modelId !== selected.id;
  if (current.state === "downloading") {
    const seconds = Math.max(.1, (Date.now() - Number(current.startedAt || Date.now())) / 1000);
    const speed = downloaded / seconds;
    percent.textContent = total ? `${percentage}%` : "Downloading";
    detail.textContent = `${formatBytes(downloaded)}${total ? ` / ${formatBytes(total)}` : ""} · ${formatBytes(speed)}/s`;
  } else if (current.state === "cached") {
    percent.textContent = "Cached";
    progress.style.width = "100%";
    detail.textContent = `${current.modelSize || selected.size} is cached privately in this browser.`;
  } else if (current.state === "ready") {
    percent.textContent = "Ready";
    progress.style.width = "100%";
    detail.textContent = `${current.modelSize || selected.size} is loaded and ready for local inference.`;
  } else if (current.state === "error") {
    percent.textContent = "Failed";
    detail.textContent = current.error || "The model download failed. Save Settings to retry.";
  } else if (current.state === "cancelled") {
    percent.textContent = "Cancelled";
    detail.textContent = "Download cancelled. Save Settings to restart it.";
  } else if (current.state === "removed") {
    percent.textContent = "Removed";
    progress.style.width = "0%";
    detail.textContent = `${current.modelSize || selected.size} was removed from this browser. Save Settings to download it again.`;
  } else {
    percent.textContent = "Waiting";
    detail.textContent = `${selected.size} downloads privately after you save this LiteRT ${label} selection.`;
  }
}

function selectedVlmLiteRtDownloadModel() {
  const provider = document.getElementById("vlmProvider")?.value;
  return getLiteRtVlmModelByProvider(provider);
}

function updateContextLengthOutput() {
  const input = document.getElementById("agentContextTokens");
  const value = normalizeContextTokens(input.value);
  input.value = value;
  const label = formatContextTokens(value);
  const min = Number(input.min || MIN_LOCAL_CONTEXT_TOKENS);
  const max = Number(input.max || MAX_LOCAL_CONTEXT_TOKENS);
  const progress = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const progressValue = `${Math.max(0, Math.min(100, progress))}%`;
  input.style.setProperty("--range-progress", progressValue);
  input.closest(".context-length-field")?.style.setProperty("--context-progress", progressValue);
  document.getElementById("agentContextTokensValue").textContent = label;
  input.setAttribute("aria-valuetext", label);
}

function normalizeContextTokens(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_LOCAL_CONTEXT_TOKENS;
  const stepped = Math.round(numeric / 4_096) * 4_096;
  return Math.max(MIN_LOCAL_CONTEXT_TOKENS, Math.min(MAX_LOCAL_CONTEXT_TOKENS, stepped));
}

function formatContextTokens(value) { return `${Math.round(value / 1024)}k`; }

let ollamaProbeTimer;
function scheduleOllamaProbe() {
  clearTimeout(ollamaProbeTimer);
  setOllamaConnectionStatus("checking", "Checking host…");
  ollamaProbeTimer = setTimeout(() => loadOllamaModels(currentOllamaSelections()), 450);
}

function currentOllamaSelections() {
  return { vlm: document.getElementById("vlmModel").value, agent: document.getElementById("agentOllamaModel").value };
}

async function loadOllamaModels(preferred = {}, { requestPermission = false } = {}) {
  try {
    const baseUrl = getOllamaBaseUrl();
    setOllamaConnectionStatus("checking", `Connecting to ${baseUrl}…`);
    if (requestPermission) await ensureOllamaHostPermission(baseUrl);
    else if (!await hasOllamaHostPermission(baseUrl)) throw Object.assign(new Error("Host permission required — click Test to allow this Ollama host."), { code: "HOST_PERMISSION_REQUIRED" });
    const response = await fetch(ollamaApiUrl(baseUrl, "/api/tags"), { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error("Ollama did not respond");
    const tags = (await response.json()).models || [];
    ollamaModels = await Promise.all(tags.slice(0, 50).map(async (tag) => {
      const { name } = tag;
      try {
        const detail = await fetch(ollamaApiUrl(baseUrl, "/api/show"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(2500) });
        const value = detail.ok ? await detail.json() : {};
        return normalizeOllamaModel(tag, value);
      } catch { return normalizeOllamaModel(tag); }
    }));
    const vision = ollamaModels.filter((item) => item.capabilities.includes("vision"));
    const tools = ollamaModels.filter((item) => item.capabilities.includes("tools"));
    populateOllamaSelect(document.getElementById("vlmModel"), vision, preferred.vlm, "No vision models installed");
    populateOllamaSelect(document.getElementById("agentOllamaModel"), tools, preferred.agent, "No tool-capable models installed");
    setOllamaConnectionStatus("success", `Connected · ${tags.length} model${tags.length === 1 ? "" : "s"} · ${vision.length} vision · ${tools.length} tools`);
    return true;
  } catch (error) {
    ollamaModels = [];
    populateOllamaSelect(document.getElementById("vlmModel"), [], preferred.vlm, "Ollama unavailable");
    populateOllamaSelect(document.getElementById("agentOllamaModel"), [], preferred.agent, "Ollama unavailable");
    setOllamaConnectionStatus("error", error.code === "HOST_PERMISSION_REQUIRED" ? error.message : `Connection failed · ${error.message}`);
    return false;
  } finally {
    createModelPicker(document.getElementById("vlmModel"), ollamaModelDetails);
    createModelPicker(document.getElementById("agentOllamaModel"), ollamaModelDetails);
  }
}

function getOllamaBaseUrl() {
  const value = document.getElementById("agentOllamaBaseUrl").value || document.getElementById("vlmOllamaBaseUrl").value;
  const normalized = normalizeOllamaBaseUrl(value);
  document.getElementById("agentOllamaBaseUrl").value = normalized;
  document.getElementById("vlmOllamaBaseUrl").value = normalized;
  return normalized;
}

function normalizeOllamaBaseUrl(value) {
  const url = new URL(String(value || DEFAULT_OLLAMA_BASE_URL).trim());
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Ollama host must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Ollama host cannot include credentials");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Enter only the Ollama origin, without an API path");
  return url.origin;
}

function ollamaApiUrl(baseUrl, path) { return new URL(path, `${baseUrl}/`).toString(); }
function ollamaOriginPattern(baseUrl) { return `${new URL(baseUrl).origin}/*`; }

async function hasOllamaHostPermission(baseUrl) {
  if (baseUrl === DEFAULT_OLLAMA_BASE_URL) return true;
  if (!chrome.permissions?.contains) return false;
  return chrome.permissions.contains({ origins: [ollamaOriginPattern(baseUrl)] });
}

async function ensureOllamaHostPermission(baseUrl) {
  if (await hasOllamaHostPermission(baseUrl)) return;
  if (!chrome.permissions?.request || !await chrome.permissions.request({ origins: [ollamaOriginPattern(baseUrl)] })) {
    throw new Error("CraveLens needs permission to connect to this Ollama host.");
  }
}

function setOllamaConnectionStatus(state, message) {
  for (const id of ["vlmOllamaConnection", "agentOllamaConnection"]) {
    const element = document.getElementById(id);
    element.dataset.state = state;
    element.textContent = message;
  }
}

function updateModelFieldVisibility() {
  const vlmProvider = document.getElementById("vlmProvider").value;
  for (const field of document.querySelectorAll(".ollama-vlm-field")) field.hidden = vlmProvider !== "ollama";
  document.getElementById("vlmLiteRtDownload").hidden = !selectedVlmLiteRtDownloadModel();
  const provider = document.getElementById("agentProvider").value;
  for (const field of document.querySelectorAll(".agent-ollama-model-field")) field.hidden = provider !== "ollama";
  for (const field of document.querySelectorAll(".agent-litert-model-field")) field.hidden = provider !== "litert";
  document.getElementById("agentLiteRtDownload").hidden = !["auto", "litert"].includes(provider);
  for (const field of document.querySelectorAll(".local-context-field")) field.hidden = !["auto", "litert", "ollama"].includes(provider);
  for (const field of document.querySelectorAll(".agent-model-field")) field.hidden = !["openai-compatible", "google"].includes(provider);
  for (const field of document.querySelectorAll(".hosted-openai-field")) field.hidden = provider !== "openai-compatible";
  for (const field of document.querySelectorAll(".hosted-key-field")) field.hidden = !["openai-compatible", "google"].includes(provider);
  const vision = ollamaModels.filter((item) => item.capabilities.includes("vision"));
  const tools = ollamaModels.filter((item) => item.capabilities.includes("tools"));
  const vlmMessages = {
    auto: "Auto tries Gemini Nano, then browser-downloaded Gemma 3n, then a configured Ollama vision model.",
    "litert-gemma4": availableLiteRtVlmProviders.has("litert-gemma4") ? "Runs in the browser with WebGPU; video frames stay on this device." : "The Gemma 4 E2B vision artifact is not installed on the CraveLens server.",
    "litert-gemma4-e4b": availableLiteRtVlmProviders.has("litert-gemma4-e4b") ? "Runs the larger Gemma 4 E4B vision artifact in the browser with WebGPU." : "The Gemma 4 E4B vision artifact is not installed on the CraveLens server.",
    "gemini-nano": "Available only when Chrome exposes the Language Model API with image input.",
    "litert-gemma3n": "Downloads Gemma 3n directly to this browser cache and runs frame verification locally with WebGPU.",
    ollama: vision.length ? `${vision.length} installed vision-capable Ollama model${vision.length === 1 ? "" : "s"} detected.` : "Start Ollama and install a model that advertises vision support.",
  };
  document.getElementById("vlmAvailability").textContent = vlmMessages[vlmProvider] || vlmMessages.auto;
  chrome.storage.local.get(["liteRtDownloadState"]).then(({ liteRtDownloadState }) => renderLiteRtDownloadState(liteRtDownloadState)).catch(() => {});
  if (provider === "ollama") {
    document.getElementById("agentAvailability").textContent = tools.length ? `${tools.length} installed tool-capable Ollama model${tools.length === 1 ? "" : "s"} detected.` : "No installed Ollama model advertises tool support.";
  } else if (["openai-compatible", "google"].includes(provider)) {
    const key = provider === "google" ? "google" : "openai";
    const deployment = modelConfiguration?.deployment?.provider === provider ? modelConfiguration.deployment : undefined;
    const credential = modelConfiguration?.credentials?.[key];
    document.getElementById("agentAvailability").textContent = credential?.configured
      ? `Using ${credential.source === "user" ? "your encrypted override" : "the server configuration"}${deployment?.model ? ` (${deployment.model})` : ""}. Blank fields keep that default.`
      : "No server credential is configured. Enter a key to use this hosted provider.";
    document.getElementById("agentApiKey").placeholder = credential?.configured ? "Leave blank to use the configured key" : "Enter an API key";
  } else if (provider === "litert") {
    const selectedModel = document.getElementById("agentLiteRtModel").value;
    const selected = getLiteRtTextModel(selectedModel);
    document.getElementById("agentAvailability").textContent = `${selected.name} (${selected.size}) downloads and stays cached privately in this browser after you save. Local failures pause the run and require approval before any hosted fallback.`;
  } else document.getElementById("agentAvailability").textContent = "Local failures pause the run and require approval before any hosted fallback.";
  document.getElementById("vlmProvider").modelPicker?.refresh();
  document.getElementById("agentProvider").modelPicker?.refresh();
}

function normalizeOllamaModel(tag, detail = {}) {
  const details = { ...(tag?.details || {}), ...(detail.details || {}) };
  return {
    name: tag?.name || detail.model || "",
    capabilities: Array.isArray(detail.capabilities) ? detail.capabilities : Array.isArray(tag?.capabilities) ? tag.capabilities : [],
    size: Number(tag?.size) || 0,
    family: details.family || details.families?.[0] || "",
    parameterSize: details.parameter_size || "",
    quantization: details.quantization_level || "",
  };
}

function populateOllamaSelect(select, models, preferred, emptyLabel) {
  select.replaceChildren();
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.name;
    option.textContent = model.name;
    select.append(option);
  }
  if (preferred && !models.some((model) => model.name === preferred)) {
    const option = document.createElement("option");
    option.value = preferred;
    option.textContent = `${preferred} · not detected`;
    select.prepend(option);
  }
  if (!select.options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    select.append(option);
  }
  select.value = preferred && [...select.options].some((option) => option.value === preferred) ? preferred : select.options[0]?.value || "";
  select.modelPicker?.refresh();
}

function ollamaModelDetails(value, fallbackLabel) {
  const model = ollamaModels.find((item) => item.name === value);
  if (!model) return { title: fallbackLabel || "Ollama model", description: value ? "Saved model is not currently available" : "Start Ollama to discover installed models", icon: "ollama", badges: value ? ["Unavailable"] : ["Local"] };
  const specifications = [model.parameterSize, model.quantization, formatBytes(model.size)].filter(Boolean);
  return {
    title: model.name,
    description: specifications.join(" · ") || "Installed locally through Ollama",
    icon: /^gemma(?:\d|[-_:]|$)/i.test(model.name) || /^gemma$/i.test(model.family) ? "gemma" : "ollama",
    badges: model.capabilities.map((capability) => capability === "tools" ? "Tool use" : capability),
  };
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** index);
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function createModelPicker(select, resolveDetails) {
  if (select.modelPicker) { select.modelPicker.refresh(); return select.modelPicker; }
  const wrapper = document.createElement("div");
  wrapper.className = "model-picker";
  for (const className of select.classList) if (className.endsWith("-field")) wrapper.classList.add(className);
  wrapper.hidden = select.hidden;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "model-picker-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const menu = document.createElement("div");
  menu.id = `${select.id}Menu`;
  menu.className = "model-picker-menu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;
  trigger.setAttribute("aria-controls", menu.id);
  const label = document.getElementById(`${select.id}Label`);
  if (label) trigger.setAttribute("aria-labelledby", `${label.id} ${select.id}PickerTitle`);
  select.before(wrapper);
  wrapper.append(select, trigger, menu);
  select.classList.add("model-picker-native");

  const close = ({ focus = false } = {}) => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (focus) trigger.focus();
  };
  const open = () => {
    for (const picker of document.querySelectorAll(".model-picker-trigger[aria-expanded='true']")) if (picker !== trigger) picker.click();
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      menu.scrollIntoView({ block: "nearest", behavior: "instant" });
      const selectedOption = menu.querySelector('[aria-selected="true"]');
      selectedOption?.focus({ preventScroll: true });
      selectedOption?.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
  };
  const refresh = () => {
    const options = [...select.options];
    const selected = select.selectedOptions[0] || options[0];
    const selectedDetails = resolveDetails(selected?.value || "", selected?.textContent || "Select a model") || { title: selected?.textContent || "Select a model", icon: "model" };
    renderPickerRow(trigger, { ...selectedDetails, titleId: `${select.id}PickerTitle` }, true);
    menu.replaceChildren();
    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "model-option";
      button.setAttribute("role", "option");
      button.dataset.value = option.value;
      button.setAttribute("aria-selected", String(option.value === select.value));
      renderPickerRow(button, resolveDetails(option.value, option.textContent) || { title: option.textContent, icon: "model" });
      button.addEventListener("click", () => {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        close({ focus: true });
      });
      menu.append(button);
    }
  };
  trigger.addEventListener("click", () => menu.hidden ? open() : close());
  trigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    open();
  });
  menu.addEventListener("keydown", (event) => {
    const options = [...menu.querySelectorAll(".model-option")];
    const index = options.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); close({ focus: true }); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  });
  select.addEventListener("change", refresh);
  label?.addEventListener("click", (event) => { event.preventDefault(); trigger.focus(); });
  document.addEventListener("click", (event) => { if (!wrapper.contains(event.target)) close(); });
  select.modelPicker = { refresh, close };
  refresh();
  return select.modelPicker;
}

function renderPickerRow(container, details, trigger = false) {
  container.replaceChildren();
  container.append(providerIcon(details.icon || "model"));
  const copy = document.createElement("span");
  copy.className = trigger ? "model-picker-trigger-copy" : "model-option-copy";
  const title = document.createElement("b");
  if (details.titleId) title.id = details.titleId;
  title.textContent = details.title || "Select a model";
  copy.append(title);
  if (details.description) {
    const description = document.createElement("small");
    description.textContent = details.description;
    copy.append(description);
  }
  if (details.badges?.length) {
    const badges = document.createElement("span");
    badges.className = "model-badges";
    for (const value of details.badges.slice(0, 3)) {
      const badge = document.createElement("span");
      badge.className = "model-badge";
      badge.textContent = value;
      badges.append(badge);
    }
    copy.append(badges);
  }
  container.append(copy);
  if (trigger) {
    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.classList.add("model-picker-chevron");
    chevron.setAttribute("viewBox", "0 0 20 20");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m5 7.5 5 5 5-5");
    chevron.append(path);
    container.append(chevron);
  } else {
    const check = document.createElement("span");
    check.className = "model-option-check";
    check.textContent = "✓";
    check.setAttribute("aria-hidden", "true");
    container.append(check);
  }
}

function providerIcon(kind) {
  const icon = document.createElement("span");
  icon.className = `model-provider-icon ${kind}`;
  icon.setAttribute("aria-hidden", "true");
  if (["gemma", "ollama", "gemini", "openai"].includes(kind)) {
    const image = document.createElement("img");
    image.src = chrome.runtime.getURL(`provider-icons/${kind}.svg`);
    image.alt = "";
    icon.append(image);
  } else icon.textContent = ({ auto: "✦", model: "LLM" })[kind] || "LLM";
  return icon;
}

async function saveModelSettings() {
  const provider = document.getElementById("agentProvider").value;
  const model = provider === "ollama"
    ? document.getElementById("agentOllamaModel").value
    : provider === "litert"
      ? document.getElementById("agentLiteRtModel").value
      : document.getElementById("agentModel").value.trim();
  const baseUrl = document.getElementById("agentBaseUrl").value.trim();
  const key = document.getElementById("agentApiKey").value.trim();
  const vlmProvider = document.getElementById("vlmProvider").value;
  const body = {
    settings: {
      version: 1,
      vlm: { provider: vlmProvider, ...(vlmProvider === "ollama" && document.getElementById("vlmModel").value ? { model: document.getElementById("vlmModel").value } : {}) },
      orchestration: { provider, contextTokens: normalizeContextTokens(document.getElementById("agentContextTokens").value), thinkingEnabled: document.getElementById("agentThinkingEnabled").checked, ...(model ? { model } : {}), ...(provider === "openai-compatible" && baseUrl ? { baseUrl } : {}) },
      ollama: { baseUrl: getOllamaBaseUrl() },
      hostedFallback: "ask",
    },
    ...(key ? { credentials: { [provider === "google" ? "google" : "openai"]: key } } : {}),
  };
  modelConfiguration = await popupApi("/api/model-settings", { method: "PUT", body });
  await chrome.storage.local.set({ modelSettings: modelConfiguration.settings });
  await chrome.runtime.sendMessage({ type: "CRAVELENS_MODEL_SETTINGS_CHANGED" }).catch(() => {});
  document.getElementById("agentApiKey").value = "";
}

function defaultsModelSettings() { return { version: 1, vlm: { provider: "auto" }, orchestration: { provider: "auto", contextTokens: DEFAULT_LOCAL_CONTEXT_TOKENS, thinkingEnabled: false }, ollama: { baseUrl: DEFAULT_OLLAMA_BASE_URL }, hostedFallback: "ask" }; }

function normalizeVlmProvider(value) {
  return ["auto", "gemini-nano", "litert-gemma3n", "ollama"].includes(value) ? value : "auto";
}

function normalizeLiteRtModel(value) {
  return getLiteRtTextModel(value).id;
}

async function sendToYouTube(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isYouTubeVideoUrl(tab.url)) throw new Error("Open a YouTube video or Short first");
  try { return await chrome.tabs.sendMessage(tab.id, message); }
  catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(error.message)) throw error;
    if (chrome.scripting?.executeScript) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    else {
      await chrome.tabs.reload(tab.id);
      await waitForTabLoad(tab.id);
    }
    await waitForReceiver(tab.id);
    return chrome.tabs.sendMessage(tab.id, message);
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

async function resumePendingSignIn() {
  document.getElementById("connectionTitle").textContent = "Waiting for Swiggy sign-in…";
  document.getElementById("connectionDetail").textContent = "Finish signing in, then return here";
  try {
    const connection = await resumeSwiggyConnection();
    showConnected(connection.expiresAt);
    await loadAddresses();
  } catch (error) {
    document.getElementById("connectionDot").classList.add("offline");
    document.getElementById("connectionTitle").textContent = "Swiggy isn’t connected";
    document.getElementById("connectionDetail").textContent = error.message;
    document.getElementById("connect").hidden = false;
  }
}

async function beginSwiggySignIn() {
  const button = document.getElementById("connect");
  button.hidden = true;
  document.getElementById("connectionTitle").textContent = "Connecting to Swiggy…";
  document.getElementById("connectionDetail").textContent = "Complete sign-in in the secure Swiggy window";
  try {
    const connection = await connectSwiggy();
    showConnected(connection.expiresAt);
    await loadAddresses();
  } catch (error) {
    document.getElementById("connectionDot").classList.add("offline");
    document.getElementById("connectionTitle").textContent = "Swiggy isn’t connected";
    document.getElementById("connectionDetail").textContent = error.message;
    button.hidden = false;
  }
}

function showConnected(expiresAt) {
  document.getElementById("connectionDot").classList.remove("offline");
  document.getElementById("connectionTitle").textContent = "Swiggy connected";
  document.getElementById("connectionDetail").textContent = `Session active until ${new Date(expiresAt).toLocaleDateString()}`;
  document.getElementById("connect").hidden = true;
}

async function loadAddresses(savedAddressId) {
  const list = document.getElementById("addressList");
  try {
    const { addresses } = await popupApi("/api/swiggy/addresses");
    if (!addresses.length) throw new Error("No saved Swiggy addresses found");
    const nearest = await chooseNearest(addresses);
    list.innerHTML = "";
    for (const address of addresses) {
      const option = document.createElement("button"); option.type = "button"; option.className = "address-option"; option.dataset.id = address.id; option.setAttribute("role", "option");
      const badges = addressBadges(address).map((badge) => `<em>${escapeHtml(badge)}</em>`).join("");
      const primary = address.receiverName || meaningfulAddressTag(address) || "Delivery address";
      option.innerHTML = `<span class="badges">${badges}</span><span class="copy"><b>${escapeHtml(primary)}</b><small>${escapeHtml(address.addressString)}${address.phoneNumber ? ` · ${escapeHtml(address.phoneNumber)}` : ""}</small></span>`;
      option.addEventListener("click", () => { selectAddress(address); closeAddressList(); }); list.append(option);
    }
    const chosen = savedAddressId && addresses.find((item) => item.id === savedAddressId) || nearest.address;
    selectAddress(chosen);
    document.getElementById("addressHint").textContent = nearest.usedCoordinates ? "Automatically selected nearest saved address." : "Coordinates aren’t exposed by Swiggy; using its first recommended address.";
    await savePreferences({ addressId: chosen.id, addressLabel: addressLabel(chosen) });
  } catch (error) { document.getElementById("addressPrimary").textContent = "Unable to load addresses"; document.getElementById("addressSecondary").textContent = "Try reconnecting Swiggy"; list.innerHTML = ""; document.getElementById("addressHint").textContent = error.message; }
}

function selectAddress(address) {
  selectedAddress = address;
  const tag = meaningfulAddressTag(address);
  document.getElementById("addressPrimary").textContent = [tag, address.receiverName].filter(Boolean).join(" · ") || "Delivery address";
  document.getElementById("addressSecondary").textContent = address.addressString;
  for (const option of document.querySelectorAll(".address-option")) {
    const selected = option.dataset.id === address.id; option.classList.toggle("selected", selected); option.setAttribute("aria-selected", String(selected));
  }
  savePreferences({ addressId: address.id, addressLabel: addressLabel(address) }).catch(() => {});
}

function meaningfulAddressTag(address) {
  const category = address.category && !/^(other|saved address)$/i.test(address.category) ? address.category : "";
  const tag = address.tag && !/^(other|saved address)$/i.test(address.tag) ? address.tag : "";
  if (category && tag && semanticTag(category) === semanticTag(tag)) return category;
  return tag || category;
}
function addressBadges(address) {
  const category = address.category && !/^(other|saved address)$/i.test(address.category) ? address.category : "";
  const tag = address.tag && !/^(other|saved address)$/i.test(address.tag) ? address.tag : "";
  if (!category) return tag ? [tag] : [];
  if (!tag || semanticTag(category) === semanticTag(tag)) return [category];
  return [`${category} · ${tag}`];
}
function addressLabel(address) { return [meaningfulAddressTag(address), address.receiverName, address.addressString].filter(Boolean).join(" · "); }
function semanticTag(value) { return value.toLowerCase().replace(/\band\b|&/g, "").replace(/[^a-z0-9]/g, ""); }
async function loadPreferences() {
  return { ...defaults, ...await chrome.storage.local.get(defaults), ...readCachedPreferences() };
}
async function savePreferences(value) {
  const preferences = sanitizePreferences({ ...readCachedPreferences(), ...value });
  localStorage.setItem(PREFERENCE_CACHE_KEY, JSON.stringify(preferences));
  await chrome.storage.local.set(preferences);
}
function readCachedPreferences() {
  try { return sanitizePreferences(JSON.parse(localStorage.getItem(PREFERENCE_CACHE_KEY) || "{}")); }
  catch { return {}; }
}
function sanitizePreferences(value) {
  const preferences = {};
  for (const key of preferenceKeys) if (Object.prototype.hasOwnProperty.call(value || {}, key)) preferences[key] = value[key];
  if (typeof preferences.enabled !== "boolean") delete preferences.enabled;
  if (typeof preferences.debug !== "boolean") delete preferences.debug;
  if (typeof preferences.autoDetectYouTube !== "boolean") delete preferences.autoDetectYouTube;
  if (typeof preferences.autoDetectInstagram !== "boolean") delete preferences.autoDetectInstagram;
  if (typeof preferences.autoDetectFacebook !== "boolean") delete preferences.autoDetectFacebook;
  if (typeof preferences.addressId !== "string") delete preferences.addressId;
  if (typeof preferences.addressLabel !== "string") delete preferences.addressLabel;
  if (typeof preferences.personalContext !== "string") delete preferences.personalContext;
  else preferences.personalContext = preferences.personalContext.trim().slice(0, 1000);
  if (!["system", "light", "dark"].includes(preferences.themeMode)) delete preferences.themeMode;
  if (!Number.isFinite(preferences.sensitivity)) delete preferences.sensitivity;
  if (!Number.isFinite(preferences.scanIntervalMs)) delete preferences.scanIntervalMs;
  else preferences.scanIntervalMs = Math.max(MIN_SCAN_INTERVAL_MS, Math.min(MAX_SCAN_INTERVAL_MS, Math.round(preferences.scanIntervalMs / 1000) * 1000));
  if (!["auto-supported", "lasso-always"].includes(preferences.shortcutBehavior)) delete preferences.shortcutBehavior;
  return preferences;
}
function resolvedTheme(mode = document.documentElement.dataset.themeMode || "system") {
  return mode === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : mode;
}
function applyTheme(mode = "system") {
  const theme = resolvedTheme(mode);
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.dataset.theme = theme;
  const button = document.getElementById("themeToggle");
  if (!button) return;
  button.dataset.mode = mode;
  button.setAttribute("aria-label", `${mode === "system" ? "Following system theme. " : ""}Switch to ${theme === "dark" ? "light" : "dark"} mode`);
  button.title = mode === "system" ? `System theme (${theme})` : `${theme[0].toUpperCase()}${theme.slice(1)} mode`;
}
function setScanButtonLabel(label) {
  document.getElementById("scan").innerHTML = `<span>${escapeHtml(label)}</span><kbd>Ctrl Shift Y</kbd>`;
}
function updateEnabledState(enabled) {
  document.getElementById("scan").disabled = !enabled;
  const debug = document.getElementById("debug");
  debug.disabled = !enabled;
  if (!enabled) debug.checked = false;
}
function showMessage(message) {
  document.getElementById("message").textContent = message;
  setTimeout(() => document.getElementById("message").textContent = "", 1500);
}
function toggleAddressList() { const list = document.getElementById("addressList"); const open = list.hidden; list.hidden = !open; document.getElementById("addressTrigger").setAttribute("aria-expanded", String(open)); }
function closeAddressList() { document.getElementById("addressList").hidden = true; document.getElementById("addressTrigger").setAttribute("aria-expanded", "false"); }

async function chooseNearest(addresses) {
  const withCoordinates = addresses.filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
  if (!withCoordinates.length) return { address: addresses[0], usedCoordinates: false };
  try {
    const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000, maximumAge: 300000 }));
    const current = position.coords;
    return { address: withCoordinates.sort((a, b) => distance(current, a) - distance(current, b))[0], usedCoordinates: true };
  } catch { return { address: addresses[0], usedCoordinates: false }; }
}

function distance(a, b) {
  const rad = (value) => value * Math.PI / 180; const dLat = rad(b.latitude - a.latitude); const dLon = rad(b.longitude - a.longitude);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

const popupApi = (path, options = {}) => chrome.runtime.sendMessage({ type: "CRAVELENS_API", path, ...options }).then((response) => { if (!response?.ok) throw new Error(response?.error || "API request failed"); return response.data; });
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

main();
import { connectSwiggy, getSwiggyConnection, resumeSwiggyConnection } from "./oauth.js";
import { LITERT_TEXT_MODELS, getLiteRtTextModel, getLiteRtVlmModelByProvider } from "./litert-models.js";
