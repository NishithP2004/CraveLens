import { describe, expect, it } from "vitest";
import { SystemMessage } from "@langchain/core/messages";
import { AgentFollowUpSchema, CartCustomizationSchema, CartMutationSchema, CouponSelectionSchema, FoodVerificationSchema, OrchestrateRequestSchema } from "@cravelens/shared";
import { isSuggestionExpired, orchestrationFlightKey, runSingleFlight } from "./app.js";
import { appendSystemInstruction, createSearchBudgetGuard, invokeModelWithToolChoiceRetry, isToolChoiceMismatchError, isTransientModelError, normalizeAgentFollowUpPayload, normalizeToolSchema, replaceSystemInstruction, shouldFinalizeCartAgent, splitAgentResponse } from "./swiggy-agent.js";
import { unwrap } from "./swiggy-mcp.js";
import { claimThreadStatus, getThread, saveThread } from "./store.js";
import { cartReflectsItems, configuredMenuItemPayload, currentTemporalContext, normalizeAddress, normalizeCartReceipt, normalizeFoodCoupons, normalizeMenuCatalog, normalizeMenuOptionGroups, normalizePaymentOptions, normalizePaymentStatus, normalizePendingPayment, reconcileCouponRationale, resolveAppliedCouponDiscount, resolveCouponCode, resolveDeliveryEta, resolveDietaryType, resolveItemDescription, resolveItemImage, resolveProductRating, resolveRestaurantLocation, resolveRestaurantLogo, resolveRestaurantName, resolveRestaurantNameWithRetry, resolveRestaurantRating } from "./swiggy.js";

describe("CraveLens contracts", () => {
  it("accepts a verified dish with a detailed visual description", () => expect(FoodVerificationSchema.parse({
    isFood: true,
    dish: "Miso chicken ramen",
    description: "A bowl of wheat noodles in a pale miso broth, topped with sliced chicken, sweetcorn, scallions, and sesame.",
    cuisine: "Japanese",
    ingredients: ["noodles", "miso broth", "chicken", "sweetcorn", "scallions"],
    confidence: .9,
    context: "ready_to_eat",
  })).toMatchObject({
    dish: "Miso chicken ramen",
    description: expect.stringContaining("pale miso broth"),
  }));
  it("treats expired or missing cart expiries as unorderable", () => {
    expect(isSuggestionExpired({ expiresAt: "2026-07-09T12:00:00.000Z" }, Date.parse("2026-07-09T12:00:00.001Z"))).toBe(true);
    expect(isSuggestionExpired({ expiresAt: "2026-07-09T12:10:00.000Z" }, Date.parse("2026-07-09T12:00:00.000Z"))).toBe(false);
    expect(isSuggestionExpired({})).toBe(true);
  });
  it("accepts an orchestration request verified on-device", () => expect(OrchestrateRequestSchema.parse({ videoId: "198AWISrLgl", timestamp: 76, triggerConfidence: .8, verification: { isFood: true, dish: "ramen", cuisine: "Japanese", ingredients: ["noodles"], confidence: .91, context: "ready_to_eat" }, videoTitle: "Ramen", location: "Home" }).verification.dish).toBe("ramen"));
  it("coalesces concurrent cart builds for the same user, video, and normalized dish", async () => {
    const flights = new Map();
    let operations = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const operation = async () => {
      operations += 1;
      await gate;
      return { detected: true, suggestion: { threadId: "thread-1" } };
    };
    const input = { videoId: "video-1", addressId: "home", verification: { dish: "Miso Chicken Ramen" } };
    const key = orchestrationFlightKey(input, "session-1");
    expect(key).toBe(orchestrationFlightKey({ ...input, verification: { dish: "  miso-chicken RAMEN " } }, "session-1"));

    const first = runSingleFlight(flights, key, operation, { retainMs: 0 });
    const second = runSingleFlight(flights, key, operation, { retainMs: 0 });
    expect(first.joined).toBe(false);
    expect(second.joined).toBe(true);
    release();
    const [firstResult, secondResult] = await Promise.all([first.promise, second.promise]);

    expect(operations).toBe(1);
    expect(secondResult).toBe(firstResult);
    expect(flights.size).toBe(0);
  });
  it("briefly reuses successful builds but releases failed builds for retry", async () => {
    const retainedFlights = new Map();
    let successfulOperations = 0;
    const first = runSingleFlight(retainedFlights, "same", async () => {
      successfulOperations += 1;
      return { suggestion: { threadId: "thread-1" } };
    }, { retainMs: 1_000 });
    const firstResult = await first.promise;
    const duplicate = runSingleFlight(retainedFlights, "same", async () => {
      successfulOperations += 1;
      return { suggestion: { threadId: "thread-2" } };
    }, { retainMs: 1_000 });
    expect(duplicate.joined).toBe(true);
    expect(await duplicate.promise).toBe(firstResult);
    expect(successfulOperations).toBe(1);

    const failedFlights = new Map();
    const failed = runSingleFlight(failedFlights, "retryable", async () => {
      throw new Error("temporary failure");
    });
    await expect(failed.promise).rejects.toThrow("temporary failure");
    expect(failedFlights.size).toBe(0);
    expect(runSingleFlight(failedFlights, "retryable", async () => "retried").joined).toBe(false);
  });
  it("accepts personal context and supplies a default when omitted", () => {
    const base = { videoId: "198AWISrLgl", timestamp: 76, triggerConfidence: .8, verification: { isFood: true, dish: "ramen", cuisine: "Japanese", ingredients: [], confidence: .9, context: "ready_to_eat" } };
    expect(OrchestrateRequestSchema.parse(base).personalContext).toBe("");
    expect(OrchestrateRequestSchema.parse({ ...base, personalContext: "Non-veg except Thursdays", timeZone: "Asia/Kolkata" })).toMatchObject({
      personalContext: "Non-veg except Thursdays", timeZone: "Asia/Kolkata",
    });
  });
  it("accepts legacy requests containing a full delivery address", () => expect(OrchestrateRequestSchema.parse({ videoId: "198AWISrLgl", timestamp: 76, triggerConfidence: .8, verification: { isFood: true, dish: "ramen", cuisine: "Japanese", ingredients: [], confidence: .9, context: "ready_to_eat" }, location: "Nishith P: ".padEnd(400, "A") }).location.length).toBe(400));
  it("accepts a bounded cart customization instruction", () => {
    expect(CartCustomizationSchema.parse({ instruction: "Make it vegetarian and add a Coke" }).instruction).toBe("Make it vegetarian and add a Coke");
    expect(() => CartCustomizationSchema.parse({ instruction: " " })).toThrow();
    expect(() => CartCustomizationSchema.parse({ instruction: "x".repeat(501) })).toThrow();
  });
  it("validates schema-driven agent follow-up forms", () => {
    expect(AgentFollowUpSchema.parse({
      version: 1,
      title: "Choose a size",
      fields: [{ id: "size", type: "radio", label: "Which size?", options: [{ value: "regular", label: "Regular" }] }],
    })).toMatchObject({ version: 1, submitLabel: "Continue", fields: [{ id: "size", required: true }] });
    expect(() => AgentFollowUpSchema.parse({
      version: 1,
      title: "Choose a size",
      fields: [{ id: "size", type: "radio", label: "Which size?" }],
    })).toThrow();
  });
  it("converts standard JSON Schema follow-ups into renderable version-1 controls", () => {
    expect(normalizeAgentFollowUpPayload({
      type: "object",
      title: "Add-ons (optional)",
      properties: {
        beverage_addon: {
          type: "string",
          title: "Choose a beverage to add with your bread (optional)",
          enum: [
            "Classic Lemonade [300ml] (₹90)",
            "Valencia Orange Juice [200ml] (₹180)",
            "Hot Chocolate [250ml] (₹195)",
            "Latte [250ml] (₹155)",
            "Cappuccino [250ml] (₹155)",
            "Mango & Pineapple Juice (200ml) (₹180)",
            "Lemon Iced Tea [300 ml] (₹104)",
            "Peach Iced Tea [300 ml] (₹104)",
            "None",
          ],
          default: "None",
        },
      },
      required: [],
    })).toMatchObject({
      version: 1,
      title: "Add-ons (optional)",
      fields: [{
        id: "beverage_addon",
        type: "select",
        label: "Choose a beverage to add with your bread (optional)",
        required: false,
        defaultValue: "None",
        options: expect.arrayContaining([
          { value: "Classic Lemonade [300ml] (₹90)", label: "Classic Lemonade [300ml] (₹90)" },
          { value: "Peach Iced Tea [300 ml] (₹104)", label: "Peach Iced Tea [300 ml] (₹104)" },
          { value: "None", label: "None" },
        ]),
      }],
    });
    expect(splitAgentResponse(`CART_RATIONALE:
The bread requires an optional add-on choice.
HUMAN_INPUT_UI:
{"type":"object","title":"Add-ons (optional)","properties":{"beverage_addon":{"type":"string","title":"Choose a beverage","enum":["Lemonade","Coffee","Tea","Juice","None"]}},"required":[]}`)).toMatchObject({
      agentPrompt: "",
      agentFollowUp: {
        version: 1,
        title: "Add-ons (optional)",
        fields: [{ id: "beverage_addon", type: "select", required: false }],
      },
    });
  });
  it("accepts deterministic cart edits and coupon overrides", () => {
    expect(CartMutationSchema.parse({ action: "set_quantity", itemId: "dish-1", quantity: 3 })).toEqual({
      action: "set_quantity", itemId: "dish-1", quantity: 3, confirmSameCustomizations: false,
    });
    expect(CartMutationSchema.parse({ action: "add_item", itemId: "dish-2" })).toEqual({ action: "add_item", itemId: "dish-2" });
    expect(CartMutationSchema.parse({ action: "add_item", itemId: "dish-2", itemName: "Miso Ramen" })).toEqual({
      action: "add_item", itemId: "dish-2", itemName: "Miso Ramen",
    });
    expect(CartMutationSchema.parse({
      action: "add_item", itemId: "dish-2", itemName: "Miso Ramen",
      selections: [{ kind: "variant", format: "variantsV2", groupId: "size", choiceId: "large" }],
    }).selections).toHaveLength(1);
    expect(CouponSelectionSchema.parse({ couponCode: " TRYNEW " })).toEqual({ couponCode: "TRYNEW" });
    expect(() => CartMutationSchema.parse({ action: "set_quantity", itemId: "dish-1", quantity: 21 })).toThrow();
  });
  it("stops the cart agent after final verification or its bounded model budget", () => {
    expect(shouldFinalizeCartAgent({
      modelCallCount: 4, cartUpdated: true, couponsChecked: true, verificationPending: false,
    })).toBe(true);
    expect(shouldFinalizeCartAgent({
      modelCallCount: 4, cartUpdated: true, couponsChecked: true, verificationPending: true,
    })).toBe(false);
    expect(shouldFinalizeCartAgent({ modelCallCount: 12 })).toBe(false);
    expect(shouldFinalizeCartAgent({ modelCallCount: 16 })).toBe(true);
  });
  it("retries Groq tool-choice mismatch generations without retrying permanent errors", async () => {
    const mismatch = new Error('400 litellm.BadRequestError: GroqException - {"error":{"message":"Tool choice is none, but model called a tool","code":"tool_use_failed"}}');
    expect(isToolChoiceMismatchError(mismatch)).toBe(true);
    expect(isToolChoiceMismatchError(new Error("401 invalid API key"))).toBe(false);

    let attempts = 0;
    const retries = [];
    const result = await invokeModelWithToolChoiceRetry(
      { systemPrompt: "Finalize the cart.", tools: [] },
      async (request) => {
        attempts += 1;
        if (attempts < 3) throw mismatch;
        expect(request.systemPrompt).toContain("Retry now without calling or naming a tool");
        return { content: "CART_RATIONALE:\nReady\nHUMAN_INPUT_UI:\nNONE" };
      },
      { onRetry: ({ attempt }) => retries.push(attempt) },
    );
    expect(result.content).toContain("Ready");
    expect(attempts).toBe(3);
    expect(retries).toEqual([1, 2]);

    let unrelatedAttempts = 0;
    await expect(invokeModelWithToolChoiceRetry({}, async () => {
      unrelatedAttempts += 1;
      throw new Error("401 invalid API key");
    })).rejects.toThrow("401 invalid API key");
    expect(unrelatedAttempts).toBe(1);
  });
  it("retries wrapped transient provider failures with bounded backoff", async () => {
    const providerError = Object.assign(new Error("Service Unavailable, the authentication database is temporarily unreachable."), {
      status: 503,
      code: "503",
      type: "no_db_connection",
    });
    const wrapped = Object.assign(new Error("MiddlewareError"), { cause: providerError });
    expect(isTransientModelError(wrapped)).toBe(true);
    expect(isTransientModelError(new Error("401 invalid API key"))).toBe(false);

    let attempts = 0;
    const delays = [];
    const retries = [];
    const result = await invokeModelWithToolChoiceRetry(
      { systemPrompt: "Build a cart." },
      async () => {
        attempts += 1;
        if (attempts < 3) throw wrapped;
        return { content: "Recovered" };
      },
      {
        sleep: async (delayMs) => delays.push(delayMs),
        onRetry: ({ attempt, reason, delayMs }) => retries.push({ attempt, reason, delayMs }),
      },
    );
    expect(result.content).toBe("Recovered");
    expect(attempts).toBe(3);
    expect(delays).toEqual([500, 1500]);
    expect(retries).toEqual([
      { attempt: 1, reason: "transient_model_error", delayMs: 500 },
      { attempt: 2, reason: "transient_model_error", delayMs: 1500 },
    ]);
  });
  it("changes only LangChain systemMessage across consecutive retry instructions", () => {
    const initialMessage = new SystemMessage("Base prompt");
    const finalized = appendSystemInstruction({
      systemPrompt: initialMessage.text,
      systemMessage: initialMessage,
    }, "Finalize without tools.");
    expect(finalized.systemPrompt).toBe("Base prompt");
    expect(finalized.systemMessage.text).toContain("Finalize without tools.");

    const retried = appendSystemInstruction(finalized, "Retry with final text only.");
    expect(retried.systemPrompt).toBe(finalized.systemMessage.text);
    expect(retried.systemMessage.text).toContain("Retry with final text only.");
    expect(retried.systemPrompt).not.toBe(retried.systemMessage.text);
  });
  it("replaces the tool-oriented system message without changing both LangChain fields", () => {
    const initialMessage = new SystemMessage("Use tools to build a cart.");
    const finalized = replaceSystemInstruction({
      systemPrompt: initialMessage.text,
      systemMessage: initialMessage,
    }, "Tools are disabled. Return final text.");
    expect(finalized.systemPrompt).toBe(initialMessage.text);
    expect(finalized.systemMessage.text).toBe("Tools are disabled. Return final text.");
  });
  it("deduplicates scoped searches and enforces per-tool budgets", () => {
    const guard = createSearchBudgetGuard({ search_menu: 2 });
    expect(guard.check("search_menu", { query: " Wasabi  Bowl ", restaurantIdOfAddedItem: "r1" })).toMatchObject({
      allowed: true, remaining: 1,
    });
    expect(guard.check("search_menu", { query: "wasabi bowl", restaurantIdOfAddedItem: "r1" })).toMatchObject({
      allowed: false, reason: "DUPLICATE_SEARCH", remaining: 1,
    });
    expect(guard.check("search_menu", { query: "Japanese rice bowl", restaurantIdOfAddedItem: "r1" })).toMatchObject({
      allowed: true, remaining: 0,
    });
    expect(guard.check("search_menu", { query: "sushi rice", restaurantIdOfAddedItem: "r1" })).toMatchObject({
      allowed: false, reason: "SEARCH_BUDGET_EXHAUSTED", remaining: 0,
    });
    expect(guard.check("get_food_cart", {})).toMatchObject({ allowed: true });
  });
  it("verifies added cart lines across wrapped Swiggy response shapes", () => {
    const expected = [{ itemId: "dish-1", quantity: 1 }, { itemId: "dish-2", quantity: 1 }];
    expect(cartReflectsItems({
      widgets: { items: [{ id: "unrelated-menu-item", quantity: 1 }] },
      data: { cart: { cartItems: [{ info: { id: "dish-1" }, quantity: 1 }, { item: { id: "dish-2" }, qty: "1" }] } },
    }, expected)).toBe(true);
    expect(cartReflectsItems({
      cart: { items: [{ id: "dish-1", quantity: 1 }] },
    }, expected)).toBe(false);
  });
  it("aggregates repeated item IDs when verifying configured cart lines", () => {
    expect(cartReflectsItems({
      orderItems: [{ itemId: "dish-1", quantity: 2 }],
    }, [{ itemId: "dish-1", quantity: 1 }, { itemId: "dish-1", quantity: 1 }])).toBe(true);
  });
  it("rejects invalid video ids", () => expect(() => OrchestrateRequestSchema.parse({ videoId: "?", timestamp: 0, triggerConfidence: .8, keyframeDataUrl: "data:image/jpeg;base64,x", videoTitle: "x", location: "x" })).toThrow());
  it("normalizes MCP unions for Gemini function calling", () => {
    const schema = normalizeToolSchema({ type: "object", properties: { choice: { anyOf: [{ type: "object", properties: { variants: { type: "array", items: { type: ["string", "null"] } } } }, { type: "object", properties: { variantsV2: { type: "array", items: { type: "string" } } } }] } } });
    expect(schema.properties.choice.anyOf).toBeUndefined();
    expect(schema.properties.choice.properties).toHaveProperty("variants");
    expect(schema.properties.choice.properties).toHaveProperty("variantsV2");
    expect(schema.properties.choice.properties.variants.items.type).toBe("string");
  });
  it("normalizes numeric MCP enums for Gemini function calling", () => {
    const schema = normalizeToolSchema({ type: "object", properties: { vegFilter: { type: "number", enum: [0, 1] } } });
    expect(schema.properties.vegFilter).toMatchObject({ type: "integer", minimum: 0, maximum: 1 });
    expect(schema.properties.vegFilter.enum).toBeUndefined();
  });
  it("keeps human-in-the-loop questions out of the cart rationale", () => {
    expect(splitAgentResponse(`CART_RATIONALE:
The current restaurant has no drinks, so the verified food cart was kept unchanged.
HUMAN_INPUT_REQUIRED:
Would you like me to:
1. Switch restaurants
2. Keep this cart`)).toEqual({
      rationale: "The current restaurant has no drinks, so the verified food cart was kept unchanged.",
      agentPrompt: "Would you like me to:\n1. Switch restaurants\n2. Keep this cart",
      agentFollowUp: undefined,
    });
    expect(splitAgentResponse("CART_RATIONALE:\nVerified the best nearby option.\nHUMAN_INPUT_REQUIRED:\nNONE")).toEqual({
      rationale: "Verified the best nearby option.",
      agentPrompt: "",
      agentFollowUp: undefined,
    });
    expect(splitAgentResponse(`CART_RATIONALE:
Verified the best nearby option.
HUMAN_INPUT_UI:
NONE
{"version":1,"title":"Choose an option","fields":[{"id":"choice","type":"radio","label":"Which?","options":[{"value":"a","label":"A"}]}]}`)).toEqual({
      rationale: "Verified the best nearby option.",
      agentPrompt: "",
      agentFollowUp: undefined,
    });
    expect(splitAgentResponse("The menu has no drinks.\n\nWould you like me to switch restaurants?")).toEqual({
      rationale: "The menu has no drinks.",
      agentPrompt: "Would you like me to switch restaurants?",
      agentFollowUp: undefined,
    });
    expect(splitAgentResponse(`CART_RATIONALE:
The restaurant needs a size before the item can be added.
HUMAN_INPUT_UI:
{"version":1,"title":"Choose a size","fields":[{"id":"size","type":"radio","label":"Which size?","required":true,"options":[{"value":"regular","label":"Regular"},{"value":"large","label":"Large"}]}],"submitLabel":"Add choice"}`)).toMatchObject({
      rationale: "The restaurant needs a size before the item can be added.",
      agentPrompt: "",
      agentFollowUp: {
        version: 1,
        title: "Choose a size",
        fields: [{ id: "size", type: "radio", options: [{ value: "regular" }, { value: "large" }] }],
      },
    });
  });
  it("normalizes a detailed Swiggy receipt", () => {
    const receipt = normalizeCartReceipt({ cart: { items: [{ id: "ramen-1", name: "Ramen", description: "Miso broth with noodles", isVeg: 1, cloudinaryImageId: "items/ramen", quantity: 2, price: 180, totalPrice: 360, ratings: { aggregatedRating: { rating: "4.3", ratingCount: "128 ratings" } } }], billDetails: [{ label: "Delivery fee", amount: 30 }] }, itemTotal: 360, couponDiscount: 50, totalPayable: 340 });
    expect(receipt).toMatchObject({ subtotal: 360, discount: 50, finalAmount: 340 });
    expect(receipt.items[0]).toMatchObject({ id: "ramen-1", name: "Ramen", description: "Miso broth with noodles", dietaryType: "veg", rating: 4.3, ratingCount: 128, quantity: 2, total: 360 });
    expect(receipt.items[0].imageUrl).toContain("items/ramen");
    expect(receipt.charges[0]).toEqual({ label: "Delivery fee", amount: 30 });
  });
  it("uses discounted item prices and the agent-verified payable total", () => {
    const receipt = normalizeCartReceipt({ items: [{ name: "Shoyu Ramen", quantity: 1, price: 480, discountedPrice: 399 }] }, 447);
    expect(receipt).toMatchObject({ subtotal: 480, discount: 81, finalAmount: 447 });
    expect(receipt.items[0]).toMatchObject({ total: 399, originalTotal: 480, savings: 81 });
    expect(receipt.charges).toContainEqual({ label: "Taxes & charges", amount: 48 });
  });
  it("does not mistake an item total for the cart payable total", () => {
    const receipt = normalizeCartReceipt({
      items: [{ name: "Salmon Sushi", quantity: 1, price: 485, total: 485 }],
      couponDiscount: 75,
      billDetails: [
        { label: "Taxes & charges", amount: 59.83 },
        { label: "Taxes & charges", amount: 15.17 },
      ],
    }, 470);
    expect(receipt).toMatchObject({ subtotal: 485, discount: 75, finalAmount: 470 });
    expect(receipt.charges).toEqual([{ label: "Taxes & charges", amount: 60 }]);
    expect(receipt.subtotal + receipt.charges.reduce((sum, charge) => sum + charge.amount, 0) - receipt.discount).toBe(receipt.finalAmount);
  });
  it("explains a lower Swiggy payable total when no discount field is returned", () => {
    const receipt = normalizeCartReceipt({
      items: [{ id: "99703873", name: "Japanese Glazed Chicken Rice Bowl", quantity: 1, total: 358 }],
      itemTotal: 358,
      totalPayable: 299,
    });
    expect(receipt).toMatchObject({
      subtotal: 358,
      discount: 59,
      finalAmount: 299,
      discounts: [{ label: "Swiggy savings", amount: 59, source: "payable_reconciliation" }],
    });
    expect(receipt.subtotal + receipt.charges.reduce((sum, charge) => sum + charge.amount, 0) - receipt.discount).toBe(receipt.finalAmount);
  });
  it("reads the restaurant name from nested Swiggy cart metadata", () => {
    expect(resolveRestaurantName({ cart: { restaurantDetails: { name: "Kokoro Ramen By Nasi and Mee" } } }, {})).toBe("Kokoro Ramen By Nasi and Mee");
    expect(resolveRestaurantName({}, {}, "Restaurant choice: Seoul Bowl was open and nearby.")).toBe("Seoul Bowl");
    expect(resolveRestaurantName({}, {}, "", "Daily Sushi")).toBe("Daily Sushi");
    expect(resolveRestaurantName({ restaurantName: "Swiggy Restaurant" }, {}, "", "Daily Sushi")).toBe("Daily Sushi");
    expect(resolveRestaurantName({
      restaurantName: "Bowl Soul, such as the Japanese Glazed Chicken Rice Bowl and Japanese Glazed Chicken Noodles, both of which can be customized with add-ons. To proceed, please select one of the available alternatives.",
    }, {}, "", "Daily Sushi")).toBe("Daily Sushi");
    expect(resolveRestaurantName({
      restaurantName: "Your existing cart already contains an item from a different restaurant. Which option would you prefer?",
    }, {})).toBe("");
    expect(resolveRestaurantName({}, {})).toBe("");
  });
  it("retries incomplete read-only restaurant metadata responses", async () => {
    const attempts = [];
    const name = await resolveRestaurantNameWithRetry(async (attempt) => {
      attempts.push(attempt);
      if (attempt === 0) return [{ cart: { items: [{ id: "dish-1" }] } }, {}, "", ""];
      if (attempt === 1) throw new Error("temporary menu metadata failure");
      return [{ cart: { restaurantDetails: { name: "Bowl Soul" } } }, {}, "", ""];
    });
    expect(name).toBe("Bowl Soul");
    expect(attempts).toEqual([0, 1, 2]);
  });
  it("normalizes product images and delivery ETA when Swiggy provides them", () => {
    expect(resolveItemImage({ cloudinaryImageId: "items/salmon-sushi" })).toContain("items/salmon-sushi");
    expect(resolveItemImage({ imageUrl: "https://example.com/sushi.jpg" })).toBe("https://example.com/sushi.jpg");
    expect(resolveDeliveryEta({ cart: { sla: { slaString: "25-30 mins" } } })).toBe("25-30 mins");
    expect(resolveDeliveryEta({ deliveryTimeInMinutes: 32 })).toBe("32 min");
  });
  it("normalizes restaurant identity metadata from Swiggy menu cards", () => {
    const menu = { data: { cards: [{ card: { card: { info: {
      id: "kimchi-co",
      name: "Kimchi & Co",
      cloudinaryImageId: "restaurant/kimchi-co-logo",
      avgRating: "4.2",
      totalRatings: "1.3K+ ratings",
      areaName: "Central Bangalore",
      sla: { slaString: "45-50 mins" },
    } } } }] } };
    expect(resolveRestaurantLogo(menu)).toContain("restaurant/kimchi-co-logo");
    expect(resolveRestaurantLogo({ restaurantInfo: { imageId: "restaurant/kimchi-co-cover" } })).toContain("restaurant/kimchi-co-cover");
    expect(resolveRestaurantLogo({ restaurant: { logoUrl: "//media-assets.swiggy.com/kimchi-logo.png" } })).toBe("https://media-assets.swiggy.com/kimchi-logo.png");
    expect(resolveRestaurantRating(menu)).toEqual({ value: 4.2, count: 1300 });
    expect(resolveRestaurantLocation(menu)).toBe("Central Bangalore");
    expect(resolveDeliveryEta(menu)).toBe("45-50 mins");
  });
  it("enriches cart items with product ratings from the restaurant menu", () => {
    const menu = { categories: [{ items: [{ id: "dish-1", name: "Veg Tteokbokki", ratings: { aggregatedRating: { rating: "4.5", ratingCount: "86 ratings" } } }] }] };
    const receipt = normalizeCartReceipt({ items: [{ itemId: "dish-1", name: "Veg Tteokbokki", price: 399 }] }, 399, menu);
    expect(receipt.items[0]).toMatchObject({ rating: 4.5, ratingCount: 86 });
    expect(resolveProductRating(menu.categories[0].items[0])).toEqual({ value: 4.5, count: 86 });
  });
  it("normalizes quick-add menu items and protects items requiring options", () => {
    const menu = { categories: [{ items: [
      { id: "simple-1", name: "Lime Soda", price: 99, description: "Fresh lime and soda", isVeg: true },
      { id: "custom-1", name: "Rice Bowl", price: 249, hasVariants: true },
    ] }] };
    expect(normalizeMenuCatalog(menu)).toEqual([
      expect.objectContaining({ id: "simple-1", name: "Lime Soda", canQuickAdd: true }),
      expect.objectContaining({ id: "custom-1", name: "Rice Bowl", canQuickAdd: false, hasVariants: true }),
    ]);
  });
  it("normalizes required variants and add-ons and builds a selected cart payload", () => {
    const item = {
      id: "bowl-1",
      name: "Build your bowl",
      price: 249,
      variantsV2: {
        variantGroups: [{
          groupId: "size",
          name: "Size",
          variations: [
            { id: "regular", name: "Regular", price: 0, inStock: true },
            { id: "large", name: "Large", price: 50, inStock: true },
          ],
        }],
      },
      addons: [{
        groupId: "extras",
        groupName: "Extras",
        minAddons: 0,
        maxAddons: 2,
        choices: [{ id: "egg", name: "Egg", price: 25, inStock: true }],
      }],
    };
    expect(normalizeMenuOptionGroups(item)).toEqual([
      expect.objectContaining({
        id: "size", kind: "variant", format: "variantsV2", minSelections: 1, maxSelections: 1,
        choices: [expect.objectContaining({ id: "regular" }), expect.objectContaining({ id: "large", price: 50 })],
      }),
      expect.objectContaining({
        id: "extras", kind: "addon", format: "addons", minSelections: 0, maxSelections: 2,
        choices: [expect.objectContaining({ id: "egg", price: 25 })],
      }),
    ]);
    expect(configuredMenuItemPayload(item, [
      { kind: "variant", format: "variantsV2", groupId: "size", choiceId: "large" },
      { kind: "addon", format: "addons", groupId: "extras", choiceId: "egg" },
    ])).toMatchObject({
      itemId: "bowl-1",
      quantity: 1,
      variantsV2: [{ id: "large", name: "Large", groupId: "size" }],
      addons: [{ groupId: "extras", choices: [{ id: "egg", name: "Egg" }] }],
    });
    expect(() => configuredMenuItemPayload(item, [])).toThrow(/Size requires/);
  });
  it("normalizes serialized nested option groups returned by menu search", () => {
    const groups = normalizeMenuOptionGroups({
      variantsV2: JSON.stringify({ data: { variantGroups: [{ groupId: "heat", groupName: "Spice level", variantOptions: [
        { variationId: "mild", displayName: "Mild" },
        { variationId: "hot", displayName: "Hot" },
      ] }] } }),
    });
    expect(groups).toEqual([expect.objectContaining({
      id: "heat",
      name: "Spice level",
      choices: [expect.objectContaining({ id: "mild", name: "Mild" }), expect.objectContaining({ id: "hot", name: "Hot" })],
    })]);
  });
  it("creates a trusted user-local datetime and weekday context", () => {
    expect(currentTemporalContext("Asia/Kolkata", new Date("2026-07-23T20:00:00.000Z"))).toMatchObject({
      iso: "2026-07-23T20:00:00.000Z",
      timeZone: "Asia/Kolkata",
      dayOfWeek: "Friday",
    });
    expect(currentTemporalContext("Not/AZone", new Date("2026-07-23T20:00:00.000Z")).timeZone).toBe("Asia/Kolkata");
  });
  it("normalizes promo codes, the auto-selected best match, and manual overrides", () => {
    const raw = { data: { bestCoupons: [
      { couponCode: "SAVE50", description: "Save ₹50", discountAmount: 50, isApplicable: true, requiresOnlinePayment: false },
      { couponCode: "SAVE80", description: "Save ₹80", discountAmount: 80, isApplicable: true, requiresOnlinePayment: "false" },
    ] } };
    const automatic = normalizeFoodCoupons(raw, "SAVE80", "auto");
    expect(automatic.find((promo) => promo.code === "SAVE80")).toMatchObject({ selected: true, bestMatch: true, discountAmount: 80 });
    const manual = normalizeFoodCoupons(raw, "SAVE50", "manual");
    expect(manual.find((promo) => promo.code === "SAVE50")).toMatchObject({ selected: true, bestMatch: false });
    expect(manual.find((promo) => promo.code === "SAVE80")).toMatchObject({ selected: false, bestMatch: true });
  });
  it("falls back to MCP text content when structuredContent is empty and parses Swiggy coupon text", () => {
    const text = `Found 3 coupons (2 applicable):

**Best coupon**
  - DNBINGE [✅ APPLICABLE] — Save ₹150 on this order! (code: be61e923-5fde-4560-bb4d-995abd15be7e)
**More offers**
  - TRYNEW [✅ APPLICABLE] — Save ₹100 on this order! (code: 0bf64863-0000-45f6-a88a-6c7ac3f7087e)
  - FLAT200 [❌ NOT APPLICABLE] — Add ₹200 more to get a Flat ₹200 off (code: a41bff3e-50b7-4be8-b761-619b0117c87d)`;
    const value = unwrap({ content: [{ type: "text", text }], structuredContent: {} });
    expect(value).toBe(text);
    const promos = normalizeFoodCoupons(value);
    expect(promos).toEqual([
      expect.objectContaining({ code: "DNBINGE", applicable: true, selectable: true, discountAmount: 150, bestMatch: true }),
      expect.objectContaining({ code: "TRYNEW", applicable: true, selectable: true, discountAmount: 100 }),
      expect.objectContaining({ code: "FLAT200", applicable: false, selectable: false, discountAmount: 200 }),
    ]);
  });
  it("exposes payment-specific and ineligible Swiggy offers without auto-applying them", () => {
    const promos = normalizeFoodCoupons([
      { code: "UPI100", shortDescription: "Save with UPI", isApplicable: true, requiresOnlinePayment: true },
      { coupon: { code: "ADD150" }, displayName: "Add more items", isApplicable: false, ineligibilityReason: "Add ₹150 more" },
    ]);
    expect(promos).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UPI100", applicable: true, selectable: false, requiresOnlinePayment: true, description: "Save with UPI" }),
      expect.objectContaining({ code: "ADD150", applicable: false, selectable: false, ineligibilityReason: "Add ₹150 more" }),
    ]));
    expect(promos.some((promo) => promo.bestMatch)).toBe(false);
  });
  it("normalizes serialized coupon payloads but excludes zero-discount cart suggestion metadata", () => {
    const coupons = normalizeFoodCoupons({
      result: '{"data":{"coupons":[{"coupon_code":"RAMEN50","description":"Save ₹50","is_applicable":true}]}}',
      offers: {
        availableCoupons: [{ offerCode: "UPI75", title: "Pay with UPI", requiresOnlinePayment: true }],
        coupon_applied: { coupon_code: "DNBINGE", coupon_discount: 0 },
      },
    });
    expect(coupons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "RAMEN50", applicable: true, selectable: true }),
      expect.objectContaining({ code: "UPI75", applicable: true, selectable: false, requiresOnlinePayment: true }),
    ]));
    expect(coupons.some((coupon) => coupon.code === "DNBINGE")).toBe(false);
  });
  it("reconciles model coupon claims against the deterministic coupon response", () => {
    const response = reconcileCouponRationale(
      "The cart is verified. DNBINGE is auto-suggested at ₹0, and fetch_food_coupons returned no positive coupons.",
      [{ code: "RAMEN50" }, { code: "UPI75" }],
      "available",
    );
    expect(response).toBe("The cart is verified. Swiggy returned 2 available offers: RAMEN50, UPI75.");
  });
  it("normalizes explicit dietary markers and item descriptions", () => {
    expect(resolveDietaryType({ itemAttribute: { vegClassifier: "VEG" } })).toBe("veg");
    expect(resolveDietaryType({ isVeg: false })).toBe("non_veg");
    expect(resolveDietaryType({ is_veg: "1" })).toBe("veg");
    expect(resolveDietaryType({ foodType: "NON-VEG" })).toBe("non_veg");
    expect(resolveItemDescription({ itemDescription: "Crispy chicken with house spices" })).toBe("Crispy chicken with house spices");
    expect(resolveItemDescription({
      shortDescription: "Slow-cooked broth with...",
      longDescription: "Slow-cooked broth with noodles, vegetables, aromatics, and house spices.",
    })).toBe("Slow-cooked broth with noodles, vegetables, aromatics, and house spices.");
  });
  it("normalizes canonical nested Swiggy address fields", () => {
    const address = normalizeAddress({ id: "addr_1", value: { label: "Home", receiver: { receiverName: "Nishith" }, displayText: "12 MG Road, Bengaluru 560001" } });
    expect(address).toMatchObject({ id: "addr_1", type: "Home", receiverName: "Nishith", addressString: "12 MG Road, Bengaluru 560001" });
  });
  it("uses Swiggy address categories and tags", () => {
    const address = normalizeAddress({ id: "38877839", addressLine: "Nishith P: #5 F3 Sooryakiran Apartments, Bengaluru", phoneNumber: "****2285", addressCategory: "Home", addressTag: "home" });
    expect(address).toMatchObject({ category: "Home", tag: "home", type: "home", receiverName: "Nishith P", addressString: "#5 F3 Sooryakiran Apartments, Bengaluru", phoneNumber: "****2285" });
  });
  it("normalizes live UPI QR and COD payment options", () => {
    const options = normalizePaymentOptions({
      platforms: { desktop: { methods: [{ id: "PayWithQR", displayName: "UPI", kind: "qr" }] } },
      allMethods: [{ id: "PayWithQR", raw: { payment_code: "UPI" } }],
      cod: { available: true, id: "COD", displayName: "Cash on delivery" },
    });
    expect(options).toEqual({
      upi: { available: true, id: "PayWithQR", label: "UPI", code: "UPI" },
      cod: { available: true, id: "COD", label: "Cash on delivery", code: "COD" },
    });
  });
  it("normalizes a pending UPI payment and its status", () => {
    const payment = normalizePendingPayment({
      orderId: "242566743091071", paasId: "266672343000722",
      upiIntentUrl: "upi://pay?pa=swiggyupi@axb&am=343.00&cu=INR",
      bridgeUrl: "https://mcp.swiggy.com/deeplink-redirect?link=abc",
      paidAmount: 343, cartId: 1022034748, lat: 12.98, lng: 77.65,
      maxTimeToPollForInMs: 300000,
    }, { addressId: "addr_1", finalAmount: 343 }, Date.parse("2026-07-23T10:00:00.000Z"));
    expect(payment).toMatchObject({ orderId: "242566743091071", paasId: "266672343000722", cartId: "1022034748", amount: 343, addressId: "addr_1" });
    expect(payment.expiresAt).toBe("2026-07-23T10:05:00.000Z");
    expect(normalizePaymentStatus({ paymentStatus: "SUCCESS" })).toBe("paid");
    expect(normalizePaymentStatus({ data: { state: "PENDING_PAYMENT" } })).toBe("pending");
    expect(normalizePaymentStatus({ status: "CANCELLED" })).toBe("failed");
  });
  it("finds the applied coupon code across Swiggy cart shapes", () => {
    expect(resolveCouponCode({ couponCode: "CRAVE80" })).toBe("CRAVE80");
    expect(resolveCouponCode({ offers: { coupon_applied: { coupon_code: "UPI50", coupon_discount: 50 } } })).toBe("UPI50");
    expect(resolveCouponCode({ offers: { coupon_applied: { coupon_code: "TRYNEW", coupon_discount: 0 } } })).toBe("");
    expect(resolveAppliedCouponDiscount({ offers: { coupon_applied: { coupon_code: "UPI50", coupon_discount: 50 } } })).toBe(50);
    expect(resolveCouponCode({ data: { cart: { applied_coupon_code: "SAVE100" } } })).toBe("SAVE100");
  });
  it("claims a pending payment transition only once", async () => {
    const threadId = "payment-cancel-race-test";
    await saveThread({ threadId, status: "payment_pending", suggestion: {} });
    expect(await claimThreadStatus(threadId, ["payment_pending"], "payment_cancelling")).toMatchObject({ status: "payment_cancelling" });
    expect(await claimThreadStatus(threadId, ["payment_pending"], "payment_paid")).toBeNull();
    expect(await getThread(threadId)).toMatchObject({ status: "payment_cancelling" });
  });
  it("prevents checkout from racing a cart customization", async () => {
    const threadId = "customization-checkout-race-test";
    await saveThread({ threadId, status: "awaiting_confirmation", suggestion: {} });
    expect(await claimThreadStatus(threadId, ["awaiting_confirmation"], "customizing")).toMatchObject({ status: "customizing" });
    expect(await claimThreadStatus(threadId, ["awaiting_confirmation"], "placing_order")).toBeNull();
  });
});
