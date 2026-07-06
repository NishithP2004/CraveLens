import { describe, expect, it } from "vitest";
import { FoodVerificationSchema, OrchestrateRequestSchema } from "@cravelens/shared";
import { normalizeToolSchema } from "./swiggy-agent.js";
import { normalizeAddress, normalizeCartReceipt, resolveDeliveryEta, resolveItemImage, resolveRestaurantName } from "./swiggy.js";

describe("CraveLens contracts", () => {
  it("accepts a verified dish", () => expect(FoodVerificationSchema.parse({ isFood: true, dish: "ramen", cuisine: "Japanese", ingredients: [], confidence: .9, context: "ready_to_eat" }).dish).toBe("ramen"));
  it("accepts an orchestration request verified on-device", () => expect(OrchestrateRequestSchema.parse({ videoId: "198AWISrLgl", timestamp: 76, triggerConfidence: .8, verification: { isFood: true, dish: "ramen", cuisine: "Japanese", ingredients: ["noodles"], confidence: .91, context: "ready_to_eat" }, videoTitle: "Ramen", location: "Home" }).verification.dish).toBe("ramen"));
  it("accepts legacy requests containing a full delivery address", () => expect(OrchestrateRequestSchema.parse({ videoId: "198AWISrLgl", timestamp: 76, triggerConfidence: .8, verification: { isFood: true, dish: "ramen", cuisine: "Japanese", ingredients: [], confidence: .9, context: "ready_to_eat" }, location: "Nishith P: ".padEnd(400, "A") }).location.length).toBe(400));
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
  it("normalizes a detailed Swiggy receipt", () => {
    const receipt = normalizeCartReceipt({ cart: { items: [{ name: "Ramen", quantity: 2, price: 180, totalPrice: 360 }], billDetails: [{ label: "Delivery fee", amount: 30 }] }, itemTotal: 360, couponDiscount: 50, totalPayable: 340 });
    expect(receipt).toMatchObject({ subtotal: 360, discount: 50, finalAmount: 340 });
    expect(receipt.items[0]).toMatchObject({ name: "Ramen", quantity: 2, total: 360 });
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
  it("reads the restaurant name from nested Swiggy cart metadata", () => {
    expect(resolveRestaurantName({ cart: { restaurantDetails: { name: "Kokoro Ramen By Nasi and Mee" } } }, {})).toBe("Kokoro Ramen By Nasi and Mee");
    expect(resolveRestaurantName({}, {}, "Restaurant choice: Seoul Bowl was open and nearby.")).toBe("Seoul Bowl");
    expect(resolveRestaurantName({}, {}, "", "Daily Sushi")).toBe("Daily Sushi");
  });
  it("normalizes product images and delivery ETA when Swiggy provides them", () => {
    expect(resolveItemImage({ cloudinaryImageId: "items/salmon-sushi" })).toContain("items/salmon-sushi");
    expect(resolveItemImage({ imageUrl: "https://example.com/sushi.jpg" })).toBe("https://example.com/sushi.jpg");
    expect(resolveDeliveryEta({ cart: { sla: { slaString: "25-30 mins" } } })).toBe("25-30 mins");
    expect(resolveDeliveryEta({ deliveryTimeInMinutes: 32 })).toBe("32 min");
  });
  it("normalizes canonical nested Swiggy address fields", () => {
    const address = normalizeAddress({ id: "addr_1", value: { label: "Home", receiver: { receiverName: "Nishith" }, displayText: "12 MG Road, Bengaluru 560001" } });
    expect(address).toMatchObject({ id: "addr_1", type: "Home", receiverName: "Nishith", addressString: "12 MG Road, Bengaluru 560001" });
  });
  it("uses Swiggy address categories and tags", () => {
    const address = normalizeAddress({ id: "38877839", addressLine: "Nishith P: #5 F3 Sooryakiran Apartments, Bengaluru", phoneNumber: "****2285", addressCategory: "Home", addressTag: "home" });
    expect(address).toMatchObject({ category: "Home", tag: "home", type: "home", receiverName: "Nishith P", addressString: "#5 F3 Sooryakiran Apartments, Bengaluru", phoneNumber: "****2285" });
  });
});
