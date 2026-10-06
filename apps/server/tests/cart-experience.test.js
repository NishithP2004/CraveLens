import { beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ thread: null, id: "cart-1" }));
vi.mock("../src/redis.js", () => ({ getRedis: async () => ({ get: async () => boundary.id }) }));
vi.mock("../src/store.js", () => ({ getThread: async () => boundary.thread }));
import { pausedBackgroundCart } from "../src/cart-experience.js";
beforeEach(() => { boundary.id = "cart-1"; boundary.thread = { deviceId: "owner", status: "awaiting_confirmation", suggestion: { threadId: "cart-1", item: "Rice", expiresAt: new Date(Date.now() + 60000).toISOString() } }; });
it("returns an unexpired owned receipt for review without changing the cart", async () => {
  expect(await pausedBackgroundCart("owner")).toMatchObject({ activeCart: { threadId: "cart-1", item: "Rice", status: "ready" } });
});
it("does not disclose another device's receipt", async () => {
  expect((await pausedBackgroundCart("other")).activeCart).toBeUndefined();
});
it("does not revive expired, mismatched or payment-in-progress receipts", async () => {
  boundary.thread.suggestion.expiresAt = new Date(Date.now() - 1000).toISOString();
  expect((await pausedBackgroundCart("owner")).activeCart).toBeUndefined();
  boundary.thread.suggestion.expiresAt = new Date(Date.now() + 60000).toISOString();
  boundary.thread.suggestion.threadId = "wrong";
  expect((await pausedBackgroundCart("owner")).activeCart).toBeUndefined();
  boundary.thread.suggestion.threadId = "cart-1"; boundary.thread.status = "payment_pending";
  expect(await pausedBackgroundCart("owner")).toMatchObject({ message: expect.stringContaining("payment") });
  expect((await pausedBackgroundCart("owner")).activeCart).toBeUndefined();
});
it("identifies a build that has not saved its receipt yet", async () => {
  boundary.thread = null;
  expect(await pausedBackgroundCart("owner")).toMatchObject({ message: expect.stringContaining("still being prepared") });
});
