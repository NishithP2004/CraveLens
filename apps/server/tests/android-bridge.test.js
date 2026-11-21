import { describe, expect, it } from "vitest";
import { CART_AGENT_RULE_MARKERS, InferenceProviderSchema, ModelSettingsSchema, OrchestrationProviderSchema, agentEventMessage, cartAgentSystemPrompt, localRequestCharacterBudget } from "@cravelens/shared";
import { effectiveContextTokens, selectAutoProvider } from "../src/model-provider.js";
import { cartToolPhase, localCartPhaseRequest } from "../src/swiggy-agent.js";
import { summarizeFoodOrder } from "../src/orders.js";
import { androidAppCheck } from "../src/app-check.js";

describe("Android inference provider selection", () => {
  it("keeps the extension on litert when that is the first ready provider", () => {
    expect(selectAutoProvider("auto", [])).toBe("litert");
    expect(selectAutoProvider("auto", [{ provider: "litert", ready: true }])).toBe("litert");
    expect(selectAutoProvider("litert", [{ provider: "aicore", ready: true }])).toBe("litert");
  });
  it("uses the first ready provider Android registers", () => {
    expect(selectAutoProvider("auto", [{ provider: "aicore", ready: true }, { provider: "litert", ready: true }])).toBe("aicore");
    expect(selectAutoProvider("auto", [{ provider: "aicore", ready: false }, { provider: "litert", ready: true }])).toBe("litert");
  });
  it("accepts aicore in the shared settings and inference enums", () => {
    expect(OrchestrationProviderSchema.parse("aicore")).toBe("aicore");
    expect(InferenceProviderSchema.parse("aicore")).toBe("aicore");
    expect(ModelSettingsSchema.parse({ orchestration: { provider: "aicore", model: "gemini-nano-4-fast" } }).orchestration.provider).toBe("aicore");
  });
  it("uses the smaller of the saved and registered context windows", () => {
    expect(effectiveContextTokens(16_384, 4_000)).toBe(4_000);
    expect(effectiveContextTokens(8_192, 32_768)).toBe(8_192);
    expect(effectiveContextTokens(16_384, undefined)).toBe(16_384);
  });
  it("derives the local character budget from the context window", () => {
    expect(localRequestCharacterBudget({ contextTokens: 16_384, maxTokens: 1_536 })).toBe(Math.round((16_384 - 1_536) * 3.2));
    expect(localRequestCharacterBudget({ contextTokens: 4_096, maxTokens: 1_536 })).toBe(Math.round((4_096 - 1_536) * 3.2));
  });
});

describe("compact cart prompt and small-context tools", () => {
  it("keeps every rule marker in both prompt variants", () => {
    const full = cartAgentSystemPrompt({ addressId: "addr_1", addressSummary: "Home" });
    const compact = cartAgentSystemPrompt({ addressId: "addr_1", addressSummary: "Home", compact: true });
    for (const marker of CART_AGENT_RULE_MARKERS) {
      expect(full).toContain(marker);
      expect(compact).toContain(marker);
    }
    expect(compact.length).toBeLessThan(full.length / 2);
  });
  it("narrows tools only for a small context and leaves the extension surface intact", () => {
    const request = { tools: [{ name: "get_food_orders" }, { name: "search_menu" }, { name: "update_food_cart" }, { name: "get_food_cart" }, { name: "fetch_food_coupons" }] };
    expect(localCartPhaseRequest(request, { menuSeen: true }, true).tools).toEqual(request.tools);
    const build = localCartPhaseRequest(request, { smallContext: true, menuSeen: true }, true);
    expect(build.tools.map((tool) => tool.name)).toEqual(["search_menu", "update_food_cart", "get_food_cart"]);
    expect(cartToolPhase({ smallContext: true })).toBe("search");
    expect(cartToolPhase({ cartUpdated: true, couponsChecked: false })).toBe("offers");
    const offers = localCartPhaseRequest(request, { smallContext: true, cartUpdated: true }, true);
    expect(offers.tools.map((tool) => tool.name)).toEqual(["get_food_cart", "fetch_food_coupons"]);
  });
});

describe("order history projection", () => {
  it("drops address and payment fields and marks CraveLens orders explicitly", () => {
    const summary = summarizeFoodOrder({
      orderId: "ord_1",
      restaurantName: "Meghana",
      order_items: [{ name: "Biryani", quantity: 2 }],
      order_total: 420,
      status: "Delivered",
      order_time: "2026-11-01T12:00:00",
      deliveryAddress: "12 Secret Road",
      phone: "9999999999",
      payment: { upi: "secret" },
    }, true);
    expect(summary).toMatchObject({ orderId: "ord_1", restaurant: "Meghana", total: 420, viaCraveLens: true, status: "Delivered" });
    expect(JSON.stringify(summary)).not.toMatch(/Secret Road|9999999999|secret/i);
  });
});

describe("optional Android App Check gate", () => {
  it("does not block requests when enforcement is off", () => {
    const previous = process.env.APP_CHECK_ENFORCE_ANDROID;
    delete process.env.APP_CHECK_ENFORCE_ANDROID;
    let called = false;
    androidAppCheck({ get: () => "android" }, {}, () => { called = true; });
    expect(called).toBe(true);
    if (previous === undefined) delete process.env.APP_CHECK_ENFORCE_ANDROID;
    else process.env.APP_CHECK_ENFORCE_ANDROID = previous;
  });
});

describe("agent event wording", () => {
  it("keeps the extension labels", () => {
    expect(agentEventMessage({ event: "tool_call", details: { tool: "update_food_cart" } })).toBe("Adding the best match to your cart");
    expect(agentEventMessage({ event: "cart_ready", details: { restaurant: "Meghana" } })).toBe("Cart ready from Meghana");
    expect(agentEventMessage({ event: "model:fallback-approved", details: { automatic: true, hostedProvider: "Google Gemini" } })).toBe("Automatically switched to a hosted model · continuing with Google Gemini");
  });
});
