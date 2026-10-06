import { describe, expect, it } from "vitest";
import { cartMenuEvidence, createToolArgumentValidator, liteRtToolSchema, menuRestaurantIds } from "../src/tool-arguments.js";
import { normalizeToolSchema } from "../src/swiggy-agent.js";

const validateCart = createToolArgumentValidator({ name: "update_food_cart", inputSchema: {
  type: "object", additionalProperties: false, required: ["restaurantId", "addressId", "cartItems"],
  properties: { restaurantId: { type: "string" }, addressId: { type: "string" }, restaurantName: { type: "string" }, cartItems: { type: "array", items: { type: "object", required: ["menu_item_id", "quantity"], properties: { menu_item_id: { type: "string" }, quantity: { type: "integer", minimum: 1 } } } } },
} });

describe("Swiggy tool argument boundary", () => {
  it("projects union schemas without losing mandatory cart identifiers or nested fields", () => {
    const schema = liteRtToolSchema("update_food_cart", { anyOf: [{ type: "object", properties: { restaurantId: { type: "number" }, cartItems: { type: "array", items: { type: "object", properties: { variantsV2: { type: "array", items: { type: "string" } } } } } } }, { type: "object", properties: {} }] }, normalizeToolSchema);
    expect(schema.required).toEqual(expect.arrayContaining(["restaurantId", "addressId", "cartItems"]));
    expect(schema.properties.restaurantId.type).toBe("string");
    expect(schema.properties.cartItems.items.required).toEqual(["menu_item_id", "quantity"]);
    expect(schema.properties.cartItems.items.properties.variantsV2).toBeDefined();
    expect(JSON.stringify(schema)).not.toMatch(/anyOf|oneOf|minimum|additionalProperties/);
  });
  it("reports malformed identifier types without copying sensitive values into errors", () => {
    const result = validateCart({ restaurantId: 586806, addressId: "a", cartItems: [] });
    expect(result.fields).toEqual([{ field: "restaurantId", expected: "non-empty string", received: "number" }]);
    expect(result.error).toContain("received number");
    expect(result.error).not.toContain("586806");
  });
  it("preserves item-to-restaurant relationships and never assigns a sibling restaurant", () => {
    expect(cartMenuEvidence({ restaurants: [{ restaurant_id: "586806", items: [{ menu_item_id: "item-a", name: "Chicken Biryani" }] }, { restaurant_id: "other", items: [{ menu_item_id: "item-b" }] }] })).toEqual([
      { menu_item_id: "item-a", restaurantId: "586806", name: "Chicken Biryani" }, { menu_item_id: "item-b", restaurantId: "other", name: undefined },
    ]);
    expect(cartMenuEvidence({ restaurant_id: "586806", elsewhere: {} , items: [] })).toEqual([]);
    expect(cartMenuEvidence({ restaurants: [{ restaurant_id: "586806" }], items: [{ menu_item_id: "unscoped" }] })).toEqual([]);
    expect(cartMenuEvidence({ items: [{ menu_item_id: "scoped" }] }, "586806")[0].restaurantId).toBe("586806");
  });
  it("maps aliases to canonical fields without inventing identifiers", () => {
    const result = validateCart({ restaurant_id: "10096", address_id: "selected-address", cart_items: [{ menu_item_id: "205459659", quantity: 1 }] });
    expect(result).toEqual({ valid: true, args: { restaurantId: "10096", addressId: "selected-address", cartItems: [{ menu_item_id: "205459659", quantity: 1 }] } });
    expect(validateCart({ addressId: "selected-address", cartItems: [] })).toMatchObject({ valid: false, error: expect.stringContaining("restaurantId") });
  });
  it("rejects empty identifiers and invalid nested item quantities", () => {
    expect(validateCart({ restaurantId: " ", addressId: "a", cartItems: [] }).valid).toBe(false);
    expect(validateCart({ restaurantId: "10096", addressId: "a", cartItems: [{ menu_item_id: "205459659", quantity: 0 }] }).valid).toBe(false);
  });
  it("keeps original union and numeric enum constraints authoritative", () => {
    const validate = createToolArgumentValidator({ name: "search_menu", inputSchema: { type: "object", properties: { vegFilter: { enum: [0, 1] }, query: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] } } } });
    expect(validate({ vegFilter: 2, query: "pasta" }).valid).toBe(false);
    expect(validate({ vegFilter: 1, query: "" }).valid).toBe(false);
    expect(validate({ vegFilter: 1, query: "pasta" }).valid).toBe(true);
  });
  it("obtains trusted restaurant scopes from nested menu results", () => {
    expect([...menuRestaurantIds({ items: [{ restaurant_id: "10096" }, { restaurant_id: "10096" }], restaurant: { id: "42" } })]).toEqual(["42", "10096"]);
  });
});
