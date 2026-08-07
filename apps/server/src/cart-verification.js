const ITEM_ID_PATHS = [
  "itemId", "item_id", "menuItemId", "menu_item_id", "id", "info.id",
  "item.id", "item.itemId", "item.item_id", "item.info.id",
];

export function resolveMenuItemId(item) {
  for (const path of ITEM_ID_PATHS) {
    const value = path.split(".").reduce((current, key) => current?.[key], item);
    if (value !== undefined && value !== null && value !== "" && typeof value !== "object") return String(value);
  }
  return "";
}

export function cartReflectsItems(cart, expectedItems) {
  const expected = cartItemQuantities(expectedItems);
  if (!expected.size) return false;
  return collectArraysAtKeys(cart, new Set(["items", "cartItems", "orderItems"])).some((items) => {
    const actual = cartItemQuantities(items);
    if (actual.size !== expected.size) return false;
    return [...expected].every(([itemId, quantity]) => actual.get(itemId) === quantity);
  });
}

function cartItemQuantities(items) {
  const quantities = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const itemId = resolveMenuItemId(item);
    if (!itemId) continue;
    const quantity = finiteNumber(item.quantity ?? item.qty ?? item.count ?? item.item?.quantity ?? item.item?.qty) || 1;
    quantities.set(itemId, (quantities.get(itemId) || 0) + quantity);
  }
  return quantities;
}

function collectArraysAtKeys(value, keys, found = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return found;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && Array.isArray(child)) found.push(child);
    collectArraysAtKeys(child, keys, found, seen);
  }
  return found;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
