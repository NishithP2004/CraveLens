import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "./config.js";

const sessions = new Map();
const restoring = new Map();
const authStorePath = fileURLToPath(new URL("../../../.cravelens/swiggy-oauth.json", import.meta.url));

// This is only the SDK's persistence/UI adapter. The MCP SDK performs discovery,
// dynamic client registration, PKCE generation, validation, and token exchange.
class SwiggyOAuthProvider {
  constructor(redirectUrl, sessionId) {
    this.redirectUrl = redirectUrl;
    this.sessionId = sessionId;
    this.clientMetadata = { redirect_uris: [redirectUrl], client_name: "CraveLens", grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "mcp:tools" };
  }
  clientInformation() { return this.clientInfo; }
  saveClientInformation(value) { this.clientInfo = value; void persistSessions(); }
  tokens() { return this.oauthTokens; }
  saveTokens(value) { this.oauthTokens = value; void persistSessions(); }
  redirectToAuthorization(url) { this.authorizationUrl = url.toString(); }
  saveCodeVerifier(value) { this.verifier = value; }
  codeVerifier() { if (!this.verifier) throw new Error("OAuth verifier is unavailable"); return this.verifier; }
}

export async function startSwiggyAuthorization() {
  const sessionId = crypto.randomUUID();
  const redirectUri = `${config.publicBaseUrl}/api/swiggy/auth/callback?sessionId=${encodeURIComponent(sessionId)}`;
  if (!/^http:\/\/localhost(?::\d+)?\//.test(redirectUri) && !/^https:\/\//.test(redirectUri)) throw new Error("PUBLIC_BASE_URL must be localhost or HTTPS");
  const provider = new SwiggyOAuthProvider(redirectUri, sessionId);
  const transport = new StreamableHTTPClientTransport(new URL(config.swiggyFoodMcpUrl), { authProvider: provider });
  const client = new Client({ name: "cravelens", version: "0.1.0" });
  try { await client.connect(transport); } catch (error) {
    if (!provider.authorizationUrl) throw error;
  }
  if (!provider.authorizationUrl) throw new Error("Swiggy did not initiate authorization");
  sessions.set(sessionId, { provider, transport, client, connected: false, createdAt: Date.now() });
  return { sessionId, authorizationUrl: provider.authorizationUrl };
}

export async function completeSwiggyAuthorization(sessionId, code) {
  const session = sessions.get(sessionId);
  if (!session || Date.now() - session.createdAt > 10 * 60_000) throw new Error("OAuth session expired; start sign-in again");
  // finishAuth stores the exchanged tokens on the provider. The transport used
  // to discover OAuth was already started by client.connect(), so it cannot be
  // connected a second time. Close it and initialize a fresh authenticated pair.
  await session.transport.finishAuth(code);
  await session.client.close().catch(() => {});
  const transport = new StreamableHTTPClientTransport(new URL(config.swiggyFoodMcpUrl), { authProvider: session.provider });
  const client = new Client({ name: "cravelens", version: "0.1.0" });
  await client.connect(transport);
  session.transport = transport;
  session.client = client;
  session.connected = true;
  await persistSessions();
}

export async function getSwiggyAuthorizationStatus(sessionId) {
  const session = sessions.get(sessionId) || await restoreSession(sessionId);
  if (!session) return { status: "missing" };
  if (session.error) return { status: "failed", error: session.error };
  return { status: session.connected ? "connected" : "pending" };
}

export function failSwiggyAuthorization(sessionId, error) {
  const session = sessions.get(sessionId);
  if (session) session.error = error;
}

export async function getSwiggySession(sessionId) {
  const session = sessions.get(sessionId) || await restoreSession(sessionId);
  return session?.connected ? session : undefined;
}

async function restoreSession(sessionId) {
  if (!sessionId) return undefined;
  if (restoring.has(sessionId)) return restoring.get(sessionId);
  const operation = (async () => {
    const stored = await readStoredSessions();
    const saved = stored[sessionId];
    if (!saved?.tokens || !saved?.clientInformation || !saved?.redirectUrl) return undefined;
    const provider = new SwiggyOAuthProvider(saved.redirectUrl, sessionId);
    provider.oauthTokens = saved.tokens;
    provider.clientInfo = saved.clientInformation;
    const transport = new StreamableHTTPClientTransport(new URL(config.swiggyFoodMcpUrl), { authProvider: provider });
    const client = new Client({ name: "cravelens", version: "0.1.0" });
    try {
      await client.connect(transport);
      const session = { provider, transport, client, connected: true, createdAt: saved.createdAt || Date.now() };
      sessions.set(sessionId, session);
      return session;
    } catch {
      await client.close().catch(() => {});
      return undefined;
    }
  })().finally(() => restoring.delete(sessionId));
  restoring.set(sessionId, operation);
  return operation;
}

async function persistSessions() {
  const stored = await readStoredSessions();
  for (const [sessionId, session] of sessions) {
    if (!session.provider.oauthTokens || !session.provider.clientInfo) continue;
    stored[sessionId] = {
      redirectUrl: session.provider.redirectUrl,
      tokens: session.provider.oauthTokens,
      clientInformation: session.provider.clientInfo,
      createdAt: session.createdAt,
    };
  }
  await mkdir(dirname(authStorePath), { recursive: true });
  await writeFile(authStorePath, JSON.stringify(stored), { mode: 0o600 });
}

async function readStoredSessions() {
  try { return JSON.parse(await readFile(authStorePath, "utf8")); }
  catch { return {}; }
}
