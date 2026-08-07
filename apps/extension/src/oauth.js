const api = (path, options = {}) => chrome.runtime.sendMessage({ type: "CRAVELENS_API", path, ...options }).then((response) => {
  if (!response?.ok) throw new Error(response?.error || "CraveLens API request failed");
  return response.data;
});

export async function getSwiggyConnection() {
  const result = await api("/api/swiggy/auth/status");
  return { connected: result.status === "connected", pending: result.status === "pending", expiresAt: result.expiresAt || 0, error: result.error };
}

export async function connectSwiggy() {
  const pending = await api("/api/swiggy/auth/start", { method: "POST" });
  await chrome.storage.local.set({ swiggyOAuthPendingUntil: pending.expiresAt });
  await chrome.tabs.create({ url: pending.authorizationUrl, active: true });
  return waitForConnection();
}

export async function resumeSwiggyConnection() {
  return waitForConnection();
}

async function waitForConnection() {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const result = await api("/api/swiggy/auth/status");
    if (result.status === "connected") {
      await chrome.storage.local.remove(["swiggyOAuthPendingUntil", "swiggySessionId", "swiggyPendingSessionId", "swiggyExpiresAt"]);
      return { connected: true, pending: false, expiresAt: result.expiresAt || 0 };
    }
    if (result.status === "failed" || result.status === "missing") throw new Error(result.error || "Swiggy sign-in session expired.");
  }
  throw new Error("Swiggy sign-in timed out. Try connecting again.");
}
