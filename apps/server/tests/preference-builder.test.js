import { expect, it } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { collectAddressHistory, historyEvidence, preferenceFailure, refinePreferences } from "../src/preference-builder.js";
import { PreferenceRequestSchema } from "@cravelens/shared";
class CaptureModel extends BaseChatModel {
  constructor(content) { super({}); this.content = content; this.messages = []; }
  _llmType() { return "preferences-test-boundary"; }
  bindTools() { return this; }
  async _generate(messages) { this.messages = messages; return { generations: [{ text: this.content, message: new AIMessage(this.content) }] }; }
}
it("reads live history and bounded details before invoking the agent with original constraints", async () => {
  const calls = []; const progress = [];
  const mcp = {
    listTools: async () => [{ name: "get_food_orders", inputSchema: { type: "object", required: ["addressId"], properties: { addressId: { type: "string" }, activeOnly: { type: "boolean" } } } }, { name: "get_food_order_details", inputSchema: { properties: { orderId: { type: "string" } } } }, { name: "update_food_cart" }],
    call: async (name, args) => { calls.push({ name, args }); return name === "get_food_orders" ? { orders: Array.from({ length: 9 }, (_, n) => ({ order_id: `${n}` })) } : { order: { order_id: args.orderId, delivery_address: { id: "saved-home", lat: "private" }, items: [{ name: "Rice" }], phone: "private" } }; },
  };
  const model = new CaptureModel(JSON.stringify({ preferences: "Keep my peanut allergy. Rice may suit me.", notes: "Rice appears in recent history." }));
  const result = await refinePreferences("Peanut allergy", { mcp, chatModel: model, addressId: "saved-home", progress: async (step) => progress.push(step) });
  expect(calls).toHaveLength(8);
  expect(calls[0]).toEqual({ name: "get_food_orders", args: { addressId: "saved-home", activeOnly: false, orderCount: 15 } });
  expect(calls.every((call) => ["get_food_orders", "get_food_order_details"].includes(call.name))).toBe(true);
  expect(progress).toContain("Refining your preferences from the retrieved history…");
  expect(progress.at(-1)).toContain("Validating");
  expect(JSON.stringify(model.messages[0].content)).toContain("Preserve ALL explicit allergies");
  expect(JSON.stringify(model.messages.at(-1).content)).toContain("Peanut allergy");
  expect(JSON.stringify(model.messages.at(-1).content)).not.toContain("private");
  expect(result.preferences).toContain("peanut allergy");
});
it("does not fabricate history when history retrieval fails", async () => {
  const model = new CaptureModel("unused");
  await expect(refinePreferences("", { mcp: { listTools: async () => [{ name: "get_food_orders" }, { name: "get_food_order_details", inputSchema: { properties: { orderId: {} } } }], call: async () => { throw new Error("offline"); } }, chatModel: model, addressId: "saved-home", progress: async () => {} })).rejects.toThrow("offline");
  expect(model.messages).toHaveLength(0);
});
it("rejects malformed or oversized drafts rather than silently truncating user constraints", async () => {
  const dependencies = { addressId: "saved-home", mcp: { listTools: async () => [{ name: "get_food_orders" }, { name: "get_food_order_details", inputSchema: { properties: { orderId: {} } } }], call: async (name) => name === "get_food_orders" ? { orders: [{ orderId: "1" }] } : { order: { order_id: "1", delivery_address: { id: "saved-home" } } } }, progress: async () => {} };
  await expect(refinePreferences("Original", { ...dependencies, chatModel: new CaptureModel("not JSON") })).rejects.toThrow();
  await expect(refinePreferences("Original", { ...dependencies, chatModel: new CaptureModel(JSON.stringify({ preferences: "x".repeat(1001), notes: "" })) })).rejects.toThrow();
});
it("filters personal contact information and validates the request size", () => {
  expect(historyEvidence({ customer: { name: "Private" }, delivery_address: "Private", items: [{ name: "Rice" }] })).toEqual({ items: [{ name: "Rice" }] });
  expect(PreferenceRequestSchema.parse({ addressId: "saved-home" })).toEqual({ personalContext: "", addressId: "saved-home" });
  expect(() => PreferenceRequestSchema.parse({})).toThrow();
  expect(() => PreferenceRequestSchema.parse({ addressId: " " })).toThrow();
  expect(() => PreferenceRequestSchema.parse({ addressId: "saved-home", personalContext: "x".repeat(1001) })).toThrow();
});

it("rejects missing addresses before fetching history or invoking a model", async () => {
  const model = new CaptureModel("unused");
  let fetched = false;
  await expect(refinePreferences("Original", { mcp: { listTools: async () => { fetched = true; return []; } }, chatModel: model, progress: async () => {} })).rejects.toThrow("Select a delivery address");
  expect(fetched).toBe(false);
  expect(model.messages).toHaveLength(0);
});
it("reports actionable stage-specific failures without leaking upstream payloads", () => {
  expect(preferenceFailure(new Error("401 private-token"), "history")).toMatchObject({ code: "PREFERENCES_SWIGGY_AUTH" });
  expect(preferenceFailure(new Error("schema failure"), "history")).toMatchObject({ code: "PREFERENCES_HISTORY_FAILED" });
  expect(preferenceFailure(new SyntaxError("private history text"), "validation")).toMatchObject({ code: "PREFERENCES_INVALID_DRAFT" });
  expect(preferenceFailure(new Error("INFERENCE_OFFLINE"), "model")).toMatchObject({ code: "PREFERENCES_MODEL_FAILED" });
  expect(preferenceFailure(Object.assign(new Error("deadline"), { name: "TimeoutError" }), "model")).toMatchObject({ code: "PREFERENCES_TIMEOUT" });
  expect(JSON.stringify(preferenceFailure(new Error("private-token"), "history"))).not.toContain("private-token");
});

const historyDefinitions = (properties = {}) => [
  { name: "get_food_orders", inputSchema: { properties } },
  { name: "get_food_order_details", inputSchema: { properties: { orderId: { type: "string" } } } },
];
it("uses account orders across addresses and continues past failed details", async () => {
  const model = new CaptureModel(JSON.stringify({ preferences: "Rice is a tentative preference", notes: "Based on the supplied orders." }));
  const calls = [];
  const mcp = {
    listTools: async () => historyDefinitions(),
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === "get_food_orders") return { orders: Array.from({ length: 12 }, (_, n) => ({ orderId: String(n) })) };
      if (args.orderId === "2") throw new Error("details unavailable");
      return { data: { order: { order_id: args.orderId, delivery_address: args.orderId === "1" ? {} : { id: args.orderId === "0" ? "elsewhere" : "saved-home" }, order_items: [{ name: args.orderId === "0" ? "EXCLUDED_DISH" : `Rice ${args.orderId}` }] } } };
    },
  };
  const result = await refinePreferences("Original", { mcp, chatModel: model, addressId: "saved-home", progress: async () => {} });
  expect(result.history).toMatchObject({ matched: 7, checked: 8, excluded: 1, incomplete: true });
  const prompt = String(model.messages.at(-1).content);
  expect(prompt).toContain("EXCLUDED_DISH");
  expect(prompt).not.toContain("delivery_address");
  expect(prompt).toContain("Rice 3");
  expect(prompt).toContain("Rice 1");
  expect(prompt).toContain("Rice 7");
  expect(prompt).not.toContain("Rice 8");
  expect(result.notes).toContain("Delivery addresses were not checked");
});
it("uses advertised pagination, deduplicates orders and stops after seven matches", async () => {
  const calls = [];
  const definitions = historyDefinitions({ page: {}, orderCount: { maximum: 15 } });
  const mcp = { call: async (name, args) => {
    calls.push({ name, args });
    if (name === "get_food_orders") return { orders: (args.page === 1 ? [1, 2, 3, 4] : [4, 5, 6, 7, 8]).map((id) => ({ orderId: String(id) })), pagination: { hasMore: true } };
    return { order: { order_id: args.orderId, delivery_address: { id: "home" } } };
  } };
  const result = await collectAddressHistory(mcp, definitions, "home", async () => {});
  expect(result.history.matched).toBe(7);
  expect(calls.filter((c) => c.name === "get_food_orders").map((c) => c.args)).toEqual([{ addressId: "home", activeOnly: false, orderCount: 15, page: 1 }, { addressId: "home", activeOnly: false, orderCount: 15, page: 2 }]);
  expect(calls.filter((c) => c.name === "get_food_order_details")).toHaveLength(7);
});
it("preserves the original text without invoking a model when history is empty", async () => {
  const model = new CaptureModel("unused");
  const mcp = { listTools: async () => historyDefinitions(), call: async (name) => name === "get_food_orders" ? { orders: [] } : {} };
  const result = await refinePreferences("Keep exactly this", { mcp, chatModel: model, addressId: "home", progress: async () => {} });
  expect(result.preferences).toBe("Keep exactly this");
  expect(result.notes).toContain("No verified order history");
  expect(result.history.matched).toBe(0);
  expect(model.messages).toHaveLength(0);
});
it("does not invent unsupported pagination when fewer than seven orders are exposed", async () => {
  const calls = [];
  const mcp = { call: async (name, args) => { calls.push(args); return name === "get_food_orders" ? { orders: [{ orderId: "1" }], pagination: { hasMore: true } } : { order: { order_id: "1", delivery_address: { id: "home" } } }; } };
  const result = await collectAddressHistory(mcp, historyDefinitions(), "home", async () => {});
  expect(result.history).toMatchObject({ matched: 1, incomplete: true });
  expect(result.notes).toContain("1 of 7");
  expect(calls).toEqual([{ addressId: "home", activeOnly: false, orderCount: 15 }, { orderId: "1" }]);
});
it("rejects details for another order even when its address matches", async () => {
  const mcp = { call: async (name) => name === "get_food_orders" ? { orders: [{ orderId: "1" }] } : { order: { order_id: "2", delivery_address: { id: "home" } } } };
  const result = await collectAddressHistory(mcp, historyDefinitions(), "home", async () => {});
  expect(result.history.matched).toBe(0);
});
it("supports advertised cursors and stops repeated pages", async () => {
  const argsSeen = [];
  const mcp = { call: async (name, args) => {
    if (name === "get_food_orders") { argsSeen.push(args); return { orders: [{ orderId: "1" }], pagination: { nextCursor: "next" } }; }
    return { order: { order_id: "1", delivery_address: { id: "home" } } };
  } };
  const result = await collectAddressHistory(mcp, historyDefinitions({ cursor: {} }), "home", async () => {});
  expect(result.history.matched).toBe(1);
  expect(argsSeen).toEqual([{ addressId: "home", activeOnly: false, orderCount: 15 }, { addressId: "home", activeOnly: false, orderCount: 15, cursor: "next" }]);
});

it("bounds a long non-matching history scan and reports limited coverage", async () => {
  let details = 0;
  const mcp = { call: async (name, args) => {
    if (name === "get_food_orders") return { orders: Array.from({ length: 150 }, (_, i) => ({ orderId: String(i) })) };
    details++;
    return { order: { order_id: "wrong-order" } };
  } };
  const result = await collectAddressHistory(mcp, historyDefinitions(), "home", async () => {});
  expect(details).toBe(100);
  expect(result.history).toMatchObject({ matched: 0, checked: 100, incomplete: true });
});
it("propagates cancellation instead of treating it as an unavailable order", async () => {
  const controller = new AbortController();
  const mcp = { call: async (name) => {
    if (name === "get_food_orders") return { orders: [{ orderId: "1" }] };
    controller.abort(); throw controller.signal.reason;
  } };
  await expect(collectAddressHistory(mcp, historyDefinitions(), "home", async () => {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

it("rejects unsupported prose receipt formats without invoking the model", async () => {
  const model = new CaptureModel("unused");
  const mcp = { listTools: async () => historyDefinitions(), call: async (name) => name === "get_food_orders" ? { orders: [{ orderId: "1" }] } : "Order #1\nItems:\n- Rice\nDelivery address: Test address" };
  await expect(refinePreferences("Original", { mcp, chatModel: model, addressId: "home", progress: async () => {} })).rejects.toMatchObject({ code: "PREFERENCES_HISTORY_UNVERIFIABLE" });
  expect(model.messages).toHaveLength(0);
  expect(preferenceFailure({ code: "PREFERENCES_HISTORY_UNVERIFIABLE" }, "history_details").error).toContain("No preference suggestion was generated");
});
it("accepts fenced structured details with an exact order ID", async () => {
  const mcp = { call: async (name) => name === "get_food_orders" ? { orders: [{ orderId: "1" }] } : '```json\n{"order":{"order_id":"1","delivery_address":{"id":"home"},"order_items":[{"name":"Rice"}]}}\n```' };
  expect((await collectAddressHistory(mcp, historyDefinitions(), "home", async () => {})).history.matched).toBe(1);
});
it("does not treat an unsupported history response as no orders", async () => {
  await expect(collectAddressHistory({ call: async () => "Recent orders unavailable" }, historyDefinitions(), "home", async () => {})).rejects.toMatchObject({ code: "PREFERENCES_HISTORY_UNVERIFIABLE" });
});

it("uses Swiggy text receipts without address IDs and strips private receipt sections", async () => {
  const model = new CaptureModel(JSON.stringify({ preferences: "Rice may suit me.", notes: "Tentative rice preference." }));
  const detail = 'Order 123 — Test Restaurant (r/r ID)\nDelivered | Food\nPlaced: 2026-10-01 12:30:00\n\nItems (1):\n  - Rice — ₹150.00 | Vegetarian [Image: https://example.com/private-image]\n\nDelivery address: PRIVATE_ADDRESS (PRIVATE_NAME / PRIVATE_PHONE)\n\nTotal paid: ₹150\nPayment: PRIVATE_PAYMENT\nReorderable: yes';
  const mcp = { listTools: async () => historyDefinitions(), call: async (name) => name === "get_food_orders" ? { orders: [{ orderId: "123" }] } : detail };
  const result = await refinePreferences("", { mcp, chatModel: model, addressId: "home", progress: async () => {} });
  expect(result.history).toMatchObject({ matched: 1, scope: "account", unverifiable: 0 });
  const prompt = String(model.messages.at(-1).content);
  expect(prompt).toContain("Rice"); expect(prompt).toContain("2026-10-01 12:30:00");
  expect(prompt).not.toContain("PRIVATE_"); expect(prompt).not.toContain("private-image");
  expect(result.notes).toContain("may include other addresses");
  const mismatched = { ...mcp, call: async (name) => name === "get_food_orders" ? { orders: [{ orderId: "12" }] } : detail };
  await expect(refinePreferences("", { mcp: mismatched, chatModel: model, addressId: "home", progress: async () => {} })).rejects.toMatchObject({ code: "PREFERENCES_HISTORY_UNVERIFIABLE" });
});
