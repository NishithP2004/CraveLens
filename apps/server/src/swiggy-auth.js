import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "./config.js";
import { decryptJson, encryptJson, sha256 } from "./crypto-store.js";
import { getRedis, redisKeys } from "./redis.js";

const OAUTH_TTL_SECONDS = 10 * 60;
const activeClients = new Map();
const restoring = new Map();

class SwiggyOAuthProvider {
  constructor(redirectUrl, oauthState, saved = {}, onTokens) {
    this.redirectUrl = redirectUrl;
    this.oauthState = oauthState;
    this.clientInfo = saved.clientInformation;
    this.oauthTokens = saved.tokens;
    this.verifier = saved.verifier;
    this.onTokens = onTokens;
    this.clientMetadata = { redirect_uris: [redirectUrl], client_name: "CraveLens", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "mcp:tools" };
  }
  state() { return this.oauthState; }
  clientInformation() { return this.clientInfo; }
  saveClientInformation(value) { this.clientInfo = value; }
  tokens() { return this.oauthTokens; }
  async saveTokens(value) { this.oauthTokens = value; await this.onTokens?.(value); }
  redirectToAuthorization(url) { this.authorizationUrl = url.toString(); }
  saveCodeVerifier(value) { this.verifier = value; }
  codeVerifier() { if (!this.verifier) throw new Error("OAuth verifier is unavailable"); return this.verifier; }
}

export async function startSwiggyAuthorization(deviceId) {
  const redirectUri = `${config.publicBaseUrl.replace(/\/$/, "")}/api/swiggy/auth/callback`;
  if (!/^http:\/\/localhost(?::\d+)?\//.test(redirectUri) && !/^https:\/\//.test(redirectUri)) throw new Error("PUBLIC_BASE_URL must be localhost or HTTPS");
  const state = crypto.randomBytes(32).toString("base64url");
  const provider = new SwiggyOAuthProvider(redirectUri, state);
  const transport = new StreamableHTTPClientTransport(new URL(config.swiggyFoodMcpUrl), { authProvider: provider });
  const client = new Client({ name: "cravelens", version: "0.1.0" });
  try { await client.connect(transport); } catch (error) { if (!provider.authorizationUrl) throw error; }
  await client.close().catch(() => {});
  if (!provider.authorizationUrl || !provider.verifier) throw new Error("Swiggy did not initiate authorization");
  const redis = await getRedis();
  const pending = { deviceId, redirectUrl: redirectUri, verifier: provider.verifier, clientInformation: provider.clientInfo, createdAt: Date.now() };
  await Promise.all([
    redis.set(redisKeys.oauthState(sha256(state)), encryptJson(pending, `cravelens:oauth:${state}`), { EX: OAUTH_TTL_SECONDS }),
    redis.hSet(redisKeys.device(deviceId), { swiggyOAuthStatus: "pending", updatedAt: String(Date.now()) }),
  ]);
  return { authorizationUrl: provider.authorizationUrl, expiresAt: Date.now() + OAUTH_TTL_SECONDS * 1000 };
}

export async function completeSwiggyAuthorization(state, code) {
  if (!state || !code) throw new Error("Swiggy returned an incomplete OAuth response");
  const redis = await getRedis();
  const encrypted = await redis.getDel(redisKeys.oauthState(sha256(state)));
  if (!encrypted) throw new Error("OAuth state is invalid, expired, or has already been used");
  const pending = decryptJson(encrypted, `cravelens:oauth:${state}`);
  const provider = new SwiggyOAuthProvider(pending.redirectUrl, state, pending);
  const exchangeTransport = new StreamableHTTPClientTransport(new URL(config.swiggyFoodMcpUrl), { authProvider: provider });
  try {
    await exchangeTransport.finishAuth(code);
    if (!provider.oauthTokens?.access_token) throw new Error("Swiggy did not return an access token");
    const expiresIn = Math.max(60, Number(provider.oauthTokens.expires_in || 5 * 24 * 60 * 60));
    const credential = { redirectUrl: pending.redirectUrl, tokens: provider.oauthTokens, clientInformation: provider.clientInfo, createdAt: Date.now(), expiresAt: Date.now() + expiresIn * 1000 };
    await Promise.all([
      redis.set(redisKeys.swiggyCredential(pending.deviceId), encryptJson(credential, `cravelens:swiggy:${pending.deviceId}`), { EX: expiresIn }),
      redis.hSet(redisKeys.device(pending.deviceId), { swiggyOAuthStatus: "connected", swiggyExpiresAt: String(credential.expiresAt), updatedAt: String(Date.now()) }),
    ]);
    activeClients.delete(pending.deviceId);
    return pending.deviceId;
  } catch (error) {
    await redis.hSet(redisKeys.device(pending.deviceId), { swiggyOAuthStatus: "failed", swiggyOAuthError: error instanceof Error ? error.message.slice(0, 300) : "Authorization failed" });
    throw error;
  } finally { await exchangeTransport.close().catch(() => {}); }
}

export async function getSwiggyAuthorizationStatus(deviceId) {
  const redis = await getRedis();
  const [credentialExists, device] = await Promise.all([redis.exists(redisKeys.swiggyCredential(deviceId)), redis.hGetAll(redisKeys.device(deviceId))]);
  if (credentialExists) return { status: "connected", expiresAt: Number(device.swiggyExpiresAt) || undefined };
  if (device.swiggyOAuthStatus === "failed") return { status: "failed", error: device.swiggyOAuthError || "Authorization failed" };
  return { status: device.swiggyOAuthStatus === "pending" ? "pending" : "missing" };
}

export async function failSwiggyAuthorization(state, message) {
  if (!state) return;
  const redis = await getRedis();
  const encrypted = await redis.getDel(redisKeys.oauthState(sha256(state)));
  if (!encrypted) return;
  const pending = decryptJson(encrypted, `cravelens:oauth:${state}`);
  await redis.hSet(redisKeys.device(pending.deviceId), { swiggyOAuthStatus: "failed", swiggyOAuthError: String(message).slice(0, 300) });
}

export async function disconnectSwiggy(deviceId) {
  activeClients.delete(deviceId);
  const redis = await getRedis();
  await redis.del(redisKeys.swiggyCredential(deviceId));
  await redis.hSet(redisKeys.device(deviceId), { swiggyOAuthStatus: "missing", swiggyExpiresAt: "" });
}

export async function getSwiggySession(deviceId) {
  if (!deviceId) return undefined;
  if (activeClients.has(deviceId)) return activeClients.get(deviceId);
  if (restoring.has(deviceId)) return restoring.get(deviceId);
  const operation = restoreSession(deviceId).finally(() => restoring.delete(deviceId));
  restoring.set(deviceId, operation);
  return operation;
}

async function restoreSession(deviceId) {
  const redis = await getRedis();
  const encrypted = await redis.get(redisKeys.swiggyCredential(deviceId));
  if (!encrypted) return undefined;
  const saved = decryptJson(encrypted, `cravelens:swiggy:${deviceId}`);
  const provider = new SwiggyOAuthProvider(saved.redirectUrl, undefined, saved, async (tokens) => {
    const expiresIn = Math.max(60, Number(tokens.expires_in || 5 * 24 * 60 * 60));
    const refreshed = { ...saved, tokens, expiresAt: Date.now() + expiresIn * 1000 };
    await redis.set(redisKeys.swiggyCredential(deviceId), encryptJson(refreshed, `cravelens:swiggy:${deviceId}`), { EX: expiresIn });
    await redis.hSet(redisKeys.device(deviceId), { swiggyExpiresAt: String(refreshed.expiresAt), updatedAt: String(Date.now()) });
  });
  const transport = new StreamableHTTPClientTransport(new URL(config.swiggyFoodMcpUrl), { authProvider: provider });
  const client = new Client({ name: "cravelens", version: "0.1.0" });
  try {
    await client.connect(transport);
    const session = { provider, transport, client, connected: true, createdAt: saved.createdAt };
    activeClients.set(deviceId, session);
    return session;
  } catch {
    await client.close().catch(() => {});
    await redis.del(redisKeys.swiggyCredential(deviceId));
    return undefined;
  }
}
