import { expect, it } from "vitest";
import { completeLocalCartMutation, shouldRequestAgentFallback } from "../src/swiggy-agent.js";
import { compareCartItems } from "../src/cart-verification.js";

it("verifies a local mutation with read-only Swiggy calls before further inference", async () => {
  const state = { cartMutationAttempted: true, cartUpdated: false, verificationPending: true };
  const expectedItems = [{ menu_item_id: "item-1", quantity: 1 }];
  const calls = [];
  const result = await completeLocalCartMutation({ local: true, state, addressId: "selected", expectedItems, delaysMs: [], mcp: {
    async call(name, args) {
      calls.push({ name, args });
      return { cart: { items: [{ menu_item_id: "item-1", quantity: 1 }] } };
    },
  } });
  expect(result.cartVerified).toBe(true);
  expect(state).toMatchObject({ cartUpdated: true, verificationPending: false });
  expect(calls).toEqual([{ name: "get_food_cart", args: { addressId: "selected" } }]);
});

it("never marks an acknowledged mutation successful without matching cart contents", async () => {
  const state = { cartMutationAttempted: true, cartUpdated: false, verificationPending: true };
  await expect(completeLocalCartMutation({ local: true, state, addressId: "selected", expectedItems: [{ menu_item_id: "item-1", quantity: 1 }], delaysMs: [], mcp: {
    async call(name) { expect(name).toBe("get_food_cart"); return { cart: { items: [] } }; },
  } })).rejects.toMatchObject({ code: "INFERENCE_CART_UNVERIFIED" });
  expect(state.cartUpdated).toBe(false);
});

it("leaves hosted runs and unmutated local runs on their existing agent path", async () => {
  expect(await completeLocalCartMutation({ local: false, state: { verificationPending: true } })).toBeUndefined();
  expect(await completeLocalCartMutation({ local: true, state: { verificationPending: false } })).toBeUndefined();
});

it("distinguishes cart content mismatch from unsupported response structure", () => {
  const expected = [{ menu_item_id: "item-1", quantity: 2 }];
  expect(compareCartItems({ cart: { items: [{ menu_item_id: "item-1", quantity: 1 }] } }, expected)).toMatchObject({
    verified: false, reason: "item_or_quantity_mismatch", expected: [{ itemId: "item-1", quantity: 2 }], actual: [{ itemCount: 1, items: [{ itemId: "item-1", quantity: 1 }] }],
  });
  expect(compareCartItems({ cart: { lineItems: [] } }, expected)).toMatchObject({ verified: false, reason: "unrecognized_cart_shape", arrayPaths: ["cart.lineItems"] });
  const diagnostic = compareCartItems({ addressId: "private-address", payment: "private-payment", cart: { items: [] } }, expected);
  expect(JSON.stringify(diagnostic)).not.toContain("private-address");
  expect(JSON.stringify(diagnostic)).not.toContain("private-payment");
});

it("does not offer hosted inference to repair a cart state verification failure", () => {
  expect(shouldRequestAgentFallback({ code: "INFERENCE_CART_UNVERIFIED" })).toBe(false);
  expect(shouldRequestAgentFallback({ code: "INFERENCE_CANCELLED" })).toBe(false);
  expect(shouldRequestAgentFallback({ code: "INFERENCE_REPAIR_EXHAUSTED" })).toBe(true);
  expect(shouldRequestAgentFallback({ code: "INFERENCE_OFFLINE" })).toBe(true);
  expect(shouldRequestAgentFallback({ code: "INFERENCE_OFFLINE", fallbackRequested: true })).toBe(false);
});
