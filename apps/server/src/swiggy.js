import { config } from "./config.js";
import { connectSwiggyFood } from "./swiggy-mcp.js";
import { runFoodCartAgent } from "./swiggy-agent.js";

export async function buildPersonalizedCart(food, threadId, swiggySessionId, preferredAddressId, streamId) {
  if (!swiggySessionId && !config.swiggyMcpAccessToken) throw new Error("Connect a real Swiggy account before building a cart.");
  const mcp = await connectSwiggyFood(swiggySessionId);
  try {
    const addresses = await loadAllAddresses(mcp);
    const address = addresses.find((item) => String(resolveAddressId(item)) === String(preferredAddressId)) || addresses[0];
    if (!address) throw new Error("No saved Swiggy address found. Add an address in Swiggy first.");
    const addressId = resolveAddressId(address);
    if (!addressId) throw new Error("Swiggy returned a saved address without an addressId. Refresh your saved addresses and try again.");
    const selectedAddress = normalizeAddress(address);
    const addressSummary = [selectedAddress.type?.toLowerCase() === "saved address" ? "" : selectedAddress.type, selectedAddress.receiverName, selectedAddress.addressString].filter(Boolean).join(" · ");
    const agentResult = await runFoodCartAgent(mcp, { food, addressId, addressSummary, streamId });
    const cart = await callStep(mcp, "get_food_cart", { addressId });
    const receipt = normalizeCartReceipt(cart, extractVerifiedTotal(agentResult.rationale));
    if (receipt.finalAmount >= 1000) throw new Error("The personalized cart reaches Swiggy Builders Club’s ₹1,000 limit.");
    const rawItem = arrayAt(cart, "items")[0] || collectNamed(cart)[0];
    const item = receipt.items[0] || rawItem;
    if (!item) throw new Error("The Swiggy agent finished without an orderable item in the cart.");
    const restaurantName = resolveRestaurantName(cart, rawItem || item, agentResult.rationale, agentResult.restaurantName);

    return {
      threadId,
      dish: food.dish,
      restaurant: restaurantName,
      item: item.name || item.title,
      price: receipt.subtotal,
      savings: receipt.discount,
      finalAmount: receipt.finalAmount,
      receipt,
      imageUrl: receipt.items[0]?.imageUrl || resolveItemImage(rawItem || item),
      deliveryEta: resolveDeliveryEta(cart),
      coupon: cart.couponCode || cart.offers?.coupon_applied?.coupon_code,
      addressId,
      deliveryAddress: addressSummary,
      availablePaymentMethods: normalizePaymentMethods(cart.availablePaymentMethods),
      rationale: agentResult.rationale,
      dietaryNotes: ["Order history, variants, add-ons, and avoidances reviewed by the agent"],
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  } finally {
    await mcp.close().catch(() => {});
  }
}

export async function getSavedAddresses(swiggySessionId) {
  if (!swiggySessionId && !config.swiggyMcpAccessToken) throw new Error("Connect a real Swiggy account to load addresses.");
  const mcp = await connectSwiggyFood(swiggySessionId);
  try {
    return (await loadAllAddresses(mcp)).map(normalizeAddress).filter((address) => address.id);
  } finally { await mcp.close().catch(() => {}); }
}

export async function placeOrder(suggestion, swiggySessionId) {
  if (!swiggySessionId && !config.swiggyMcpAccessToken) throw new Error("Connect a real Swiggy account before placing an order.");
  const mcp = await connectSwiggyFood(swiggySessionId);
  try {
    if (!suggestion.addressId) throw new Error("The confirmed cart has no delivery address. Build the cart again.");
    const cart = await callStep(mcp, "get_food_cart", { addressId: suggestion.addressId, restaurantName: suggestion.restaurant });
    const total = Number(cart.total ?? cart.totalAmount ?? 0);
    if (total > 1000) throw new Error("Cart exceeds Swiggy Builders Club’s ₹1,000 limit.");
    // Deliberately no generic retry: place_food_order is not idempotent.
    const paymentMethod = suggestion.availablePaymentMethods?.[0];
    return await callStep(mcp, "place_food_order", { addressId: suggestion.addressId, ...(paymentMethod ? { paymentMethod } : {}) });
  } finally {
    await mcp.close().catch(() => {});
  }
}

function arrayAt(value, key) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.[key])) return value[key];
  return collectNamed(value);
}

function collectNamed(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (!Array.isArray(value) && (value.name || value.title) && (value.id || value.itemId)) found.push({ ...value, id: value.id || value.itemId });
  for (const child of Object.values(value)) collectNamed(child, found);
  return found;
}

function includesDish(item, dish) {
  return JSON.stringify(item).toLowerCase().includes(dish.toLowerCase());
}

function scoreRestaurant(item, profile) {
  const name = String(item.name || item.restaurantName || "").toLowerCase();
  return Number(item.rating || 0) * 10 - Number(item.distance || item.distanceKm || 0) + (profile.favoriteRestaurants.get(name) || 0) * 100;
}

function deriveProfile(orderHistory) {
  const favoriteRestaurants = new Map();
  const notes = [];
  walk(orderHistory, (key, value, parent) => {
    if (/restaurant(name)?/i.test(key) && typeof value === "string") {
      const name = value.toLowerCase(); favoriteRestaurants.set(name, (favoriteRestaurants.get(name) || 0) + 1);
    }
    if (/instruction|note|allerg/i.test(key) && typeof value === "string" && value.trim()) notes.push(value.trim());
    if (key === "name" && typeof value === "string" && /restaurant/i.test(String(parent?.type || ""))) {
      const name = value.toLowerCase(); favoriteRestaurants.set(name, (favoriteRestaurants.get(name) || 0) + 1);
    }
  });
  const avoid = [...new Set(notes.flatMap((note) => [...note.toLowerCase().matchAll(/(?:no|without|allergic to|avoid)\s+([a-z][a-z -]{1,30})/g)].map((match) => match[1].trim())))];
  return { favoriteRestaurants, notes: [...new Set(notes)], avoid };
}

function walk(value, visit, parent) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child, value);
    if (child && typeof child === "object") walk(child, visit, value);
  }
}

function couponValue(coupon) {
  return Number(coupon?.discountAmount ?? coupon?.maxDiscount ?? coupon?.discount ?? 0);
}

async function callStep(mcp, name, arguments_) {
  try { return await mcp.call(name, arguments_); }
  catch (error) { throw new Error(`Swiggy ${name} failed: ${error instanceof Error ? error.message : String(error)}`); }
}

function normalizePaymentMethods(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item : item?.code || item?.method || item?.type || item?.name).filter(Boolean);
}

export function resolveRestaurantName(cart, item, rationale = "", selectedRestaurantName = "") {
  const name = firstValue(cart, [
    "restaurantName", "restaurant_name", "restaurant.name", "restaurantInfo.name", "restaurant_info.name",
    "restaurantDetails.name", "restaurant_details.name", "store.name", "outlet.name", "outletName", "outlet_name",
  ]) || findRestaurantName(cart)
    || firstValue(item, ["restaurantName", "restaurant_name", "restaurant.name", "restaurantInfo.name", "restaurant_info.name", "outletName", "outlet_name"])
    || findRestaurantName(item)
    || selectedRestaurantName;
  if (name) return String(name).trim();
  const text = String(rationale);
  const rationaleName = text.match(/restaurant choice\s*:\s*(?:\*\*)?([^\n*]+?)(?:\*\*)?\s+(?:was|is|—|-)/i)?.[1]?.trim()
    || text.match(/\bfrom\s+(?:\*\*)?([^\n*]+?)(?:\*\*)?(?:\n|$|\s[-–—]\s)/i)?.[1]?.trim();
  return rationaleName || "Swiggy restaurant";
}

function findRestaurantName(value, parentKey = "", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
    if (["restaurantname", "restaurantdisplayname", "outletname", "storename"].includes(normalized) && typeof child === "string" && child.trim()) return child;
    if (/restaurant|outlet|store/i.test(parentKey) && /^(name|title|displayname)$/i.test(normalized) && typeof child === "string" && child.trim()) return child;
  }
  for (const [key, child] of Object.entries(value)) {
    const found = findRestaurantName(child, key, seen);
    if (found) return found;
  }
}

export function normalizeCartReceipt(cart, verifiedTotal = 0) {
  const itemSource = findArray(cart, ["items", "cartItems", "orderItems"]) || [];
  const items = itemSource.map((item) => {
    const quantity = finiteNumber(item.quantity ?? item.qty ?? item.count) || 1;
    const originalUnitPrice = money(item.originalPrice ?? item.defaultPrice ?? item.price ?? item.unitPrice ?? item.itemPrice);
    const unitPrice = money(item.discountedPrice ?? item.sellingPrice ?? item.finalPrice ?? item.offerPrice ?? item.price ?? item.unitPrice ?? item.itemPrice);
    const total = money(item.discountedTotal ?? item.finalTotal ?? item.itemTotal ?? item.total ?? item.totalPrice) || unitPrice * quantity;
    const originalTotal = originalUnitPrice * quantity;
    const customizations = collectCustomizationNames(item);
    return { name: String(item.name || item.title || item.itemName || "Cart item"), quantity, unitPrice, originalUnitPrice, total, originalTotal, savings: Math.max(0, originalTotal - total), customizations, imageUrl: resolveItemImage(item) };
  });
  const billEntries = findArray(cart, ["billDetails", "billBreakdown", "charges", "fees"]) || [];
  let charges = billEntries.map((entry) => ({
    label: String(entry.label || entry.name || entry.title || entry.displayText || "Charge"),
    amount: money(entry.amount ?? entry.value ?? entry.price ?? entry.finalAmount),
  })).filter((entry) => entry.amount && !/discount|coupon|saving|subtotal|item total|to pay|grand total/i.test(entry.label));
  if (!charges.length) charges = collectNamedCharges(cart);
  const itemTotal = items.reduce((sum, item) => sum + item.total, 0);
  const originalItemTotal = items.reduce((sum, item) => sum + (item.originalTotal || item.total), 0);
  // The receipt subtracts item savings below, so its subtotal must be the
  // pre-savings item value. Otherwise discounted item prices are counted twice.
  const subtotal = firstMoney(cart, ["subtotal", "subTotal", "itemTotal", "itemsTotal", "cartSubtotal", "orderSubtotal"]) || originalItemTotal || itemTotal;
  const explicitDiscount = firstMoney(cart, ["discount", "discountAmount", "totalDiscount", "couponDiscount", "couponSavings", "coupon_discount"])
    || firstMoney(cart?.offers?.coupon_applied, ["coupon_discount", "discountAmount"]);
  const discount = explicitDiscount + items.reduce((sum, item) => sum + item.savings, 0);
  const chargeTotal = charges.reduce((sum, charge) => sum + charge.amount, 0);
  const structuredTotal = cartPayable(cart);
  const finalAmount = structuredTotal || verifiedTotal || Math.max(0, subtotal + chargeTotal - discount);
  charges = reconcileCharges(charges, Math.max(0, finalAmount - subtotal + discount));
  return { items, charges, subtotal, discount, finalAmount };
}

export function resolveItemImage(item) {
  const raw = firstValue(item, ["imageUrl", "image_url", "thumbnailUrl", "thumbnail_url", "image.url", "image.src", "media.imageUrl", "cloudinaryImageId", "cloudinary_image_id"])
    || deepScalar(item, ["imageurl", "thumbnailurl", "cloudinaryimageid"]);
  if (!raw) return undefined;
  const value = String(raw).trim();
  if (/^https:\/\//i.test(value)) return value;
  if (/^[\w/-]+$/.test(value)) return `https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto,w_512/${value}`;
}

export function resolveDeliveryEta(cart) {
  const raw = firstValue(cart, [
    "deliveryEta", "deliveryETA", "etaMinutes", "deliveryTime", "delivery_time", "deliveryTimeInMinutes", "timeToDeliver",
    "sla.slaString", "sla.deliveryTime", "restaurant.sla.slaString", "restaurant.sla.deliveryTime",
    "cart.sla.slaString", "cart.sla.deliveryTime", "cart.deliveryTime", "cart.delivery_time",
  ]) || deepScalar(cart, ["deliveryeta", "etaminutes", "deliverytimeinminutes", "timetodeliver", "slastring"]);
  if (raw === undefined) return undefined;
  const value = String(raw).trim();
  if (!value) return undefined;
  return /min|hour|hr/i.test(value) ? value : `${value} min`;
}

function cartPayable(value) {
  const keys = ["finalAmount", "totalToPay", "toPay", "grandTotal", "totalPayable", "payableAmount", "amountToPay", "totalAmount", "total"];
  // Only inspect known cart/result envelopes. A recursive lookup can mistake an
  // item's `total` for the amount payable by the customer.
  const containers = [value, value?.cart, value?.data?.cart, value?.result?.cart, value?.data, value?.result];
  for (const container of containers) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    for (const key of keys) { const amount = money(container[key]); if (amount) return amount; }
  }
  return 0;
}

function reconcileCharges(charges, expectedTotal) {
  const reconciled = [];
  let remaining = expectedTotal;
  for (const charge of charges) {
    if (remaining <= 0.009) break;
    const amount = Math.min(charge.amount, remaining);
    if (amount > 0.009) {
      const existing = reconciled.find((entry) => entry.label === charge.label);
      if (existing) existing.amount += amount;
      else reconciled.push({ ...charge, amount });
    }
    remaining -= amount;
  }
  if (remaining > 0.009) reconciled.push({ label: "Taxes & charges", amount: remaining });
  return reconciled;
}

function collectNamedCharges(value) {
  const labels = { deliveryfee: "Delivery fee", platformfee: "Platform fee", packingcharges: "Packaging charges", packagingcharges: "Packaging charges", restaurantpackagingcharges: "Packaging charges", gst: "GST", tax: "Taxes", taxes: "Taxes", taxesandcharges: "Taxes & charges", rainfee: "Rain fee" };
  const charges = [];
  walk(value, (key, child) => {
    const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
    if (labels[normalized]) { const amount = money(child); if (amount) charges.push({ label: labels[normalized], amount }); }
  });
  return [...new Map(charges.map((charge) => [charge.label, charge])).values()];
}

function extractVerifiedTotal(text) {
  const match = String(text || "").match(/(?:final cart total|verified total|to pay|payable)[^₹\d]{0,20}₹?\s*([\d,.]+)/i);
  return match ? money(match[1]) : 0;
}

function findArray(value, keys) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) if (Array.isArray(value[key])) return value[key];
  for (const child of Object.values(value)) { const found = findArray(child, keys); if (found) return found; }
}

function firstMoney(value, keys) {
  if (!value || typeof value !== "object") return 0;
  for (const key of keys) { const amount = money(value[key]); if (amount) return amount; }
  for (const child of Object.values(value)) { const amount = firstMoney(child, keys); if (amount) return amount; }
  return 0;
}

function money(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Number(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function collectCustomizationNames(item) {
  const values = [];
  walk(item, (key, value) => {
    if (/variant|addon|customization/i.test(key) && typeof value === "string" && value.trim()) values.push(value.trim());
  });
  return [...new Set(values)].slice(0, 8);
}

function finiteNumber(value) {
  const number = Number(value); return Number.isFinite(number) ? number : undefined;
}

export function normalizeAddress(address) {
  const category = firstValue(address, ["addressCategory", "address_category"])
    || deepScalar(address, ["addresscategory"])
    || "Other";
  const tag = firstValue(address, ["addressTag", "address_tag", "label", "addressLabel", "address_label", "tag"])
    || deepScalar(address, ["addresstag", "label", "addresslabel", "tag"])
    || "";
  const rawAddressLine = firstValue(address, ["addressLine", "address_line"])
    || deepScalar(address, ["addressline"])
    || "";
  const parsedLine = splitReceiverFromAddress(rawAddressLine);
  const receiverName = firstValue(address, ["receiverName", "receiver_name", "receiverDetails.name", "receiver_details.name", "contact.name", "contactName", "contact_name", "customerName", "customer_name"])
    || deepScalar(address, ["receivername", "contactname", "customername"])
    || parsedLine.receiverName
    || "";
  const addressString = firstValue(address, ["displayText", "display_text", "addressString", "address_string", "formattedAddress", "formatted_address", "fullAddress", "full_address", "deliveryAddress", "delivery_address", "addressDetails.address", "address_details.address", "address"])
    || deepScalar(address, ["displaytext", "addressdisplaytext", "addressstring", "formattedaddress", "fulladdress", "deliveryaddress", "addressline", "address"])
    || joinAddressParts(address)
    || rawAddressLine
    || String(tag || category);
  return {
    id: String(resolveAddressId(address) || ""),
    type: String(tag || category),
    category: String(category),
    tag: String(tag),
    receiverName: String(receiverName),
    addressString: typeof addressString === "string" ? splitReceiverFromAddress(addressString).addressString : JSON.stringify(addressString),
    phoneNumber: String(firstValue(address, ["phoneNumber", "phone_number"]) || deepScalar(address, ["phonenumber"]) || ""),
    latitude: finiteNumber(firstValue(address, ["latitude", "lat", "location.latitude", "location.lat"])),
    longitude: finiteNumber(firstValue(address, ["longitude", "lng", "lon", "location.longitude", "location.lng"])),
  };
}

async function loadAllAddresses(mcp) {
  const addresses = [];
  for (let page = 1; page <= 10; page++) {
    const result = await mcp.call("get_addresses", page === 1 ? {} : { page });
    addresses.push(...arrayAt(result, "addresses"));
    const pagination = result?.pagination;
    if (!pagination?.hasMore && !(pagination?.totalPages > page)) break;
  }
  return [...new Map(addresses.map((address) => [String(resolveAddressId(address)), address])).values()];
}

function splitReceiverFromAddress(value) {
  if (typeof value !== "string") return { receiverName: "", addressString: "" };
  const separator = value.indexOf(":");
  if (separator < 1 || separator > 80) return { receiverName: "", addressString: value.trim() };
  return { receiverName: value.slice(0, separator).trim(), addressString: value.slice(separator + 1).trim() };
}

function resolveAddressId(address) {
  return firstValue(address, ["addressId", "address_id", "id", "address.addressId", "address.address_id", "address.id"])
    || deepScalar(address, ["addressid"]);
}

function deepScalar(value, normalizedKeys, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[_\s-]/g, "").toLowerCase();
    if (normalizedKeys.includes(normalized) && child !== undefined && child !== null && child !== "" && typeof child !== "object") return child;
  }
  for (const child of Object.values(value)) {
    if (typeof child === "string" && /^[{[]/.test(child.trim())) {
      try { const found = deepScalar(JSON.parse(child), normalizedKeys, seen); if (found !== undefined) return found; } catch { /* not embedded JSON */ }
    }
    const found = deepScalar(child, normalizedKeys, seen);
    if (found !== undefined) return found;
  }
}

function firstValue(object, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((current, key) => current?.[key], object);
    if (value !== undefined && value !== null && value !== "" && typeof value !== "object") return value;
  }
}

function joinAddressParts(address) {
  const keys = ["flatNo", "flat_no", "houseNo", "house_no", "addressLine1", "address_line_1", "addressLine2", "address_line_2", "landmark", "area", "locality", "city", "pincode", "postalCode"];
  return [...new Set(keys.map((key) => address[key]).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))].join(", ");
}
