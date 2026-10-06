import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

export function menuRestaurantIds(value, ids = new Set()) {
  if (!value || typeof value !== "object") return ids;
  for (const key of ["restaurant_id", "restaurantId", "restaurantIdOfAddedItem"]) {
    if (value[key] !== undefined && value[key] !== null && String(value[key]).trim()) ids.add(String(value[key]));
  }
  if (value.restaurant?.id) ids.add(String(value.restaurant.id));
  for (const child of Object.values(value)) if (child && typeof child === "object") menuRestaurantIds(child, ids);
  return ids;
}

// Validate against the original MCP schema, not the simplified model schema.
export function createToolArgumentValidator(definition) {
  const validate = new AjvJsonSchemaValidator().getValidator(definition.inputSchema || { type: "object" });
  return (input) => {
    const args = normalizeToolArguments(definition.name, input);
    const result = validate(args);
    const missingCartFields = definition.name === "update_food_cart"
      ? ["restaurantId", "addressId"].filter((key) => typeof args[key] !== "string" || !args[key].trim())
      : [];
    if (!result.valid || missingCartFields.length || (definition.name === "update_food_cart" && !Array.isArray(args.cartItems))) {
      const fields = missingCartFields.map((field) => ({ field, expected: "non-empty string", received: args[field] === null ? "null" : Array.isArray(args[field]) ? "array" : typeof args[field] === "string" && !args[field].trim() ? "blank string" : typeof args[field] }));
      return { valid: false, args, fields, error: `Invalid ${definition.name} arguments: ${fields.length ? fields.map(({ field, received }) => `${field}: non-empty string required; received ${received}`).join("; ") : result.errorMessage || "cartItems must be an array"}. Copy identifiers from the returned menu/address data and retry with the exact tool schema.` };
    }
    return { valid: true, args };
  };
}

// Deliberately emit only the JS SDK's documented JSON Schema subset. The
// original MCP schema remains the execution boundary, including unions/ranges.
export function liteRtToolSchema(name, schema, normalize) {
  const project = (value) => {
    const source = normalize(value);
    return Object.fromEntries(Object.entries(source).filter(([key]) => ["type", "description", "properties", "required", "items", "enum"].includes(key)).map(([key, child]) => [key,
      key === "properties" ? Object.fromEntries(Object.entries(child).map(([field, definition]) => [field, project(definition)])) : key === "items" ? project(child) : child,
    ]));
  };
  const projected = project(schema || { type: "object", properties: {} });
  if (name !== "update_food_cart") return projected;
  const item = projected.properties?.cartItems?.items || {};
  return {
    ...projected, type: "object",
    properties: {
      ...projected.properties,
      restaurantId: { type: "string", description: "Exact restaurant ID from the selected returned menu item. Copy it as a non-empty string." },
      addressId: { type: "string", description: "Selected delivery address ID, injected by the server." },
      cartItems: { ...projected.properties?.cartItems, type: "array", items: {
        ...item, type: "object",
        properties: { ...item.properties, menu_item_id: { type: "string", description: "Exact menu item ID returned by Swiggy, copied as a string." }, quantity: { type: "integer", description: "Positive whole-number quantity." } },
        required: [...new Set([...(item.required || []), "menu_item_id", "quantity"])],
      } },
    },
    required: [...new Set([...(projected.required || []), "restaurantId", "addressId", "cartItems"])],
  };
}

// Record the item/restaurant relationship before result compaction. Never pick
// a restaurant merely because it appeared somewhere in a multi-restaurant result.
export function cartMenuEvidence(value, scopedRestaurantId) {
  const evidence = [];
  const visit = (node, inheritedId) => {
    if (!node || typeof node !== "object") return;
    const id = node.restaurantId ?? node.restaurant_id ?? node.restaurantIdOfAddedItem ?? node.restaurant?.id ?? inheritedId;
    const itemId = node.menu_item_id ?? node.menuItemId ?? node.itemId ?? ((node.name || node.title) && (node.price !== undefined || node.variantsV2 || node.itemAttribute) ? node.id : undefined);
    if (itemId != null && id != null && String(id).trim()) evidence.push({ menu_item_id: String(itemId), restaurantId: String(id), name: node.name || node.title || node.itemName });
    for (const child of Object.values(node)) if (child && typeof child === "object") visit(child, id);
  };
  visit(value, scopedRestaurantId);
  return [...new Map(evidence.map((item) => [`${item.restaurantId}:${item.menu_item_id}`, item])).values()].slice(0, 12);
}

export function normalizeToolArguments(name, input = {}) {
  const args = { ...input };
  if (name !== "update_food_cart") return args;
  for (const [key, aliases] of Object.entries({ restaurantId: ["restaurant_id"], restaurantName: ["restaurant_name"], cartItems: ["cart_items", "items"], addressId: ["address_id"] })) {
    if (args[key] === undefined) {
      const alias = aliases.find((candidate) => args[candidate] !== undefined);
      if (alias) args[key] = args[alias];
    }
    for (const alias of aliases) delete args[alias];
  }
  if (args.restaurantId === undefined && args.restaurant?.id !== undefined) args.restaurantId = args.restaurant.id;
  if (args.restaurantName === undefined && args.restaurant?.name !== undefined) args.restaurantName = args.restaurant.name;
  delete args.restaurant;
  return args;
}
