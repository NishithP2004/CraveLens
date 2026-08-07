import dns from "node:dns/promises";
import net from "node:net";
import { ModelSettingsSchema, ModelSettingsUpdateSchema } from "@cravelens/shared";
import { config } from "./config.js";
import { decryptJson, encryptJson } from "./crypto-store.js";
import { getRedis, redisKeys } from "./redis.js";

const DEFAULT_SETTINGS = ModelSettingsSchema.parse({ ollama: { baseUrl: config.ollamaBaseUrl } });

export async function getModelSettings(deviceId) {
  const redis = await getRedis();
  const raw = await redis.get(redisKeys.modelSettings(deviceId));
  if (!raw) return DEFAULT_SETTINGS;
  const stored = JSON.parse(raw);
  return ModelSettingsSchema.parse({ ...stored, ollama: { ...DEFAULT_SETTINGS.ollama, ...stored.ollama } });
}

export async function getPublicModelSettings(deviceId) {
  const redis = await getRedis();
  const settings = await getModelSettings(deviceId);
  const [openai, google] = await Promise.all([
    redis.exists(redisKeys.modelCredential(deviceId, "openai")),
    redis.exists(redisKeys.modelCredential(deviceId, "google")),
  ]);
  return {
    settings,
    deployment: {
      provider: config.agentModelProvider === "openai" ? "openai-compatible" : config.agentModelProvider === "gemini" ? "google" : config.agentModelProvider,
      model: config.agentModelName,
    },
    credentials: {
      openai: { configured: Boolean(openai || config.agentModelProvider === "openai" && config.agentModelApiKey), source: openai ? "user" : config.agentModelProvider === "openai" && config.agentModelApiKey ? "deployment" : "none" },
      google: { configured: Boolean(google || config.agentModelProvider === "gemini" && config.agentModelApiKey), source: google ? "user" : config.agentModelProvider === "gemini" && config.agentModelApiKey ? "deployment" : "none" },
    },
  };
}

export async function saveModelSettings(deviceId, input) {
  const value = ModelSettingsUpdateSchema.parse(input);
  if (value.settings.orchestration.provider === "openai-compatible") {
    await assertSafeHostedBaseUrl(value.settings.orchestration.baseUrl || config.agentModelBaseUrl);
  }
  const redis = await getRedis();
  const operations = [redis.set(redisKeys.modelSettings(deviceId), JSON.stringify(value.settings))];
  for (const [provider, credential] of Object.entries(value.credentials || {})) {
    operations.push(redis.set(redisKeys.modelCredential(deviceId, provider), encryptJson({ credential }, `cravelens:model:${deviceId}:${provider}`)));
  }
  await Promise.all(operations);
  return getPublicModelSettings(deviceId);
}

export async function deleteModelCredential(deviceId, provider) {
  if (!new Set(["openai", "google"]).has(provider)) throw Object.assign(new Error("Unsupported model credential provider"), { statusCode: 400 });
  await (await getRedis()).del(redisKeys.modelCredential(deviceId, provider));
}

export async function resolveModelCredential(deviceId, provider) {
  const redis = await getRedis();
  const raw = await redis.get(redisKeys.modelCredential(deviceId, provider));
  if (raw) return { value: decryptJson(raw, `cravelens:model:${deviceId}:${provider}`).credential, source: "user" };
  const deploymentMatches = provider === "openai" ? config.agentModelProvider === "openai" : config.agentModelProvider === "gemini";
  return { value: deploymentMatches ? config.agentModelApiKey : "", source: deploymentMatches && config.agentModelApiKey ? "deployment" : "none" };
}

export async function assertSafeHostedBaseUrl(value, lookup = dns.lookup) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw Object.assign(new Error("Custom model base URL must use HTTPS"), { statusCode: 400 });
  if (url.username || url.password) throw Object.assign(new Error("Custom model base URL cannot contain credentials"), { statusCode: 400 });
  if (["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())) throw unsafeUrl();
  const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw unsafeUrl();
  return url.toString().replace(/\/$/, "");
}

export async function safeHostedFetch(input, init = {}, { fetchImpl = fetch, maxRedirects = 3 } = {}) {
  let url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    await assertSafeHostedBaseUrl(url.toString());
    const response = await fetchImpl(url, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirect === maxRedirects) throw Object.assign(new Error("Unsafe or excessive redirect from hosted model endpoint"), { statusCode: 502 });
    url = new URL(location, url);
  }
  throw Object.assign(new Error("Hosted model redirect limit exceeded"), { statusCode: 502 });
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
  }
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
}

function unsafeUrl() { return Object.assign(new Error("Custom model base URL cannot resolve to a private or local address"), { statusCode: 400 }); }
