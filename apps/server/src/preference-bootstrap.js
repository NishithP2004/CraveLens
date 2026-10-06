import { tracedOperation } from "./trace-context.js";
import crypto from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { getRedis, redisKeys } from "./redis.js";
import { decryptJson, encryptJson, sha256 } from "./crypto-store.js";
import { refinePreferences } from "./preference-builder.js";

const profileSchema = z.object({
  source: z.literal("inferred_history"),
  addressId: z.string().min(1),
  connectionCreatedAt: z.number(),
  preferences: z.string().trim().max(1000),
  notes: z.string().max(1500),
  history: z.object({ matched: z.number(), target: z.number(), checked: z.number(), excluded: z.number(), incomplete: z.boolean(), scope: z.literal("account") }),
  generatedAt: z.number(),
});
const profileLifetimeMs = 30 * 24 * 60 * 60_000;
const emptyHistoryLifetimeMs = 24 * 60 * 60_000;

// Reuse the same read-only history generator as the popup. Explicit context
// always wins; an inferred profile is scoped to this account connection/address.
async function ensureCartPreferencesImpl({ deviceId, addressId, personalContext = "", mcp, chatModel, progress = async () => {}, signal = AbortSignal.timeout(300_000) }) {
  const explicit = personalContext.trim();
  if (explicit) return { personalContext: explicit, personalContextSource: "explicit" };
  if (!deviceId || !addressId) throw new Error("Connect Swiggy and select a delivery address before generating preferences.");
  const redis = await getRedis();
  const credentialKey = redisKeys.swiggyCredential(deviceId);
  const connectionVersion = async () => {
    const encrypted = await redis.get(credentialKey);
    if (!encrypted) throw new Error("Reconnect Swiggy before generating preferences.");
    return decryptJson(encrypted, `cravelens:swiggy:${deviceId}`).createdAt;
  };
  const connectionCreatedAt = await connectionVersion();
  const bucket = redisKeys.preferenceProfiles(deviceId);
  const field = sha256(addressId);
  const aad = `${bucket}:${field}`;
  const lockKey = `${aad}:lock`;
  const token = crypto.randomUUID();
  const read = async () => {
    const encrypted = await redis.hGet(bucket, field);
    if (!encrypted) return undefined;
    const parsed = profileSchema.safeParse(decryptJson(encrypted, aad));
    if (!parsed.success) return undefined;
    const profile = parsed.data;
    // Older empty profiles can represent rejected prose, rather than absent history.
    if (!profile.preferences && profile.history.checked > 0 && profile.history.incomplete) return undefined;
    const lifetime = profile.preferences ? profileLifetimeMs : emptyHistoryLifetimeMs;
    return profile.connectionCreatedAt === connectionCreatedAt && profile.addressId === addressId
      && Date.now() - profile.generatedAt < lifetime ? profile : undefined;
  };
  const result = (profile, generated) => ({
    personalContext: profile.preferences,
    personalContextSource: profile.preferences ? "inferred_history" : "none",
    preferenceProfile: { ...profile, connectionCreatedAt: undefined },
    preferenceHistoryRetrieved: generated,
  });
  let waiting = false;
  for (;;) {
    signal.throwIfAborted();
    const saved = await read();
    if (saved) return result(saved, false);
    if (await redis.set(lockKey, token, { NX: true, EX: 330 })) break;
    if (!waiting) { await progress("Waiting for your first preference profile…", "preferences"); waiting = true; }
    await pause(500, undefined, { signal });
  }
  try {
    const saved = await read();
    if (saved) return result(saved, false);
    await progress("Building your food preferences from verified order history…", "preferences");
    let draft;
    try { draft = await refinePreferences("", { mcp, chatModel, progress, signal, addressId }); }
    catch (error) {
      if (error?.code !== "PREFERENCES_HISTORY_UNVERIFIABLE") throw error;
      await progress("Swiggy history could not be verified; preparing your cart without inferred preferences…", "preferences");
      return { personalContext: "", personalContextSource: "none", preferenceHistoryRetrieved: false };
    }
    signal.throwIfAborted();
    if (await connectionVersion() !== connectionCreatedAt) throw new Error("Your Swiggy connection changed. Scan again to generate preferences for the current account.");
    const profile = profileSchema.parse({ ...draft, history: { ...draft.history, scope: "account" }, source: "inferred_history", addressId, connectionCreatedAt, generatedAt: Date.now() });
    // Empty history is recorded without fabricating preferences, and checked
    // again after a day. Positive profiles are refreshed after thirty days.
    await redis.hSet(bucket, field, encryptJson(profile, aad));
    await redis.expire(bucket, profileLifetimeMs / 1000);
    await progress(profile.preferences ? "Inferred preferences saved; preparing your cart…" : "No verified history found; preparing your cart without inferred preferences…", "preferences");
    return result(profile, true);
  } finally {
    await redis.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", { keys: [lockKey], arguments: [token] });
  }
}

export const ensureCartPreferences = tracedOperation("preferences.bootstrap", ensureCartPreferencesImpl, () => ({phase: "preference_bootstrap"}));
