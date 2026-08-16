import { config } from "./config.js";
import { connectSwiggyFood } from "./swiggy-mcp.js";
import { runFoodCartAgent } from "./swiggy-agent.js";
import { publishAgentEvent } from "./agent-events.js";
import { cartReflectsItems, resolveMenuItemId } from "./cart-verification.js";

export { cartReflectsItems } from "./cart-verification.js";

export async function buildPersonalizedCart(food, threadId, swiggySessionId, preferredAddressId, streamId, agentContext = {}) {
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
    return await buildVerifiedSuggestion(mcp, { food, threadId, addressId, addressSummary, streamId, agentContext: { ...agentContext, deviceId: swiggySessionId } });
  } finally {
    await mcp.close().catch(() => {});
  }
}

export async function customizePersonalizedCart(currentSuggestion, instruction, threadId, swiggySessionId, streamId, agentContext = {}) {
  if (!swiggySessionId && !config.swiggyMcpAccessToken) throw new Error("Connect a real Swiggy account before customizing a cart.");
  const mcp = await connectSwiggyFood(swiggySessionId);
  try {
    const addresses = await loadAllAddresses(mcp);
    const address = addresses.find((item) => String(resolveAddressId(item)) === String(currentSuggestion.addressId));
    if (!address) throw new Error("The delivery address for this cart is no longer available.");
    const selectedAddress = normalizeAddress(address);
    const addressSummary = [selectedAddress.type?.toLowerCase() === "saved address" ? "" : selectedAddress.type, selectedAddress.receiverName, selectedAddress.addressString].filter(Boolean).join(" · ");
    const food = { dish: currentSuggestion.dish || currentSuggestion.item, context: "ready_to_eat" };
    return await buildVerifiedSuggestion(mcp, { food, threadId, addressId: currentSuggestion.addressId, addressSummary, streamId, instruction, currentSuggestion, agentContext: { ...agentContext, deviceId: swiggySessionId } });
  } finally {
    await mcp.close().catch(() => {});
  }
}

async function buildVerifiedSuggestion(mcp, { food, threadId, addressId, addressSummary, streamId, instruction, currentSuggestion, agentContext = {} }) {
  const personalContext = agentContext.personalContext ?? currentSuggestion?.personalContext ?? "";
  const timeZone = agentContext.timeZone || currentSuggestion?.timeZone || "Asia/Kolkata";
  const temporalContext = currentTemporalContext(timeZone);
  const agentResult = await runFoodCartAgent(mcp, {
    food, addressId, addressSummary, streamId, threadId, instruction, currentSuggestion,
    personalContext, temporalContext, deviceId: agentContext.deviceId,
  });
  if (!currentSuggestion && !agentResult.cartUpdated) {
    throw new Error(`The cart agent could not find and add an orderable ${food.dish} match within its search budget. No Swiggy cart was changed.`);
  }
  let cart = await callStep(mcp, "get_food_cart", { addressId });
  const couponRestaurantId = resolveCartRestaurantId(cart) || agentResult.restaurantId;
  const promoSelectionMode = currentSuggestion?.promoSelectionMode || "auto";
  let coupon = resolveCouponCode(cart);
  let couponData = await loadCoupons(mcp, couponRestaurantId, addressId);
  let availablePromos = normalizeFoodCoupons(couponData, coupon, promoSelectionMode);
  if (!coupon && promoSelectionMode === "auto") {
    const applied = await applyBestVerifiedCoupon(mcp, {
      promos: availablePromos,
      addressId,
    });
    if (applied) {
      cart = applied.cart;
      coupon = applied.coupon;
    }
    couponData = await loadCoupons(mcp, couponRestaurantId, addressId);
    availablePromos = normalizeFoodCoupons(couponData, coupon, promoSelectionMode);
  }
  const verifiedAgentRationale = reconcileCouponRationale(
    agentResult.rationale,
    availablePromos,
    promoLookupStatus(couponData, availablePromos),
  );
  const restaurantMenu = await loadCartMenu(mcp, cart, agentResult.restaurantId, addressId);
  const receipt = normalizeCartReceipt(cart, extractVerifiedTotal(agentResult.rationale), restaurantMenu);
  const paymentOptions = await loadPaymentOptions(mcp, addressId, cart.availablePaymentMethods);
  if (receipt.finalAmount >= 1000) throw new Error("The personalized cart reaches Swiggy Builders Club’s ₹1,000 limit.");
  const rawItem = arrayAt(cart, "items")[0] || collectNamed(cart)[0];
  const item = receipt.items[0] || rawItem;
  if (!item) throw new Error("The Swiggy agent finished without an orderable item in the cart.");
  const restaurantName = await resolveRestaurantNameWithRetry(async (attempt) => {
    if (attempt === 0) {
      return [cart, restaurantMenu || rawItem || item, agentResult.rationale, agentResult.restaurantName];
    }
    publishAgentEvent(streamId, "metadata_retry", { target: "restaurant_name", attempt });
    const refreshedCart = await callStep(mcp, "get_food_cart", { addressId }).catch(() => cart);
    const refreshedMenu = await loadCartMenu(mcp, refreshedCart, agentResult.restaurantId, addressId);
    return [
      refreshedCart,
      refreshedMenu || restaurantMenu || rawItem || item,
      agentResult.rationale,
      agentResult.restaurantName,
    ];
  });
  const restaurantMetadata = resolveRestaurantLogo(cart, restaurantMenu)
    ? undefined
    : await loadRestaurantMetadataFallback(mcp, restaurantName, addressId);
  const restaurantRating = resolveRestaurantRating(cart, restaurantMenu, restaurantMetadata);
  const agentResponses = instruction
    ? [...(currentSuggestion?.agentResponses || []), {
      instruction,
      response: verifiedAgentRationale,
      prompt: agentResult.agentPrompt,
      followUp: agentResult.agentFollowUp,
      createdAt: new Date().toISOString(),
    }].slice(-4)
    : [];
  if (!restaurantName) throw new Error("Swiggy did not return the restaurant name for the verified cart.");
  return {
    threadId,
    conversationId: threadId,
    personalContext,
    timeZone: temporalContext.timeZone,
    dish: food.dish,
    restaurantId: agentResult.restaurantId,
    restaurant: restaurantName,
    restaurantLogoUrl: resolveRestaurantLogo(cart, restaurantMenu, restaurantMetadata),
    restaurantRating: restaurantRating.value,
    restaurantRatingCount: restaurantRating.count,
    restaurantLocation: resolveRestaurantLocation(cart, restaurantMenu, restaurantMetadata),
    item: item.name || item.title,
    price: receipt.subtotal,
    savings: receipt.discount,
    finalAmount: receipt.finalAmount,
    receipt,
    imageUrl: receipt.items[0]?.imageUrl || resolveItemImage(rawItem || item),
    deliveryEta: resolveDeliveryEta(cart) || resolveDeliveryEta(restaurantMenu) || resolveDeliveryEta(restaurantMetadata),
    coupon,
    cartMutationItems: agentResult.cartMutationItems,
    availablePromos,
    promoSelectionMode,
    promoLookupStatus: promoLookupStatus(couponData, availablePromos),
    addressId,
    deliveryAddress: addressSummary,
    availablePaymentMethods: availablePaymentMethods(paymentOptions),
    paymentOptions,
    rationale: instruction ? currentSuggestion?.rationale || verifiedAgentRationale : verifiedAgentRationale,
    agentPrompt: agentResult.agentPrompt,
    agentFollowUp: agentResult.agentFollowUp || null,
    agentResponses,
    dietaryNotes: ["Order history, variants, add-ons, and avoidances reviewed by the agent"],
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

export async function resolveRestaurantNameWithRetry(loadSources, { maxRetries = 2 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const sources = await loadSources(attempt);
      const name = resolveRestaurantName(...(Array.isArray(sources) ? sources : []));
      if (name) return name;
    } catch {
      // Metadata refreshes are read-only, so a failed attempt is safe to repeat.
    }
  }
  return "";
}

async function loadRestaurantMenu(mcp, restaurantId, addressId) {
  if (!restaurantId) return undefined;
  try { return await callStep(mcp, "get_restaurant_menu", { restaurantId, addressId }); }
  catch { return undefined; }
}

async function loadRestaurantMetadataFallback(mcp, restaurantName, addressId) {
  if (!restaurantName || !addressId) return undefined;
  try { return await callStep(mcp, "search_restaurants", { query: restaurantName, addressId }); }
  catch { return undefined; }
}

async function loadCartMenu(mcp, cart, restaurantId, addressId) {
  const compact = await loadRestaurantMenu(mcp, restaurantId, addressId);
  if (!restaurantId || !addressId) return compact;
  const itemNames = (findArray(cart, ["items", "cartItems", "orderItems"]) || [])
    .map((item) => String(item.name || item.title || item.itemName || "").trim())
    .filter(Boolean)
    .slice(0, 6);
  const details = (await Promise.all(itemNames.map(async (query) => {
    try {
      return await callStep(mcp, "search_menu", {
        addressId,
        query,
        restaurantIdOfAddedItem: restaurantId,
      });
    } catch {
      return undefined;
    }
  }))).filter(Boolean);
  return details.length ? { compact, details } : compact;
}

async function loadCoupons(mcp, restaurantId, addressId) {
  if (!restaurantId || !addressId) return undefined;
  try {
    const value = await callStep(mcp, "fetch_food_coupons", { restaurantId, addressId });
    const normalized = normalizeFoodCoupons(value);
    console.log(`[swiggy:coupon] normalized\n${JSON.stringify({
      inputType: Array.isArray(value) ? "array" : typeof value,
      couponCount: normalized.length,
      coupons: normalized.map((coupon) => ({
        code: coupon.code,
        applicable: coupon.applicable,
        selectable: coupon.selectable,
        requiresOnlinePayment: coupon.requiresOnlinePayment,
        discountAmount: coupon.discountAmount,
        minimumOrder: coupon.minimumOrder,
        ineligibilityReason: coupon.ineligibilityReason,
      })),
    }, null, 2)}`);
    return value;
  } catch (error) {
    console.warn("[swiggy:coupon] fetch_failed", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

export async function getRestaurantMenuItems(suggestion, swiggySessionId, query = "") {
  if (!swiggySessionId && !config.swiggyMcpAccessToken) throw new Error("Connect a real Swiggy account before browsing the menu.");
  if (!suggestion.restaurantId || !suggestion.addressId) throw new Error("This cart is missing its restaurant or delivery address.");
  const mcp = await connectSwiggyFood(swiggySessionId);
  try {
    const menu = query
      ? await callStep(mcp, "search_menu", {
        addressId: suggestion.addressId,
        query,
        restaurantIdOfAddedItem: suggestion.restaurantId,
      })
      : await callStep(mcp, "get_restaurant_menu", {
        restaurantId: suggestion.restaurantId,
        addressId: suggestion.addressId,
        page: 1,
        pageSize: 8,
      });
    return normalizeMenuCatalog(menu);
  } finally { await mcp.close().catch(() => {}); }
}

export async function mutatePersonalizedCart(currentSuggestion, mutation, swiggySessionId) {
  if (!swiggySessionId && !config.swiggyMcpAccessToken) throw new Error("Connect a real Swiggy account before editing the cart.");
  const mcp = await connectSwiggyFood(swiggySessionId);
  try {
    const { addressId, restaurantId, restaurant: restaurantName } = currentSuggestion;
    if (!addressId || !restaurantId) throw new Error("This cart is missing its restaurant or delivery address.");
    const cart = await callStep(mcp, "get_food_cart", { addressId, restaurantName });
    const rawItems = findArray(cart, ["items", "cartItems", "orderItems"]) || [];
    const mutationTemplates = Array.isArray(currentSuggestion.cartMutationItems) ? currentSuggestion.cartMutationItems : [];
    const nextItems = rawItems.map((item) => cartItemPayload(
      item,
      mutationTemplates.find((template) => resolveMenuItemId(template) === resolveMenuItemId(item)),
    ));

    if (mutation.action === "set_quantity") {
      const index = rawItems.findIndex((item) => resolveMenuItemId(item) === mutation.itemId);
      if (index < 0) throw new Error("That item is no longer in the Swiggy cart.");
      if (mutation.quantity === 0 && rawItems.length === 1) {
        await callStep(mcp, "flush_food_cart", {});
        return { deleted: true };
      }
      const currentQuantity = finiteNumber(rawItems[index].quantity ?? rawItems[index].qty ?? rawItems[index].count) || 1;
      if (mutation.quantity > currentQuantity && cartItemHasCustomizations(rawItems[index]) && !mutation.confirmSameCustomizations) {
        const error = new Error("Confirm whether the additional quantity should use the same customizations.");
        error.code = "CUSTOMIZATION_CONFIRMATION_REQUIRED";
        error.statusCode = 409;
        throw error;
      }
      if (mutation.quantity === 0) nextItems.splice(index, 1);
      else nextItems[index].quantity = mutation.quantity;
    } else {
      const compactMenu = await callStep(mcp, "get_restaurant_menu", { restaurantId, addressId, page: 1, pageSize: 8 });
      let menuItem = normalizeMenuCatalog(compactMenu).find((item) => item.id === mutation.itemId);
      let rawMenuItem = findRawMenuItem(compactMenu, mutation.itemId, mutation.itemName);
      if ((!menuItem || !menuItem.canQuickAdd || mutation.selections !== undefined) && mutation.itemName) {
        const searchResult = await callStep(mcp, "search_menu", {
          addressId,
          query: mutation.itemName,
          restaurantIdOfAddedItem: restaurantId,
        });
        const detailedItems = normalizeMenuCatalog(searchResult);
        menuItem = detailedItems.find((item) => item.id === mutation.itemId)
          || detailedItems.find((item) => sameMenuItemName(item.name, mutation.itemName));
        rawMenuItem = findRawMenuItem(searchResult, mutation.itemId, mutation.itemName);
      }
      if (!menuItem) throw new Error("That menu item is no longer available.");
      if (!menuItem.canQuickAdd && mutation.selections === undefined) {
        const error = new Error("This item requires variant or add-on choices before it can be added.");
        error.code = "ITEM_OPTIONS_REQUIRED";
        error.statusCode = 422;
        throw error;
      }
      const configuredItem = mutation.selections !== undefined
        ? configuredMenuItemPayload(rawMenuItem, mutation.selections)
        : { itemId: menuItem.id, quantity: 1 };
      const existing = nextItems.find((item) => item.itemId === menuItem.id && sameCartConfiguration(item, configuredItem));
      if (existing) existing.quantity += 1;
      else {
        if (configuredItem.addons?.length && configuredItemHasVariant(configuredItem)) {
          const variantOnlyItem = structuredClone(configuredItem);
          delete variantOnlyItem.addons;
          const stagedItems = [...nextItems, variantOnlyItem];
          const stagedCart = await callStep(mcp, "update_food_cart", {
            restaurantId, restaurantName, addressId, cartItems: stagedItems,
          });
          const validAddonIds = collectValidAddonIds(stagedCart);
          const selectedAddonIds = collectSelectionIds(configuredItem.addons.flatMap((group) => group.choices || []));
          if (validAddonIds.size && selectedAddonIds.some((id) => !validAddonIds.has(id))) {
            await callStep(mcp, "update_food_cart", {
              restaurantId, restaurantName, addressId, cartItems: nextItems,
            }).catch(() => {});
            throw new Error("One of those add-ons is unavailable for the selected variant. Choose a different combination.");
          }
        }
        nextItems.push(configuredItem);
      }
    }

    const mutationResult = await callStep(mcp, "update_food_cart", { restaurantId, restaurantName, addressId, cartItems: nextItems });
    const verifiedCart = await verifyCartMutation(mcp, {
      addressId, restaurantName, expectedItems: nextItems, mutationResult,
    });
    await reapplyPreferredCoupon(mcp, currentSuggestion);
    const refreshedCart = await callStep(mcp, "get_food_cart", { addressId, restaurantName });
    return await refreshSuggestion(
      mcp,
      { ...currentSuggestion, cartMutationItems: nextItems },
      cartReflectsItems(refreshedCart, nextItems) ? refreshedCart : verifiedCart,
    );
  } finally { await mcp.close().catch(() => {}); }
}

export async function selectPersonalizedCoupon(currentSuggestion, couponCode, swiggySessionId) {
  if (!swiggySessionId && !config.swiggyMcpAccessToken) throw new Error("Connect a real Swiggy account before applying a promo.");
  const mcp = await connectSwiggyFood(swiggySessionId);
  try {
    const appliedCart = await callStep(mcp, "apply_food_coupon", { couponCode, addressId: currentSuggestion.addressId });
    const refreshedCart = await callStep(mcp, "get_food_cart", {
      addressId: currentSuggestion.addressId,
      restaurantName: currentSuggestion.restaurant,
    });
    const verifiedCart = resolveAppliedCouponDiscount(refreshedCart) > 0 ? refreshedCart : appliedCart;
    if (resolveAppliedCouponDiscount(verifiedCart) <= 0) {
      throw new Error(`${couponCode} did not produce an applicable discount for this cart.`);
    }
    return await refreshSuggestion(
      mcp,
      { ...currentSuggestion, coupon: couponCode, promoSelectionMode: "manual" },
      verifiedCart,
    );
  } finally { await mcp.close().catch(() => {}); }
}

export async function getSavedAddresses(swiggySessionId) {
  if (!swiggySessionId && !config.swiggyMcpAccessToken) throw new Error("Connect a real Swiggy account to load addresses.");
  const mcp = await connectSwiggyFood(swiggySessionId);
  try {
    return (await loadAllAddresses(mcp)).map(normalizeAddress).filter((address) => address.id);
  } finally { await mcp.close().catch(() => {}); }
}

export async function placeOrder(suggestion, swiggySessionId, paymentMethod) {
  if (!swiggySessionId && !config.swiggyMcpAccessToken) throw new Error("Connect a real Swiggy account before placing an order.");
  const mcp = await connectSwiggyFood(swiggySessionId);
  try {
    if (!suggestion.addressId) throw new Error("The confirmed cart has no delivery address. Build the cart again.");
    const cart = await callStep(mcp, "get_food_cart", { addressId: suggestion.addressId, restaurantName: suggestion.restaurant });
    const total = Number(cart.total ?? cart.totalAmount ?? 0);
    if (total > 1000) throw new Error("Cart exceeds Swiggy Builders Club’s ₹1,000 limit.");
    const method = normalizePaymentChoice(paymentMethod);
    if (!method) throw new Error("Choose COD or UPI before confirming the order.");
    const option = suggestion.paymentOptions?.[method.toLowerCase()];
    if (!option?.available) throw new Error(`${method} is not available for this Swiggy cart.`);
    // Deliberately no generic retry: place_food_order is not idempotent.
    if (method === "UPI") {
      const raw = await callStep(mcp, "place_food_order", { addressId: suggestion.addressId, paymentMethod: option.code || "UPI", generateUPIQR: true });
      return { paymentMethod: method, payment: normalizePendingPayment(raw, suggestion) };
    }
    const order = await callStep(mcp, "place_food_order", { addressId: suggestion.addressId, paymentMethod: option.code || option.id || "COD" });
    return { paymentMethod: method, order };
  } finally {
    await mcp.close().catch(() => {});
  }
}

export async function checkUPIPayment(payment, swiggySessionId) {
  const mcp = await connectSwiggyFood(swiggySessionId);
  try {
    const raw = await callStep(mcp, "check_payment_status", paymentToolArgs(payment, true));
    return normalizePaymentStatus(raw);
  } finally { await mcp.close().catch(() => {}); }
}

export async function confirmUPIPayment(payment, swiggySessionId) {
  const mcp = await connectSwiggyFood(swiggySessionId);
  try {
    // Deliberately no retry: confirm_order finalizes a paid order.
    return await callStep(mcp, "confirm_order", paymentToolArgs(payment, false));
  } finally { await mcp.close().catch(() => {}); }
}

export function publicPayment(payment) {
  return {
    amount: payment.amount,
    upiString: payment.upiString,
    bridgeUrl: payment.bridgeUrl,
    expiresAt: payment.expiresAt,
  };
}

export function currentTemporalContext(requestedTimeZone, now = new Date()) {
  let timeZone = String(requestedTimeZone || "Asia/Kolkata").trim() || "Asia/Kolkata";
  // ICU accepts the older Asia/Calcutta alias. Store the current IANA name so
  // prompts, server logs, and observability metadata all agree.
  if (timeZone === "Asia/Calcutta") timeZone = "Asia/Kolkata";
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone }).format(now);
  } catch {
    timeZone = "Asia/Kolkata";
  }
  return {
    iso: now.toISOString(),
    timeZone,
    localDateTime: new Intl.DateTimeFormat("en-IN", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).format(now),
    dayOfWeek: new Intl.DateTimeFormat("en-IN", { timeZone, weekday: "long" }).format(now),
  };
}

export function resolveCouponCode(cart) {
  const directCode = firstValue(cart, [
    "couponCode", "coupon_code", "appliedCouponCode", "applied_coupon_code",
    "coupon.code", "coupon.couponCode", "coupon.coupon_code",
    "data.cart.couponCode", "data.cart.coupon_code", "data.cart.appliedCouponCode", "data.cart.applied_coupon_code",
    "cart.couponCode", "cart.coupon_code", "cart.appliedCouponCode", "cart.applied_coupon_code",
  ]);
  if (directCode) return String(directCode).trim();
  const offerCode = firstValue(cart, [
    "offers.coupon_applied.coupon_code", "offers.coupon_applied.couponCode",
    "offers.couponApplied.coupon_code", "offers.couponApplied.couponCode",
  ]);
  return offerCode && resolveAppliedCouponDiscount(cart) > 0 ? String(offerCode).trim() : "";
}

export function resolveAppliedCouponDiscount(cart) {
  return firstMoney(cart, ["couponDiscount", "couponSavings", "coupon_discount"])
    || firstMoney(cart?.offers?.coupon_applied, ["coupon_discount", "discountAmount"])
    || firstMoney(cart?.offers?.couponApplied, ["couponDiscount", "discountAmount"]);
}

function resolveCartRestaurantId(cart) {
  return firstValue(cart, [
    "restaurantId", "restaurant_id",
    "restaurant.id", "restaurant.restaurantId", "restaurant.restaurant_id",
    "restaurantInfo.id", "restaurantInfo.restaurantId", "restaurant_info.id", "restaurant_info.restaurant_id",
    "store.id", "store.restaurantId", "outlet.id", "outlet.restaurantId",
    "cart.restaurantId", "cart.restaurant_id", "data.cart.restaurantId", "data.cart.restaurant_id",
  ]);
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

async function loadPaymentOptions(mcp, addressId, cartMethods) {
  try { return normalizePaymentOptions(await callStep(mcp, "get_payment_options", { addressId }), cartMethods); }
  catch { return normalizePaymentOptions(undefined, cartMethods); }
}

export function normalizePaymentOptions(value, fallbackMethods = []) {
  const methods = [];
  for (const platform of Object.values(value?.platforms || {})) methods.push(...(Array.isArray(platform?.methods) ? platform.methods : []));
  if (Array.isArray(value?.allMethods)) methods.push(...value.allMethods);
  if (Array.isArray(value)) methods.push(...value);
  if (Array.isArray(fallbackMethods)) methods.push(...fallbackMethods);
  const normalized = methods.map((item) => typeof item === "string"
    ? { id: item, displayName: item, kind: "", code: item }
    : { id: item?.id || item?.method || item?.type || item?.name, displayName: item?.displayName || item?.name || item?.label, kind: String(item?.kind || "").toLowerCase(), code: item?.raw?.payment_code || item?.paymentCode || item?.code || item?.method });
  const upi = normalized.find((item) => item.kind === "qr")
    || normalized.find((item) => /upi|qr|paywithqr/i.test(`${item.id} ${item.displayName} ${item.code}`));
  const codEnvelope = value?.cod;
  const cod = codEnvelope?.available
    ? { id: codEnvelope.id || "COD", displayName: codEnvelope.displayName || "Cash on delivery", code: codEnvelope.id || "COD" }
    : normalized.find((item) => /(^|\b)(cod|cash)(\b|$)/i.test(`${item.id} ${item.displayName} ${item.code}`));
  return {
    upi: { available: Boolean(upi), id: upi?.id || "", label: upi?.displayName || "UPI", code: upi?.code || (upi ? "UPI" : "") },
    cod: { available: Boolean(cod), id: cod?.id || "", label: cod?.displayName || "Cash on delivery", code: cod?.code || cod?.id || "" },
  };
}

function availablePaymentMethods(options) {
  return [options.upi.available && "UPI", options.cod.available && "COD"].filter(Boolean);
}

function normalizePaymentChoice(value) {
  const method = String(value || "").trim().toUpperCase();
  if (method === "CASH") return "COD";
  return ["COD", "UPI"].includes(method) ? method : "";
}

export function normalizePendingPayment(value, suggestion, now = Date.now()) {
  const orderId = scalar(value, ["orderId", "order_id"]);
  const paasId = scalar(value, ["paasId", "paas_id", "transactionId", "transaction_id"]);
  const upiString = scalar(value, ["upiIntentUrl", "upiIntent", "upiString", "qrString", "qr", "intentUrl"]);
  if ((!orderId && !paasId) || !upiString) throw new Error("Swiggy did not return a usable UPI payment request. No order was confirmed.");
  const maxPollMs = moneyScalar(value, ["maxTimeToPollForInMs", "max_time_to_poll_for_in_ms"]);
  return {
    orderId: String(orderId || ""), paasId: String(paasId || ""), upiString: String(upiString),
    bridgeUrl: String(scalar(value, ["bridgeUrl", "bridge_url"]) || ""),
    cartId: String(scalar(value, ["cartId", "cart_id"]) || ""),
    addressId: suggestion.addressId,
    lat: numberScalar(value, ["lat", "latitude"]), lng: numberScalar(value, ["lng", "longitude"]),
    amount: moneyScalar(value, ["paidAmount", "amount", "toPay", "to_pay"]) || suggestion.finalAmount,
    expiresAt: new Date(now + (maxPollMs > 0 ? maxPollMs : 5 * 60_000)).toISOString(),
  };
}

function paymentToolArgs(payment, includePaasId) {
  return {
    ...(includePaasId && payment.paasId ? { paasId: payment.paasId } : {}),
    orderId: payment.orderId, addressId: payment.addressId,
    cartId: payment.cartId, lat: payment.lat, lng: payment.lng,
  };
}

export function normalizePaymentStatus(value) {
  let raw = "";
  walk(value, (key, child) => { if (!raw && /^(status|paymentStatus|state)$/i.test(key) && typeof child === "string") raw = child; });
  const status = raw.toUpperCase();
  if (/SUCCESS|PAID|COMPLETED|PLACED/.test(status)) return "paid";
  if (/FAIL|TIMEOUT|CANCEL|ERROR/.test(status)) return "failed";
  return "pending";
}

function scalar(value, keys) {
  return firstValue(value, keys) || deepScalar(value, keys.map((key) => key.replace(/[_\s-]/g, "").toLowerCase()));
}

function numberScalar(value, keys) {
  const number = Number(scalar(value, keys));
  return Number.isFinite(number) ? number : 0;
}

function moneyScalar(value, keys) {
  const raw = scalar(value, keys);
  const number = typeof raw === "string" ? Number(raw.replace(/[^\d.-]/g, "")) : Number(raw);
  return Number.isFinite(number) ? number : 0;
}

export function resolveRestaurantName(cart, item, rationale = "", selectedRestaurantName = "") {
  const name = [
    firstValue(cart, [
      "restaurantName", "restaurant_name", "restaurant.name", "restaurantInfo.name", "restaurant_info.name",
      "restaurantDetails.name", "restaurant_details.name", "store.name", "outlet.name", "outletName", "outlet_name",
    ]),
    findRestaurantName(cart),
    firstValue(item, ["restaurantName", "restaurant_name", "restaurant.name", "restaurantInfo.name", "restaurant_info.name", "outletName", "outlet_name"]),
    findRestaurantName(item),
    selectedRestaurantName,
  ].map(validRestaurantName).find(Boolean);
  if (name) return name;
  const text = String(rationale);
  const rationaleName = text.match(/restaurant choice\s*:\s*(?:\*\*)?([^\n*]+?)(?:\*\*)?\s+(?:was|is|—|-)/i)?.[1]?.trim()
    || text.match(/\bfrom\s+(?:\*\*)?([^\n*]+?)(?:\*\*)?(?:\n|$|\s[-–—]\s)/i)?.[1]?.trim();
  return validRestaurantName(rationaleName);
}

function validRestaurantName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || /^(?:swiggy\s+)?restaurant(?:\s+name)?$/i.test(name)) return "";
  if (name.length > 120 || name.split(/\s+/).length > 14 || /[\r\n]/.test(name)) return "";
  if (/\b(?:to proceed|please (?:select|choose|confirm)|would you|your existing cart|available alternatives|keep the current cart|which (?:option|one))\b/i.test(name)) return "";
  return name;
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

async function refreshSuggestion(mcp, currentSuggestion, verifiedCart) {
  const { addressId, restaurantId, restaurant: restaurantName } = currentSuggestion;
  const cart = verifiedCart || await callStep(mcp, "get_food_cart", { addressId, restaurantName });
  const menu = await loadCartMenu(mcp, cart, restaurantId, addressId);
  const receipt = normalizeCartReceipt(cart, 0, menu);
  if (!receipt.items.length) throw new Error("The Swiggy cart is empty.");
  const paymentOptions = await loadPaymentOptions(mcp, addressId, cart.availablePaymentMethods);
  const coupon = resolveCouponCode(cart) || currentSuggestion.coupon;
  const couponData = await loadCoupons(mcp, restaurantId, addressId);
  const availablePromos = normalizeFoodCoupons(couponData, coupon, currentSuggestion.promoSelectionMode);
  const resolvedRestaurantName = resolveRestaurantName(cart, menu, "", restaurantName) || restaurantName;
  const restaurantMetadata = resolveRestaurantLogo(cart, menu)
    ? undefined
    : await loadRestaurantMetadataFallback(mcp, resolvedRestaurantName, addressId);
  const restaurantRating = resolveRestaurantRating(cart, menu, restaurantMetadata);
  return {
    ...currentSuggestion,
    restaurant: resolvedRestaurantName,
    restaurantLogoUrl: resolveRestaurantLogo(cart, menu, restaurantMetadata) || currentSuggestion.restaurantLogoUrl,
    restaurantRating: restaurantRating.value || currentSuggestion.restaurantRating,
    restaurantRatingCount: restaurantRating.count || currentSuggestion.restaurantRatingCount,
    restaurantLocation: resolveRestaurantLocation(cart, menu, restaurantMetadata) || currentSuggestion.restaurantLocation,
    item: receipt.items[0].name,
    imageUrl: receipt.items[0].imageUrl,
    price: receipt.subtotal,
    savings: receipt.discount,
    finalAmount: receipt.finalAmount,
    cartLimitExceeded: receipt.finalAmount >= 1000,
    receipt,
    deliveryEta: resolveDeliveryEta(cart) || resolveDeliveryEta(menu) || resolveDeliveryEta(restaurantMetadata) || currentSuggestion.deliveryEta,
    coupon,
    availablePromos,
    promoLookupStatus: promoLookupStatus(couponData, availablePromos),
    availablePaymentMethods: availablePaymentMethods(paymentOptions),
    paymentOptions,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

async function reapplyPreferredCoupon(mcp, suggestion) {
  const couponData = await loadCoupons(mcp, suggestion.restaurantId, suggestion.addressId);
  const promos = normalizeFoodCoupons(couponData, suggestion.coupon, suggestion.promoSelectionMode);
  if (suggestion.promoSelectionMode === "manual") {
    const preferred = promos.find((promo) => promo.code === suggestion.coupon && promo.selectable);
    if (!preferred) return;
    try { await callStep(mcp, "apply_food_coupon", { couponCode: preferred.code, addressId: suggestion.addressId }); }
    catch { /* Cart remains valid even when a previously eligible promo changes. */ }
    return;
  }
  await applyBestVerifiedCoupon(mcp, { promos, addressId: suggestion.addressId });
}

export async function applyBestVerifiedCoupon(mcp, { promos = [], addressId } = {}) {
  if (!mcp || !addressId) return undefined;
  const candidates = rankedSelectablePromos(promos);
  for (const promo of candidates) {
    try {
      const appliedCart = await callStep(mcp, "apply_food_coupon", { couponCode: promo.code, addressId });
      const refreshedCart = await callStep(mcp, "get_food_cart", { addressId });
      const verifiedCart = resolveAppliedCouponDiscount(refreshedCart) > 0 ? refreshedCart : appliedCart;
      if (resolveAppliedCouponDiscount(verifiedCart) > 0) {
        return { cart: verifiedCart, coupon: resolveCouponCode(verifiedCart) || promo.code };
      }
    } catch {
      // Swiggy can mark a coupon as applicable in the listing and still reject
      // it during apply. Try the next selectable offer before giving up.
    }
  }
  return undefined;
}

function rankedSelectablePromos(promos = []) {
  return [...(Array.isArray(promos) ? promos : [])]
    .filter((promo) => promo?.code && promo.selectable)
    .sort((left, right) => Number(right.bestMatch) - Number(left.bestMatch)
      || couponValue(right) - couponValue(left)
      || Number(left.minimumOrder || 0) - Number(right.minimumOrder || 0));
}

function cartItemPayload(item, template) {
  const payload = {
    itemId: resolveMenuItemId(item),
    quantity: finiteNumber(item.quantity ?? item.qty ?? item.count) || 1,
  };
  if (template && typeof template === "object") Object.assign(payload, structuredClone(template), {
    itemId: resolveMenuItemId(item),
    quantity: finiteNumber(item.quantity ?? item.qty ?? item.count) || 1,
  });
  for (const key of ["variants", "variations", "variantsV2", "addons", "addOns"]) {
    if (Array.isArray(item?.[key]) && item[key].length) payload[key] = item[key];
  }
  return payload;
}

function cartItemHasCustomizations(item) {
  return ["variants", "variations", "variantsV2", "addons", "addOns", "customizations", "selectedVariants", "selectedAddons"].some((key) => Array.isArray(item?.[key]) && item[key].length)
    || collectCustomizationNames(item).length > 0;
}

export function normalizeMenuCatalog(menu) {
  const seen = new Set();
  const items = [];
  for (const item of collectNamed(menu)) {
    const id = resolveMenuItemId(item);
    const name = String(item.name || item.title || item.itemName || "").trim();
    const price = money(item.price ?? item.defaultPrice ?? item.finalPrice ?? item.offerPrice);
    const optionGroups = normalizeMenuOptionGroups(item);
    const hasVariants = Boolean(item.hasVariants || item.has_variants || item.hasVariations || item.has_variations
      || optionGroups.some((group) => group.kind === "variant"));
    const hasAddons = Boolean(item.hasAddons || item.has_addons || optionGroups.some((group) => group.kind === "addon"));
    if (!id || !name || seen.has(id) || (!price && !hasVariants && !hasAddons && !item.itemAttribute && !item.description)) continue;
    seen.add(id);
    items.push({
      id,
      name,
      description: resolveItemDescription(item),
      dietaryType: resolveDietaryType(item),
      imageUrl: resolveItemImage(item),
      rating: resolveProductRating(item).value,
      ratingCount: resolveProductRating(item).count,
      price,
      hasVariants,
      hasAddons,
      canQuickAdd: !hasVariants && !hasAddons,
      optionGroups,
    });
  }
  return items.slice(0, 80);
}

export function normalizeMenuOptionGroups(item) {
  return collectMenuOptionGroups(item).map(({ raw: _raw, rawChoices: _rawChoices, ...group }) => ({
    ...group,
    choices: group.choices.map(({ raw: _choiceRaw, ...choice }) => choice),
  }));
}

export function configuredMenuItemPayload(item, selections) {
  if (!item) throw new Error("Swiggy did not return customization details for this item.");
  const groups = collectMenuOptionGroups(item);
  if (!groups.length) throw new Error("Swiggy did not return selectable options for this item.");
  const selectedByGroup = new Map();
  const groupKey = (group) => `${group.kind}:${group.format}:${group.id}`;
  for (const selection of selections || []) {
    const group = groups.find((candidate) => candidate.kind === selection.kind
      && candidate.format === selection.format && candidate.id === selection.groupId);
    const choice = group?.choices.find((candidate) => candidate.id === selection.choiceId);
    if (!group || !choice || choice.available === false) throw new Error("One of the selected item options is no longer available.");
    const selected = selectedByGroup.get(groupKey(group)) || [];
    if (!selected.some((candidate) => candidate.id === choice.id)) selected.push(choice);
    selectedByGroup.set(groupKey(group), selected);
  }
  for (const group of groups) {
    const count = (selectedByGroup.get(groupKey(group)) || []).length;
    if (count < group.minSelections || count > group.maxSelections) {
      throw new Error(`${group.name} requires ${selectionRequirement(group)}.`);
    }
  }
  const payload = { itemId: resolveMenuItemId(item), quantity: 1 };
  for (const format of ["variants", "variations", "variantsV2"]) {
    const chosen = groups.filter((group) => group.format === format)
      .flatMap((group) => (selectedByGroup.get(groupKey(group)) || []).map((choice) => {
        const value = structuredClone(choice.raw);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          if (!firstValue(value, ["groupId", "group_id", "variationGroupId", "variation_group_id"])) value.groupId = group.id;
          return value;
        }
        return { groupId: group.id, id: choice.id, name: choice.name };
      }));
    if (chosen.length) payload[format] = chosen;
  }
  const addonGroups = groups.filter((group) => group.format === "addons" && (selectedByGroup.get(groupKey(group)) || []).length);
  if (addonGroups.length) {
    payload.addons = addonGroups.map((group) => {
      const choices = (selectedByGroup.get(groupKey(group)) || []).map((choice) => structuredClone(choice.raw));
      const base = group.raw && typeof group.raw === "object" && !Array.isArray(group.raw) ? structuredClone(group.raw) : {};
      for (const key of ["choices", "options", "addons", "items", "values"]) {
        if (Array.isArray(base[key])) delete base[key];
      }
      return { ...base, groupId: firstValue(base, ["groupId", "group_id", "id"]) || group.id, choices };
    });
  }
  return payload;
}

function collectMenuOptionGroups(item) {
  const groups = [];
  const sources = [
    ["variants", "variant", structuredOptionValue(item?.variants)],
    ["variations", "variant", structuredOptionValue(item?.variations)],
    ["variantsV2", "variant", structuredOptionValue(item?.variantsV2)],
    ["addons", "addon", structuredOptionValue(item?.addons ?? item?.addOns)],
  ];
  for (const [format, kind, source] of sources) {
    if (!source || typeof source !== "object") continue;
    const containers = optionContainers(source, format);
    containers.forEach((group, index) => {
      const rawChoices = optionChoices(group, containers.length === 1 ? source : undefined);
      if (!rawChoices.length) return;
      const id = String(firstValue(group, ["groupId", "group_id", "variationGroupId", "variation_group_id", "id"]) || `${format}:${index}`);
      const explicitMin = finiteNumber(firstValue(group, ["minSelections", "min_selections", "minAddons", "min_addons", "minimum", "min"]));
      const explicitMax = finiteNumber(firstValue(group, ["maxSelections", "max_selections", "maxAddons", "max_addons", "maximum", "max"]));
      const minSelections = explicitMin ?? (kind === "variant" ? 1 : booleanValue(firstValue(group, ["required", "isRequired", "is_required"])) ? 1 : 0);
      const maxSelections = Math.max(minSelections, explicitMax ?? (kind === "variant" ? 1 : rawChoices.length));
      const choices = rawChoices.map((choice, choiceIndex) => ({
        id: String(firstValue(choice, ["variationId", "variation_id", "choiceId", "choice_id", "addonId", "addon_id", "id", "value"]) || `${id}:${choiceIndex}`),
        name: String(firstValue(choice, ["name", "title", "label", "displayName", "display_name", "value"]) || `Option ${choiceIndex + 1}`).trim(),
        price: money(firstValue(choice, ["price", "additionalPrice", "additional_price", "defaultPrice", "default_price"])),
        available: !["false", "0", "no"].includes(String(firstValue(choice, ["inStock", "in_stock", "isEnabled", "is_enabled", "available"]) ?? true).toLowerCase()),
        defaultSelected: booleanValue(firstValue(choice, ["default", "isDefault", "is_default", "selected", "isSelected"])),
        raw: choice,
      }));
      groups.push({
        id,
        name: String(firstValue(group, ["groupName", "group_name", "name", "title", "label"]) || (kind === "variant" ? "Choose an option" : "Add-ons")).trim(),
        kind,
        format,
        minSelections,
        maxSelections,
        choices,
        raw: group,
        rawChoices,
      });
    });
  }
  return groups;
}

function optionContainers(source, format) {
  if (!Array.isArray(source)) {
    for (const key of ["variantGroups", "variant_groups", "groups", "addonGroups", "addon_groups"]) {
      if (Array.isArray(source[key])) return source[key];
    }
    if (optionChoices(source).length) return [source];
    const nested = [];
    walkOptionObjects(source, (candidate) => {
      if (candidate !== source && optionChoices(candidate).length) nested.push(candidate);
    });
    return nested;
  }
  if (!source.length) return [];
  const looksGrouped = source.some((entry) => ["choices", "options", "variations", "variants", "addons", "items", "values", "variantOptions", "variant_options", "addonChoices", "addon_choices"]
    .some((key) => Array.isArray(entry?.[key])));
  return looksGrouped ? source : [{ id: `${format}:0`, name: format === "addons" ? "Add-ons" : "Choose an option", choices: source }];
}

function optionChoices(group, fallback) {
  for (const value of [group, fallback]) {
    if (!value || typeof value !== "object") continue;
    for (const key of ["choices", "options", "variations", "variants", "addons", "items", "values", "variantOptions", "variant_options", "addonChoices", "addon_choices"]) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return [];
}

function selectionRequirement(group) {
  if (group.minSelections === group.maxSelections) return `${group.minSelections} selection${group.minSelections === 1 ? "" : "s"}`;
  if (!group.minSelections) return `up to ${group.maxSelections} selections`;
  return `${group.minSelections}–${group.maxSelections} selections`;
}

function structuredOptionValue(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return undefined;
  try { return JSON.parse(trimmed); }
  catch { return undefined; }
}

function walkOptionObjects(value, visit, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (!Array.isArray(value)) visit(value);
  for (const child of Object.values(value)) walkOptionObjects(child, visit, seen);
}

function findRawMenuItem(menu, itemId, itemName) {
  const items = collectNamed(menu);
  return items.find((item) => resolveMenuItemId(item) === String(itemId))
    || items.find((item) => sameMenuItemName(item.name || item.title || item.itemName, itemName));
}

function sameMenuItemName(left, right) {
  const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return Boolean(normalize(left)) && normalize(left) === normalize(right);
}

function sameCartConfiguration(left, right) {
  return ["variants", "variations", "variantsV2", "addons"].every((key) =>
    JSON.stringify(left?.[key] || []) === JSON.stringify(right?.[key] || []));
}

async function verifyCartMutation(mcp, { addressId, restaurantName, expectedItems, mutationResult }) {
  if (cartReflectsItems(mutationResult, expectedItems)) return mutationResult;
  for (const delayMs of [0, 250, 750, 1500, 3000]) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const cart = await callStep(mcp, "get_food_cart", { addressId, restaurantName });
    if (cartReflectsItems(cart, expectedItems)) return cart;
  }
  throw new Error("Swiggy did not confirm the cart update. Please try again.");
}

function configuredItemHasVariant(item) {
  return ["variants", "variations", "variantsV2"].some((key) => Array.isArray(item?.[key]) && item[key].length);
}

function collectValidAddonIds(value, ids = new Set(), insideValidAddons = false) {
  if (!value || typeof value !== "object") return ids;
  if (Array.isArray(value)) {
    for (const child of value) collectValidAddonIds(child, ids, insideValidAddons);
    return ids;
  }
  for (const [key, child] of Object.entries(value)) {
    const valid = insideValidAddons || /valid.?addons/i.test(key);
    if (valid && /^(?:id|addonId|addon_id|choiceId|choice_id)$/.test(key) && child !== undefined && child !== null) {
      ids.add(String(child));
    }
    collectValidAddonIds(child, ids, valid);
  }
  return ids;
}

function collectSelectionIds(value, ids = []) {
  if (!value || typeof value !== "object") return ids;
  if (Array.isArray(value)) {
    for (const child of value) collectSelectionIds(child, ids);
    return ids;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:id|addonId|addon_id|choiceId|choice_id)$/.test(key) && child !== undefined && child !== null) ids.push(String(child));
    else collectSelectionIds(child, ids);
  }
  return [...new Set(ids)];
}

export function normalizeFoodCoupons(value, appliedCode = "", selectionMode = "auto") {
  const candidates = collectCouponObjects(value);
  const promos = [];
  const seen = new Set();
  for (const coupon of candidates) {
    const code = resolveCouponListCode(coupon);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const status = String(firstValue(coupon, ["status", "applicabilityStatus", "applicability_status"]) || "").toLowerCase();
    const explicitApplicable = firstValue(coupon, ["isApplicable", "is_applicable", "applicable", "isValid", "is_valid"]);
    const subtitle = String(firstValue(coupon, ["subtitle", "subTitle"]) || "").trim();
    const implicitIneligible = /(?:not.?applicable|invalid|locked|ineligible|expired|add\s*₹?\s*[\d,]+(?:\.\d+)?\s+more|minimum|above\s+rs?\.?\s*[\d,]+)/i.test(`${status} ${subtitle}`);
    const applicable = explicitApplicable === undefined
      ? !implicitIneligible
      : !["false", "0", "no"].includes(String(explicitApplicable).trim().toLowerCase());
    const requiresOnlinePayment = booleanValue(firstValue(coupon, ["requiresOnlinePayment", "requires_online_payment", "onlinePaymentOnly", "online_payment_only"]));
    const ineligibilityReason = String(firstValue(coupon, [
      "ineligibilityReason", "ineligibility_reason", "nonApplicableReason", "non_applicable_reason",
      "errorMessage", "error_message", "message",
    ]) || (!applicable ? subtitle : "")).trim();
    promos.push({
      code,
      title: String(firstValue(coupon, ["title", "name", "displayName", "display_name", "header", "offerTitle", "offer_title"]) || code).trim(),
      description: String(firstValue(coupon, [
        "description", "shortDescription", "short_description", "longDescription", "long_description",
        "subtitle", "subTitle", "offerDescription", "offer_description", "terms",
      ]) || "").trim(),
      discountAmount: money(firstValue(coupon, ["discountAmount", "discount_amount", "couponDiscount", "coupon_discount", "maxDiscount", "max_discount", "savings"])),
      minimumOrder: money(firstValue(coupon, ["minimumOrder", "minimum_order", "minOrderValue", "min_order_value", "minimumCartValue", "minimum_cart_value"])),
      applicable,
      selectable: applicable && !requiresOnlinePayment,
      requiresOnlinePayment,
      ineligibilityReason,
      selected: code === String(appliedCode || "").trim().toUpperCase(),
      bestMatch: Boolean(firstValue(coupon, ["isBestCoupon", "is_best_coupon", "bestCoupon", "best_coupon", "isBest", "is_best"])),
    });
  }
  const eligible = promos.filter((promo) => promo.selectable);
  const autoSelected = selectionMode === "auto" ? eligible.find((promo) => promo.selected) : undefined;
  if (autoSelected) {
    for (const promo of promos) promo.bestMatch = promo === autoSelected;
  } else if (eligible.length && !eligible.some((promo) => promo.bestMatch)) {
    eligible.sort((a, b) => b.discountAmount - a.discountAmount || a.minimumOrder - b.minimumOrder)[0].bestMatch = true;
  }
  return promos;
}

function resolveCouponListCode(coupon) {
  const explicit = firstValue(coupon, [
    "couponCode", "coupon_code", "code", "offerCode", "offer_code",
    "coupon.code", "coupon.couponCode", "coupon.coupon_code",
  ]);
  if (explicit) return normalizeCouponListCode(explicit);
  const title = firstValue(coupon, ["title"]);
  const candidate = normalizeCouponListCode(title);
  return /^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(candidate) ? candidate : "";
}

function normalizeCouponListCode(value) {
  return String(value || "").trim().toUpperCase();
}

function collectCouponObjects(value, found = [], seen = new Set(), parentKey = "") {
  if (!value) return found;
  if (typeof value === "string") {
    const serialized = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    if (/^[{[]/.test(serialized)) {
      try { return collectCouponObjects(JSON.parse(serialized), found, seen, parentKey); }
      catch { /* Fall through to Swiggy's human-readable coupon format. */ }
    }
    found.push(...parseCouponText(serialized));
    return found;
  }
  if (typeof value !== "object" || seen.has(value)) return found;
  seen.add(value);
  const isCartSuggestion = /^(?:coupon_?applied|applied_?coupon)$/i.test(parentKey);
  if (!isCartSuggestion && !Array.isArray(value) && resolveCouponListCode(value)) found.push(value);
  for (const [key, child] of Object.entries(value)) collectCouponObjects(child, found, seen, key);
  return found;
}

function parseCouponText(value) {
  const coupons = [];
  let section = "";
  for (const rawLine of String(value || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.match(/^\*\*(.+)\*\*$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const match = line.match(/^-\s+([A-Z0-9_-]+)\s+\[(✅|❌)\s+(APPLICABLE|NOT APPLICABLE)\]\s+[—-]\s+(.+)$/i);
    if (!match) continue;
    const description = match[4].replace(/\s+\(code:\s*[^)]+\)\s*$/i, "").trim();
    const applicable = !/^NOT\s+/i.test(match[3]);
    const discountMatch = description.match(/(?:save|flat)\s*₹\s*([\d,]+(?:\.\d+)?)/i);
    coupons.push({
      couponCode: match[1],
      description,
      isApplicable: applicable,
      ineligibilityReason: applicable ? "" : description,
      requiresOnlinePayment: /payment offer|online|card|upi/i.test(`${section} ${description}`),
      discountAmount: discountMatch ? Number(discountMatch[1].replace(/,/g, "")) : 0,
      isBestCoupon: /best coupon/i.test(section),
    });
  }
  return coupons;
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["true", "1", "yes"].includes(String(value || "").trim().toLowerCase());
}

export function normalizeCartReceipt(cart, verifiedTotal = 0, catalog) {
  const itemSource = findArray(cart, ["items", "cartItems", "orderItems"]) || [];
  const items = itemSource.map((item) => {
    const catalogItem = findMatchingCatalogItem(catalog, item);
    const itemDetails = catalogItem ? { ...catalogItem, ...item } : item;
    const description = [resolveItemDescription(item), resolveItemDescription(catalogItem)]
      .filter(Boolean)
      .sort((left, right) =>
        descriptionCompleteness(right) - descriptionCompleteness(left) || right.length - left.length
      )[0] || "";
    const quantity = finiteNumber(item.quantity ?? item.qty ?? item.count) || 1;
    const originalUnitPrice = money(item.originalPrice ?? item.defaultPrice ?? item.price ?? item.unitPrice ?? item.itemPrice);
    const unitPrice = money(item.discountedPrice ?? item.sellingPrice ?? item.finalPrice ?? item.offerPrice ?? item.price ?? item.unitPrice ?? item.itemPrice);
    const total = money(item.discountedTotal ?? item.finalTotal ?? item.itemTotal ?? item.total ?? item.totalPrice) || unitPrice * quantity;
    const originalTotal = originalUnitPrice * quantity;
    const customizations = collectCustomizationNames(item);
    return {
      id: String(resolveMenuItemId(item) || resolveMenuItemId(catalogItem)),
      name: String(item.name || item.title || item.itemName || "Cart item"),
      description,
      dietaryType: resolveDietaryType(itemDetails),
      rating: resolveProductRating(itemDetails).value,
      ratingCount: resolveProductRating(itemDetails).count,
      quantity,
      unitPrice,
      originalUnitPrice,
      total,
      originalTotal,
      savings: Math.max(0, originalTotal - total),
      customizations,
      requiresQuantityConfirmation: cartItemHasCustomizations(item),
      imageUrl: resolveItemImage(itemDetails),
    };
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
  const itemSavings = items.reduce((sum, item) => sum + item.savings, 0);
  let discount = explicitDiscount + itemSavings;
  const chargeTotal = charges.reduce((sum, charge) => sum + charge.amount, 0);
  const structuredTotal = cartPayable(cart);
  const finalAmount = structuredTotal || verifiedTotal || Math.max(0, subtotal + chargeTotal - discount);
  charges = reconcileCharges(charges, Math.max(0, finalAmount - subtotal + discount));
  const reconciledChargeTotal = charges.reduce((sum, charge) => sum + charge.amount, 0);
  // Swiggy can return a payable total that already includes a platform/item
  // promotion without returning a separate couponDiscount field. Reconcile that
  // difference as savings so the bill equation remains transparent and exact.
  const inferredSavings = Math.max(0, subtotal + reconciledChargeTotal - discount - finalAmount);
  discount += inferredSavings;
  const discounts = [
    ...(itemSavings > 0 ? [{ label: "Item savings", amount: itemSavings, source: "item" }] : []),
    ...(explicitDiscount > 0 ? [{ label: "Coupon / offer savings", amount: explicitDiscount, source: "offer" }] : []),
    ...(inferredSavings > 0 ? [{ label: "Swiggy savings", amount: inferredSavings, source: "payable_reconciliation" }] : []),
  ];
  return { items, charges, discounts, subtotal, discount, finalAmount };
}

function promoLookupStatus(couponData, promos) {
  if (promos.length) return "available";
  return couponData === undefined ? "unavailable" : "empty";
}

export function reconcileCouponRationale(rationale, promos = [], lookupStatus = "unavailable") {
  const clean = String(rationale || "")
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/\b(?:coupon|promo(?:\s+code)?|fetch_food_coupons)\b/i.test(sentence))
    .join(" ")
    .trim();
  let couponFact;
  if (promos.length) {
    const codes = promos.map((promo) => promo.code).filter(Boolean).join(", ");
    couponFact = `Swiggy returned ${promos.length} available ${promos.length === 1 ? "offer" : "offers"}${codes ? `: ${codes}` : ""}.`;
  } else if (lookupStatus === "empty") {
    couponFact = "Swiggy returned no coupon entries for this verified cart.";
  } else {
    couponFact = "Coupon availability could not be verified because the Swiggy coupon lookup was unavailable.";
  }
  return [clean, couponFact].filter(Boolean).join(" ");
}

function findMatchingCatalogItem(catalog, cartItem) {
  if (!catalog) return undefined;
  const wantedIds = [cartItem?.id, cartItem?.itemId, cartItem?.item_id].filter((value) => value !== undefined && value !== null).map(String);
  const wantedName = String(cartItem?.name || cartItem?.title || cartItem?.itemName || "").trim().toLowerCase();
  const candidates = collectNamed(catalog);
  return candidates.find((candidate) => wantedIds.includes(String(candidate.id || candidate.itemId || candidate.item_id)))
    || candidates.find((candidate) => wantedName && String(candidate.name || candidate.title || candidate.itemName || "").trim().toLowerCase() === wantedName);
}

export function resolveItemImage(item) {
  const raw = firstValue(item, ["imageUrl", "image_url", "thumbnailUrl", "thumbnail_url", "image.url", "image.src", "media.imageUrl", "cloudinaryImageId", "cloudinary_image_id", "imageId", "image_id"])
    || deepScalar(item, ["imageurl", "thumbnailurl", "cloudinaryimageid", "imageid"]);
  if (!raw) return undefined;
  const value = String(raw).trim();
  if (/^https:\/\//i.test(value)) return value;
  if (/^[\w/-]+$/.test(value)) return `https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto,w_512/${value}`;
}

function swiggyImageUrl(raw, width = 512) {
  if (!raw) return undefined;
  const value = String(raw).trim();
  if (/^\/\//.test(value)) return `https:${value}`;
  if (/^http:\/\/media-assets\.swiggy\.com\//i.test(value)) return value.replace(/^http:/i, "https:");
  if (/^https:\/\//i.test(value)) return value;
  if (/^[\w/.-]+$/.test(value)) return `https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto,w_${width}/${value}`;
}

export function resolveRestaurantLogo(...sources) {
  for (const source of sources) {
    for (const candidate of [source, findRestaurantMetadata(source)]) {
      const raw = firstValue(candidate, [
        "restaurantLogo", "restaurant_logo", "restaurant.logo", "restaurant.logoUrl", "restaurant.logo_url",
        "restaurant.imageUrl", "restaurant.image_url", "restaurant.imageId", "restaurant.image_id", "restaurant.cloudinaryImageId", "restaurant.cloudinary_image_id",
        "restaurantInfo.logo", "restaurantInfo.logoUrl", "restaurantInfo.imageUrl", "restaurantInfo.imageId", "restaurantInfo.cloudinaryImageId",
        "restaurantDetails.logo", "restaurantDetails.logoUrl", "restaurantDetails.imageUrl", "restaurantDetails.imageId", "restaurantDetails.cloudinaryImageId",
        "store.logo", "store.logoUrl", "store.imageId", "outlet.logo", "outlet.logoUrl", "outlet.imageId", "outlet.cloudinaryImageId",
        "info.logo", "info.logoUrl", "info.imageUrl", "info.imageId", "info.cloudinaryImageId",
        "logo", "logoUrl", "imageUrl", "imageId", "cloudinaryImageId",
      ]) || deepScalarInRestaurant(candidate, ["restaurantlogo", "logourl", "restaurantimage", "restaurantimageid", "imageurl", "imageid", "cloudinaryimageid"]);
      const url = swiggyImageUrl(raw, 192);
      if (url) return url;
    }
  }
}

export function resolveRestaurantRating(...sources) {
  for (const source of sources) {
    for (const candidate of [source, findRestaurantMetadata(source)]) {
      const value = numericRating(firstValue(candidate, [
        "restaurantRating", "restaurant_rating", "restaurant.rating", "restaurant.avgRating", "restaurant.avg_rating",
        "restaurantInfo.rating", "restaurantInfo.avgRating", "restaurantDetails.rating", "restaurantDetails.avgRating",
        "store.rating", "store.avgRating", "outlet.rating", "outlet.avgRating", "info.rating", "info.avgRating",
        "rating", "avgRating", "avg_rating",
      ]) || deepScalarInRestaurant(candidate, ["restaurantrating", "avgrating"]));
      const count = ratingCount(firstValue(candidate, [
        "restaurantRatingCount", "restaurant_rating_count", "restaurant.ratingCount", "restaurant.rating_count",
        "restaurant.ratingsCount", "restaurant.totalRatings", "restaurantInfo.ratingCount", "restaurantInfo.totalRatings",
        "restaurantDetails.ratingCount", "restaurantDetails.totalRatings", "store.ratingCount", "outlet.ratingCount",
        "info.ratingCount", "info.totalRatings", "ratingCount", "ratingsCount", "totalRatings",
      ]) || deepScalarInRestaurant(candidate, ["restaurantratingcount", "ratingcount", "ratingscount", "totalratings"]));
      if (value) return { value, count };
    }
  }
  return { value: 0, count: 0 };
}

export function resolveRestaurantLocation(...sources) {
  for (const source of sources) {
    for (const candidate of [source, findRestaurantMetadata(source)]) {
      const raw = firstValue(candidate, [
        "restaurantLocation", "restaurant_location", "restaurant.areaName", "restaurant.area_name", "restaurant.locality",
        "restaurantInfo.areaName", "restaurantInfo.locality", "restaurantDetails.areaName", "restaurantDetails.locality",
        "store.areaName", "store.locality", "outlet.areaName", "outlet.locality", "info.areaName", "info.locality",
        "areaName", "area_name", "locality",
      ]) || deepScalarInRestaurant(candidate, ["restaurantlocation", "areaname", "locality"]);
      if (raw) return String(raw).trim();
    }
  }
  return "";
}

function findRestaurantMetadata(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (!Array.isArray(value) && (value.name || value.title)
    && (value.areaName || value.locality || value.cuisines || value.sla)
    && (value.avgRating || value.rating || value.cloudinaryImageId || value.logo)) return value;
  for (const child of Object.values(value)) {
    const found = findRestaurantMetadata(child, seen);
    if (found) return found;
  }
}

export function resolveProductRating(item) {
  const value = numericRating(firstValue(item, [
    "rating", "avgRating", "avg_rating", "itemRating", "item_rating",
    "ratings.aggregatedRating.rating", "ratings.aggregated_rating.rating",
    "aggregatedRating.rating", "aggregated_rating.rating",
  ]));
  const count = ratingCount(firstValue(item, [
    "ratingCount", "rating_count", "ratingsCount", "ratings_count", "totalRatings", "total_ratings",
    "ratings.aggregatedRating.ratingCount", "ratings.aggregated_rating.rating_count",
    "aggregatedRating.ratingCount", "aggregated_rating.rating_count",
  ]));
  return { value, count };
}

function numericRating(value) {
  const parsed = Number.parseFloat(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 5 ? parsed : 0;
}

function ratingCount(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  const match = String(value || "").replace(/,/g, "").match(/[\d.]+/);
  if (!match) return 0;
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return /k/i.test(String(value)) ? Math.round(parsed * 1000) : Math.round(parsed);
}

function deepScalarInRestaurant(value, normalizedKeys) {
  if (!value || typeof value !== "object") return undefined;
  const containers = [
    value.restaurant, value.restaurantInfo, value.restaurant_info, value.restaurantDetails, value.restaurant_details,
    value.store, value.outlet, value.info, value.data?.restaurant, value.data?.restaurantInfo, value.data?.restaurantDetails,
    value.data?.store, value.data?.outlet, value.data?.info, value.cart?.restaurant, value.cart?.restaurantInfo,
    value.cart?.restaurantDetails, value.cart?.store, value.cart?.outlet,
  ].filter(Boolean);
  for (const container of containers) {
    const found = deepScalar(container, normalizedKeys);
    if (found !== undefined) return found;
  }
}

export function resolveItemDescription(item) {
  const candidates = [
    firstValue(item, ["longDescription", "long_description", "fullDescription", "full_description"]),
    firstValue(item, ["description", "itemDescription", "item_description"]),
    firstValue(item, ["details.description", "itemAttribute.description", "item_attribute.description"]),
    firstValue(item, ["shortDescription", "short_description"]),
    deepScalar(item, ["longdescription", "fulldescription", "itemdescription", "shortdescription"]),
  ].map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean);
  return candidates.sort((left, right) =>
    descriptionCompleteness(right) - descriptionCompleteness(left) || right.length - left.length
  )[0] || "";
}

function descriptionCompleteness(value) {
  return /(?:…|\.\.\.)\s*$/.test(value) ? 0 : 1;
}

export function resolveDietaryType(item) {
  const paths = [
    "isVeg", "is_veg", "veg", "vegetarian", "isVegetarian", "is_vegetarian",
    "dietaryType", "dietary_type", "foodType", "food_type", "vegClassifier", "veg_classifier",
    "itemAttribute.vegClassifier", "itemAttribute.veg_classifier", "itemAttribute.isVeg",
    "item_attribute.veg_classifier", "item_attribute.is_veg", "attributes.vegClassifier",
  ];
  let raw;
  for (const path of paths) {
    const value = path.split(".").reduce((current, key) => current?.[key], item);
    if (value !== undefined && value !== null && value !== "") { raw = value; break; }
  }
  if (raw === undefined) raw = deepScalar(item, ["isveg", "isvegetarian", "vegclassifier", "dietarytype", "foodtype"]);
  if (typeof raw === "boolean") return raw ? "veg" : "non_veg";
  if (typeof raw === "number") {
    if (raw === 1) return "veg";
    if (raw === 0) return "non_veg";
  }
  const value = String(raw || "").replace(/[\s-]+/g, "_").toLowerCase();
  if (["1", "true"].includes(value)) return "veg";
  if (["0", "false"].includes(value)) return "non_veg";
  if (/non_?veg|nonvegetarian|egg|meat/.test(value)) return "non_veg";
  if (/^(veg|vegetarian|pure_?veg)$/.test(value)) return "veg";
  return "";
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
