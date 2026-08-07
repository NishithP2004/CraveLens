import { getRedis, redisKeys } from "./redis.js";

const TTL_SECONDS = 120;

export async function requestFallbackApproval(deviceId, runId, details) {
  const redis = await getRedis();
  await redis.set(redisKeys.fallback(deviceId, runId), JSON.stringify({ status: "pending", details, createdAt: Date.now() }), { EX: TTL_SECONDS });
  return { runId, status: "pending", expiresAt: Date.now() + TTL_SECONDS * 1000 };
}

export async function decideFallback(deviceId, runId, decision) {
  if (!["approve", "deny"].includes(decision)) throw Object.assign(new Error("decision must be approve or deny"), { statusCode: 400 });
  const redis = await getRedis();
  const key = redisKeys.fallback(deviceId, runId);
  const raw = await redis.get(key);
  if (!raw) throw Object.assign(new Error("Fallback request expired or was not found"), { statusCode: 404 });
  const value = { ...JSON.parse(raw), status: decision === "approve" ? "approved" : "denied", decidedAt: Date.now() };
  await redis.set(key, JSON.stringify(value), { EX: TTL_SECONDS });
  await redis.publish(`cravelens:fallback-result:${deviceId}:${runId}`, value.status);
  return value;
}

export async function waitForFallbackDecision(deviceId, runId, { timeoutMs = TTL_SECONDS * 1000, intervalMs = 500, signal } = {}) {
  const redis = await getRedis();
  const key = redisKeys.fallback(deviceId, runId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return "denied";
    const raw = await redis.get(key);
    if (!raw) return "expired";
    const status = JSON.parse(raw).status;
    if (status === "approved" || status === "denied") return status;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return "expired";
}
