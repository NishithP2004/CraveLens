import { beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ customize: vi.fn() }));
vi.mock("../src/swiggy.js", () => ({ customizePersonalizedCart: boundary.customize }));
import { customizeCart } from "../src/cart-customization.js";
import { getThread, saveThread } from "../src/store.js";
let id;
beforeEach(async () => {
  boundary.customize.mockReset(); id = crypto.randomUUID();
  await saveThread({ deviceId: "owner", threadId: id, conversationId: "conversation", status: "awaiting_confirmation", suggestion: { expiresAt: new Date(Date.now()+60_000).toISOString(), item: "Rice", personalContext: "Vegetarian" } });
});
it("uses current cart and conversation and persists the refreshed receipt", async () => {
  boundary.customize.mockResolvedValue({ item: "Two portions", expiresAt: new Date(Date.now()+60_000).toISOString() });
  const result = await customizeCart("owner", id, { instruction: "Two portions" });
  expect(boundary.customize.mock.calls[0].slice(0, 4)).toEqual([expect.objectContaining({ item: "Rice", personalContext: "Vegetarian" }), "Two portions", "conversation", "owner"]);
  expect(result.suggestion.item).toBe("Two portions");
  expect((await getThread(id)).status).toBe("awaiting_confirmation");
});
it("rejects another owner and prevents concurrent customization/checkout", async () => {
  await expect(customizeCart("other", id, { instruction: "Change" })).rejects.toThrow("Cart not found");
  let complete;
  boundary.customize.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const first = customizeCart("owner", id, { instruction: "First" });
  await vi.waitFor(() => expect(complete).toBeDefined());
  await expect(customizeCart("owner", id, { instruction: "Second" })).rejects.toThrow("can no longer");
  complete({ item: "Updated" }); await first;
});
