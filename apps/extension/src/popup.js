const DEFAULT_SENSITIVITY = .38;
const DEFAULT_SCAN_INTERVAL_MS = 4000;
const MIN_SCAN_INTERVAL_MS = 2000;
const MAX_SCAN_INTERVAL_MS = 30000;
const ids = ["enabled", "debug", "sensitivity", "scanIntervalMs", "personalContext"];
const defaults = { enabled: true, debug: false, addressId: "", addressLabel: "", sensitivity: DEFAULT_SENSITIVITY, scanIntervalMs: DEFAULT_SCAN_INTERVAL_MS, themeMode: "system", personalContext: "" };
const preferenceKeys = Object.keys(defaults);
const PREFERENCE_CACHE_KEY = "cravelens.preferences.v1";
let selectedAddress;

async function main() {
  const contextPanels = [...document.querySelectorAll('details[name="popup-context"]')];
  for (const panel of contextPanels) panel.addEventListener("toggle", () => {
    if (panel.open) for (const other of contextPanels) if (other !== panel) other.open = false;
  });
  const values = await loadPreferences();
  await savePreferences(values);
  applyTheme(values.themeMode);
  for (const id of ids) document.getElementById(id)[id === "enabled" || id === "debug" ? "checked" : "value"] = values[id];
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
    const preferences = { enabled, debug: enabled && document.getElementById("debug").checked, addressId: selectedAddress?.id || "", addressLabel: selectedAddress ? addressLabel(selectedAddress) : "", sensitivity: Number(document.getElementById("sensitivity").value), scanIntervalMs: Number(document.getElementById("scanIntervalMs").value), personalContext: document.getElementById("personalContext").value.trim() };
    await savePreferences(preferences);
    updateEnabledState(preferences.enabled);
    showMessage("Saved");
  });
  document.getElementById("resetDetectionDefaults").addEventListener("click", async () => {
    document.getElementById("sensitivity").value = DEFAULT_SENSITIVITY;
    document.getElementById("scanIntervalMs").value = DEFAULT_SCAN_INTERVAL_MS;
    updateDetectionOutputs();
    await savePreferences({ sensitivity: DEFAULT_SENSITIVITY, scanIntervalMs: DEFAULT_SCAN_INTERVAL_MS });
    showMessage("Detection defaults restored");
  });
  document.getElementById("connect").addEventListener("click", beginSwiggySignIn);
  document.getElementById("debug").addEventListener("change", async (event) => {
    if (!document.getElementById("enabled").checked) { event.target.checked = false; await savePreferences({ debug: false }); return; }
    await savePreferences({ debug: event.target.checked }); await sendToYouTube({ type: "CRAVELENS_DEBUG_CHANGED" }).catch(() => {});
  });
  document.getElementById("scan").addEventListener("click", scanCurrentFrame);
  document.getElementById("addressTrigger").addEventListener("click", toggleAddressList);
  document.addEventListener("click", (event) => { if (!document.getElementById("addressPicker").contains(event.target)) closeAddressList(); });
  const connection = await getSwiggyConnection();
  if (connection.connected) { showConnected(connection.expiresAt); await loadAddresses(values.addressId); }
  else if (connection.pending) resumePendingSignIn(connection.sessionId);
  else beginSwiggySignIn();
}

async function scanCurrentFrame() {
  if (!document.getElementById("enabled").checked) { showMessage("Enable CraveLens to scan"); return; }
  const button = document.getElementById("scan"); button.disabled = true; setScanButtonLabel("Checking with Gemma 3n…");
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

async function resumePendingSignIn(sessionId) {
  document.getElementById("connectionTitle").textContent = "Waiting for Swiggy sign-in…";
  document.getElementById("connectionDetail").textContent = "Finish signing in, then return here";
  try {
    const connection = await resumeSwiggyConnection(sessionId);
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
  if (typeof preferences.addressId !== "string") delete preferences.addressId;
  if (typeof preferences.addressLabel !== "string") delete preferences.addressLabel;
  if (typeof preferences.personalContext !== "string") delete preferences.personalContext;
  else preferences.personalContext = preferences.personalContext.trim().slice(0, 1000);
  if (!["system", "light", "dark"].includes(preferences.themeMode)) delete preferences.themeMode;
  if (!Number.isFinite(preferences.sensitivity)) delete preferences.sensitivity;
  if (!Number.isFinite(preferences.scanIntervalMs)) delete preferences.scanIntervalMs;
  else preferences.scanIntervalMs = Math.max(MIN_SCAN_INTERVAL_MS, Math.min(MAX_SCAN_INTERVAL_MS, Math.round(preferences.scanIntervalMs / 1000) * 1000));
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

const popupApi = (path) => chrome.runtime.sendMessage({ type: "CRAVELENS_API", path }).then((response) => { if (!response?.ok) throw new Error(response?.error || "API request failed"); return response.data; });
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

main();
import { connectSwiggy, getSwiggyConnection, resumeSwiggyConnection } from "./oauth.js";
