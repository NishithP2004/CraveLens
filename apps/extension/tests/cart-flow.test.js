import test from "node:test";
import assert from "node:assert/strict";
import { withCartProgress, cartPreparationNotice } from "../src/cart-flow.js";
test("still prepares a cart when the progress WebSocket cannot connect", async () => {
  let prepared = 0, closed = 0, warned = false;
  const result = await withCartProgress({ connect: async () => { throw new Error("WebSocket blocked"); }, disconnect: () => closed++, onUnavailable: () => { warned = true; }, prepare: async () => { prepared++; return { detected: true, suggestion: { threadId: "cart" } }; } });
  assert.equal(prepared, 1); assert.equal(warned, true); assert.ok(closed >= 1);
  assert.equal(cartPreparationNotice(result), undefined);
});
test("preserves HTTP failures and closes progress after failed preparation", async () => {
  let closed = false;
  await assert.rejects(withCartProgress({ connect: async () => {}, disconnect: () => { closed = true; }, prepare: async () => { throw new Error("Cart model failed"); } }), /Cart model failed/);
  assert.equal(closed, true);
});
test("provides a visible reason for paused or empty responses", () => {
  assert.match(cartPreparationNotice({ detected: false, paused: true }).message, /Another cart/);
  assert.equal(cartPreparationNotice({ detected: false }).title, "No cart prepared");
  assert.equal(cartPreparationNotice({ detected: true }).title, "No cart prepared");
});
test("shows the server's recovery message for an existing cart", () => {
  const notice = cartPreparationNotice({ paused: true, message: "Open the existing receipt", activeCart: { threadId: "existing" } });
  assert.equal(notice.message, "Open the existing receipt");
});
