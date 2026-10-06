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
  return compareCartItems(cart, expectedItems).verified;
}

export function compareCartItems(cart, expectedItems) {
  const expected = cartItemQuantities(expectedItems);
  const arrays = collectArraysAtKeys(cart, new Set(["items", "cartItems", "orderItems"]));
  const verified = expected.size > 0 && arrays.some((items) => {
    const actual = cartItemQuantities(items);
    if (actual.size !== expected.size) return false;
    return [...expected].every(([itemId, quantity]) => actual.get(itemId) === quantity);
  });
  const entries = (quantities) => [...quantities].slice(0, 20).map(([itemId, quantity]) => ({ itemId, quantity }));
  return {
    verified,
    reason: verified ? "matched" : !expected.size ? "missing_expected_item_ids" : !arrays.length ? "unrecognized_cart_shape" : "item_or_quantity_mismatch",
    responseType: cart === null ? "null" : typeof cart,
    responseKeys: cart && typeof cart === "object" ? Object.keys(cart).slice(0, 20) : [],
    arrayPaths: cartArrayPaths(cart),
    expected: entries(expected),
    actual: arrays.slice(0, 8).map((items) => ({ itemCount: items.length, items: entries(cartItemQuantities(items)) })),
  };
}

function cartArrayPaths(value, path = "", paths = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 6 || paths.length >= 20) return paths;
  if (Array.isArray(value)) { paths.push(path); return paths; }
  for (const [key, child] of Object.entries(value)) cartArrayPaths(child, path ? `${path}.${key}` : key, paths, depth + 1);
  return paths;
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
