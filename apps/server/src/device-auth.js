import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { config } from "./config.js";
import { getRedis, redisKeys } from "./redis.js";
import { sha256 } from "./crypto-store.js";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

function signingKey() {
  if (!config.deviceSessionSigningKey || config.deviceSessionSigningKey.length < 32) throw new Error("DEVICE_SESSION_SIGNING_KEY must contain at least 32 characters");
  return new TextEncoder().encode(config.deviceSessionSigningKey);
}

async function issueAccessToken(deviceId) {
  return new SignJWT({ deviceId, tokenType: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("cravelens")
    .setAudience("cravelens-extension")
    .setSubject(deviceId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(signingKey());
}

async function issueSession(deviceId, familyId = crypto.randomUUID()) {
  const redis = await getRedis();
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  const tokenHash = sha256(refreshToken);
  const record = { deviceId, familyId, createdAt: Date.now() };
  await Promise.all([
    redis.set(redisKeys.refresh(tokenHash), JSON.stringify(record), { EX: REFRESH_TTL_SECONDS }),
    redis.sAdd(redisKeys.refreshFamily(familyId), tokenHash),
    redis.expire(redisKeys.refreshFamily(familyId), REFRESH_TTL_SECONDS),
    redis.hSet(redisKeys.device(deviceId), { updatedAt: String(Date.now()) }),
  ]);
  return { deviceId, accessToken: await issueAccessToken(deviceId), accessExpiresAt: Date.now() + ACCESS_TTL_SECONDS * 1000, refreshToken, refreshExpiresAt: Date.now() + REFRESH_TTL_SECONDS * 1000 };
}

export async function createDeviceSession() {
  return issueSession(crypto.randomUUID());
}

export async function rotateDeviceSession(refreshToken) {
  const redis = await getRedis();
  const tokenHash = sha256(refreshToken || "");
  const key = redisKeys.refresh(tokenHash);
  const raw = await redis.getDel(key);
  if (!raw) {
    const consumed = await redis.get(redisKeys.usedRefresh(tokenHash));
    if (consumed) {
      const { familyId } = JSON.parse(consumed);
      const hashes = await redis.sMembers(redisKeys.refreshFamily(familyId));
      if (hashes.length) await redis.del(hashes.map(redisKeys.refresh));
      await redis.del(redisKeys.refreshFamily(familyId));
    }
    throw authError("Refresh token is invalid, expired, or has already been used", "REFRESH_REUSE");
  }
  const record = JSON.parse(raw);
  await Promise.all([
    redis.sRem(redisKeys.refreshFamily(record.familyId), tokenHash),
    redis.set(redisKeys.usedRefresh(tokenHash), JSON.stringify({ familyId: record.familyId }), { EX: REFRESH_TTL_SECONDS }),
  ]);
  return issueSession(record.deviceId, record.familyId);
}

export async function revokeDeviceSession(refreshToken) {
  const redis = await getRedis();
  const raw = await redis.get(redisKeys.refresh(sha256(refreshToken || "")));
  if (!raw) return;
  const { familyId } = JSON.parse(raw);
  const familyKey = redisKeys.refreshFamily(familyId);
  const hashes = await redis.sMembers(familyKey);
  if (hashes.length) await redis.del(hashes.map(redisKeys.refresh));
  await redis.del(familyKey);
}

export async function authenticateDeviceToken(token) {
  try {
    const { payload } = await jwtVerify(token, signingKey(), { issuer: "cravelens", audience: "cravelens-extension" });
    if (payload.tokenType !== "access" || !payload.deviceId) throw new Error("Invalid token type");
    return String(payload.deviceId);
  } catch { throw authError("Device session is missing or expired", "DEVICE_AUTH_REQUIRED"); }
}

export async function requireDevice(req, _res, next) {
  try {
    const header = req.get("authorization") || "";
    if (!header.startsWith("Bearer ")) throw authError("Device session is required", "DEVICE_AUTH_REQUIRED");
    req.deviceId = await authenticateDeviceToken(header.slice(7));
    next();
  } catch (error) { next(error); }
}

function authError(message, code) {
  const error = new Error(message); error.statusCode = 401; error.code = code; return error;
}
