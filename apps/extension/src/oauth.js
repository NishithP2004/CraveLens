const TOKEN_LIFETIME_MS = 5 * 24 * 60 * 60 * 1000;
const api = (path, options = {}) => chrome.runtime.sendMessage({ type: "CRAVELENS_API", path, ...options }).then((response) => {
  if (!response.ok) throw new Error(response.error);
  return response.data;
});

export async function getSwiggyConnection() {
  const value = await chrome.storage.local.get(["swiggySessionId", "swiggyPendingSessionId", "swiggyExpiresAt"]);
  if (value.swiggySessionId && Number(value.swiggyExpiresAt) > Date.now() + 60_000) {
    try {
      const status = await api(`/api/swiggy/auth/status/${value.swiggySessionId}`);
      if (status.status === "connected") return { connected: true, pending: false, expiresAt: Number(value.swiggyExpiresAt) };
    } catch { /* backend unavailable or session no longer exists */ }
    await chrome.storage.local.remove(["swiggySessionId", "swiggyExpiresAt"]);
  }
  if (value.swiggyPendingSessionId) {
    const result = await api(`/api/swiggy/auth/status/${value.swiggyPendingSessionId}`);
    if (result.status === "connected") return saveConnected(value.swiggyPendingSessionId);
    if (result.status === "pending") return { connected: false, pending: true, sessionId: value.swiggyPendingSessionId, expiresAt: 0 };
    await chrome.storage.local.remove("swiggyPendingSessionId");
  }
  return { connected: false, pending: false, expiresAt: 0 };
}

export async function connectSwiggy() {
  const pending = await api("/api/swiggy/auth/start", { method: "POST" });
  await chrome.storage.local.set({ swiggyPendingSessionId: pending.sessionId });
  await chrome.tabs.create({ url: pending.authorizationUrl, active: true });
  await waitForConnection(pending.sessionId);
  return saveConnected(pending.sessionId);
}

export async function resumeSwiggyConnection(sessionId) {
  await waitForConnection(sessionId);
  return saveConnected(sessionId);
}

async function saveConnected(sessionId) {
  const expiresAt = Date.now() + TOKEN_LIFETIME_MS;
  await chrome.storage.local.set({ swiggySessionId: sessionId, swiggyExpiresAt: expiresAt });
  await chrome.storage.local.remove("swiggyPendingSessionId");
  return { connected: true, pending: false, expiresAt };
}

async function waitForConnection(sessionId) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const result = await api(`/api/swiggy/auth/status/${sessionId}`);
    if (result.status === "connected") return;
    if (result.status === "failed" || result.status === "missing") throw new Error(result.error || "Swiggy sign-in session expired.");
  }
  throw new Error("Swiggy sign-in timed out. Try connecting again.");
}
