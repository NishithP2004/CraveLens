import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ values: new Map(), hashes: new Map(), sets: new Map() }));

vi.mock("./redis.js", () => ({
  redisKeys: {
    device: (id) => `device:${id}`, refresh: (id) => `refresh:${id}`, usedRefresh: (id) => `used:${id}`, refreshFamily: (id) => `family:${id}`,
  },
  getRedis: async () => ({
    set: async (key, value) => { state.values.set(key, value); return "OK"; },
    get: async (key) => state.values.get(key) ?? null,
    getDel: async (key) => { const value = state.values.get(key) ?? null; state.values.delete(key); return value; },
    del: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) { state.values.delete(key); state.sets.delete(key); } },
    hSet: async (key, values) => state.hashes.set(key, { ...(state.hashes.get(key) || {}), ...values }),
    sAdd: async (key, value) => { const values = state.sets.get(key) || new Set(); values.add(value); state.sets.set(key, values); },
    sRem: async (key, value) => state.sets.get(key)?.delete(value),
    sMembers: async (key) => [...(state.sets.get(key) || [])],
    expire: async () => true,
  }),
}));

import { config } from "./config.js";
import { authenticateDeviceToken, createDeviceSession, rotateDeviceSession } from "./device-auth.js";

describe("rotating device sessions", () => {
  beforeEach(() => {
    state.values.clear(); state.hashes.clear(); state.sets.clear();
    config.deviceSessionSigningKey = "test-signing-key-that-is-longer-than-thirty-two-characters";
  });

  it("stores refresh hashes, rotates once, and revokes the family on reuse", async () => {
    const first = await createDeviceSession();
    expect([...state.values.values()].join(" ")).not.toContain(first.refreshToken);
    expect(await authenticateDeviceToken(first.accessToken)).toBe(first.deviceId);

    const second = await rotateDeviceSession(first.refreshToken);
    expect(second.deviceId).toBe(first.deviceId);
    await expect(rotateDeviceSession(first.refreshToken)).rejects.toMatchObject({ code: "REFRESH_REUSE", statusCode: 401 });
    await expect(rotateDeviceSession(second.refreshToken)).rejects.toMatchObject({ code: "REFRESH_REUSE", statusCode: 401 });
  });
});
