import { craveLensOrderIds } from "./analytics.js";
import { historyEvidence, readHistoryOrder } from "./preference-builder.js";
import { connectSwiggyFood } from "./swiggy-mcp.js";

const payload = (value) => value?.data && typeof value.data === "object" ? value.data : value;

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300);
  }
  return "";
}

function firstNumber(source, keys) {
  for (const key of keys) {
    const value = Number(source?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function extractItems(order) {
  const source = order?.order_items || order?.items || order?.orderItems || [];
  if (!Array.isArray(source)) return [];
  return source.map((item) => ({
    name: String(item?.name || item?.itemName || item?.description || "").trim().slice(0, 200),
    quantity: Math.max(1, Math.min(20, Number(item?.quantity || item?.qty) || 1)),
  })).filter((item) => item.name).slice(0, 20);
}

export function summarizeFoodOrder(raw, viaCraveLens = false) {
  const cleaned = historyEvidence(raw);
  const parsed = readHistoryOrder(cleaned);
  const order = parsed && typeof parsed === "object" ? parsed : (cleaned && typeof cleaned === "object" ? cleaned : {});
  const items = extractItems(order);
  const orderId = String(order.orderId || order.order_id || "").trim();
  const restaurant = firstString(order, ["restaurant", "restaurantName", "restaurant_name", "outletName"]);
  if (!orderId && !restaurant && !items.length) return undefined;
  return {
    orderId,
    restaurant,
    items,
    total: firstNumber(order, ["total", "order_total", "finalAmount", "orderTotal", "billTotal"]),
    status: firstString(order, ["status", "order_status", "orderStatus"]),
    placedAt: firstString(order, ["placedAt", "order_time", "orderTime", "orderedAt"]),
    viaCraveLens: Boolean(viaCraveLens),
  };
}

function pageFromCursor(cursor) {
  const page = Number(cursor || 1);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export async function listFoodOrders(deviceId, query = {}) {
  const addressId = String(query.addressId || "").trim();
  if (!addressId) throw Object.assign(new Error("Select a delivery address before loading order history."), { statusCode: 400 });
  const limit = Math.max(1, Math.min(20, Number(query.limit) || 20));
  const page = pageFromCursor(query.cursor);
  const mcp = await connectSwiggyFood(deviceId, { allowDeveloperFallback: false });
  try {
    const definitions = await mcp.listTools();
    const historyTool = definitions.find((tool) => tool.name === "get_food_orders");
    if (!historyTool) throw Object.assign(new Error("Order history is unavailable for this account"), { statusCode: 404 });
    const args = { addressId, activeOnly: false, orderCount: limit };
    if (historyTool.inputSchema?.properties?.page) args.page = page;
    const response = payload(await mcp.call(historyTool.name, args));
    const rows = Array.isArray(response?.orders) ? response.orders : [];
    const summaries = rows.map((row) => summarizeFoodOrder(row)).filter(Boolean).slice(0, limit);
    const known = await craveLensOrderIds(summaries.map((row) => row.orderId));
    return {
      orders: summaries.map((row) => ({ ...row, viaCraveLens: known.has(row.orderId) })),
      nextCursor: rows.length >= limit ? String(page + 1) : null,
    };
  } finally {
    await mcp.close().catch(() => {});
  }
}

export async function readFoodOrder(deviceId, orderId) {
  const id = String(orderId || "").trim();
  if (!id) throw Object.assign(new Error("Order id is required"), { statusCode: 400 });
  const mcp = await connectSwiggyFood(deviceId, { allowDeveloperFallback: false });
  try {
    const definitions = await mcp.listTools();
    const detailTool = definitions.find((tool) => tool.name === "get_food_order_details");
    const idField = Object.keys(detailTool?.inputSchema?.properties || {}).find((name) => /^(orderId|order_id)$/i.test(name));
    if (!detailTool || !idField) throw Object.assign(new Error("Order details are unavailable"), { statusCode: 404 });
    const raw = payload(await mcp.call(detailTool.name, { [idField]: id }));
    const summary = summarizeFoodOrder(raw, (await craveLensOrderIds([id])).has(id));
    if (!summary) throw Object.assign(new Error("Swiggy did not return that order"), { statusCode: 404 });
    return { order: summary };
  } finally {
    await mcp.close().catch(() => {});
  }
}
