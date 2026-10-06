import { afterEach, beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ redis: null, refine: vi.fn() }));
vi.mock("../src/redis.js", async (original) => ({ ...await original(), getRedis: async () => boundary.redis }));
vi.mock("../src/preference-builder.js", () => ({ refinePreferences: boundary.refine }));
import { ensureCartPreferences } from "../src/preference-bootstrap.js";
import { config } from "../src/config.js";
import { encryptJson } from "../src/crypto-store.js";
import { redisKeys } from "../src/redis.js";
const originalKey = config.credentialEncryptionKey;
const history = { matched: 7, target: 7, checked: 7, excluded: 0, incomplete: false };
let hashes, strings, options;
beforeEach(async () => {
  config.credentialEncryptionKey = "ab".repeat(32);
  hashes = new Map(); strings = new Map(); boundary.refine.mockReset();
  boundary.redis = {
    get: async (key) => strings.get(key),
    set: async (key, value, config) => { if (config?.NX && strings.has(key)) return null; strings.set(key, value); return "OK"; },
    hGet: async (key, field) => hashes.get(`${key}:${field}`),
    hSet: async (key, field, value) => { hashes.set(`${key}:${field}`, value); },
    expire: vi.fn(async () => 1),
    eval: async (_, { keys, arguments: args }) => { if (strings.get(keys[0]) === args[0]) strings.delete(keys[0]); },
  };
  strings.set(redisKeys.swiggyCredential("owner"), encryptJson({ createdAt: 123 }, "cravelens:swiggy:owner"));
  boundary.refine.mockResolvedValue({ preferences: "Rice may suit me; this is tentative.", notes: "Seven verified orders.", history });
  options = { deviceId: "owner", addressId: "home", mcp: {}, chatModel: {}, progress: vi.fn(async () => {}) };
});
afterEach(() => { config.credentialEncryptionKey = originalKey; });
it("generates from empty context, encrypts the address-scoped profile and reuses it", async () => {
  const first = await ensureCartPreferences(options);
  expect(boundary.refine).toHaveBeenCalledWith("", expect.objectContaining({ addressId: "home", mcp: options.mcp, chatModel: options.chatModel }));
  expect(first).toMatchObject({ personalContextSource: "inferred_history", preferenceHistoryRetrieved: true, preferenceProfile: { addressId: "home", history } });
  expect([...hashes.values()].join()).not.toContain("Rice");
  const reused = await ensureCartPreferences(options);
  expect(reused.personalContext).toBe(first.personalContext);
  expect(reused.preferenceHistoryRetrieved).toBe(false);
  expect(boundary.refine).toHaveBeenCalledTimes(1);
});
it("never replaces explicit preferences or reads storage for them", async () => {
  boundary.redis = null;
  expect(await ensureCartPreferences({ ...options, personalContext: " Peanut allergy " })).toEqual({ personalContext: "Peanut allergy", personalContextSource: "explicit" });
  expect(boundary.refine).not.toHaveBeenCalled();
});
it("separates delivery addresses and account reconnections", async () => {
  await ensureCartPreferences(options);
  await ensureCartPreferences({ ...options, addressId: "work" });
  strings.set(redisKeys.swiggyCredential("owner"), encryptJson({ createdAt: 456 }, "cravelens:swiggy:owner"));
  await ensureCartPreferences(options);
  expect(boundary.refine).toHaveBeenCalledTimes(3);
});
it("records empty history without inventing a profile or repeating generation immediately", async () => {
  boundary.refine.mockResolvedValue({ preferences: "", notes: "No verified history.", history: { ...history, matched: 0, checked: 0 } });
  const result = await ensureCartPreferences(options);
  expect(result.personalContext).toBe("");
  expect(result.personalContextSource).toBe("none");
  await ensureCartPreferences(options);
  expect(boundary.refine).toHaveBeenCalledTimes(1);
});
it("fails before cart selection and releases the lock when history generation fails", async () => {
  boundary.refine.mockRejectedValueOnce(new Error("History unavailable"));
  await expect(ensureCartPreferences(options)).rejects.toThrow("History unavailable");
  expect(hashes.size).toBe(0);
  expect([...strings.keys()].some((key) => key.endsWith(":lock"))).toBe(false);
  await ensureCartPreferences(options);
  expect(boundary.refine).toHaveBeenCalledTimes(2);
});
it("does not save history generated for a disconnected or changed account", async () => {
  boundary.refine.mockImplementation(async () => { strings.delete(redisKeys.swiggyCredential("owner")); return { preferences: "Rice", notes: "", history }; });
  await expect(ensureCartPreferences(options)).rejects.toThrow("Reconnect Swiggy");
  expect(hashes.size).toBe(0);
});
it("refreshes an expired profile", async () => {
  const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    await ensureCartPreferences(options);
    clock.mockReturnValue(now + 31 * 24 * 60 * 60_000);
    await ensureCartPreferences(options);
    expect(boundary.refine).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});
it("shares a generation across simultaneous cart requests", async () => {
  let finish;
  boundary.refine.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const first = ensureCartPreferences(options);
  await vi.waitFor(() => expect(finish).toBeDefined());
  const second = ensureCartPreferences(options);
  finish({ preferences: "Rice", notes: "", history });
  const results = await Promise.all([first, second]);
  expect(results.map((result) => result.personalContext)).toEqual(["Rice", "Rice"]);
  expect(boundary.refine).toHaveBeenCalledTimes(1);
});

it("continues without inferred preferences on unverifiable history, without caching the failed attempt", async () => {
  boundary.refine.mockRejectedValue(Object.assign(new Error("No saved-address ID"), { code: "PREFERENCES_HISTORY_UNVERIFIABLE" }));
  expect(await ensureCartPreferences(options)).toEqual({ personalContext: "", personalContextSource: "none", preferenceHistoryRetrieved: false });
  expect(hashes.size).toBe(0);
  expect([...strings.keys()].some((key) => key.endsWith(":lock"))).toBe(false);
  await ensureCartPreferences(options);
  expect(boundary.refine).toHaveBeenCalledTimes(2);
});
