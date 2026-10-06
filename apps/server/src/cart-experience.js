import crypto from "node:crypto";
import { getRedis } from "./redis.js";
import { getThread } from "./store.js";

export const experienceKey = (deviceId) => `cravelens:experience:${deviceId}`;
export async function getCartExperience(deviceId) {
  const redis = await getRedis();
  return JSON.parse(await redis.get(experienceKey(deviceId)) || '{"mode":"screen","silent":false}');
}
export async function saveCartExperience(deviceId, value) {
  if (!["screen", "nudge", "telegram"].includes(value?.mode)) throw Object.assign(new Error("Choose a valid cart experience"), { statusCode: 400 });
  const redis = await getRedis();
  if (value.mode === "telegram" && !await redis.get(`cravelens:telegram:link:${deviceId}`)) throw Object.assign(new Error("Connect and verify Telegram first"), { statusCode: 400 });
  const settings = { mode: value.mode, silent: value.silent === true };
  await redis.set(experienceKey(deviceId), JSON.stringify(settings));
  return settings;
}
export async function reserveBackgroundCart(deviceId) {
  const redis = await getRedis();
  const key = `cravelens:active-cart:${deviceId}`;
  const existing = await redis.get(key);
  if (existing) {
    const thread = await getThread(existing);
    if (!thread || ["placing_order", "customizing", "payment_pending", "payment_cancelling", "payment_paid", "confirming_payment", "payment_review_required", "placement_failed", "confirmation_failed"].includes(thread.status)
      || thread.status === "awaiting_confirmation" && Date.parse(thread.suggestion?.expiresAt) > Date.now()) return undefined;
    await redis.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", { keys: [key], arguments: [existing] });
  }
  const id = crypto.randomUUID();
  return await redis.set(key, id, { NX: true, EX: 3600 }) ? id : undefined;
}
export async function releaseBackgroundCart(deviceId, id) {
  const redis = await getRedis();
  await redis.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", { keys: [`cravelens:active-cart:${deviceId}`], arguments: [id] });
}

export async function pausedBackgroundCart(deviceId) {
  const id = await (await getRedis()).get(`cravelens:active-cart:${deviceId}`);
  const thread = id && await getThread(id);
  if (thread?.deviceId === deviceId && thread.status === "awaiting_confirmation"
      && thread.suggestion?.threadId === id && Date.parse(thread.suggestion.expiresAt) > Date.now()) {
    return { activeCart: { ...thread.suggestion, status: "ready" }, message: "A prepared cart is waiting for your review. Open it below, then review or reject it before preparing another." };
  }
  return { message: thread?.deviceId === deviceId && thread.status !== "awaiting_confirmation"
    ? "Another cart has an active update, checkout or payment. Check that cart and your Swiggy order/payment status before preparing another."
    : "Another cart is still being prepared. Try again after it finishes." };
}
