import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ records: new Map(), messages: [], threads: new Map(), checkout: vi.fn(), cancel: vi.fn(), customize: vi.fn() }));
vi.mock("../src/redis.js", () => ({ getRedis: async () => ({
  sAdd: async (key, value) => { const set = state.records.get(key) || new Set(); set.add(value); state.records.set(key, set); },
  sRem: async (key, value) => { state.records.get(key)?.delete(value); },
  get: async (key) => state.records.get(key) ?? null,
  getDel: async (key) => { const value = state.records.get(key); state.records.delete(key); return value; },
  set: async (key, value, options) => { if (options?.NX && state.records.has(key)) return null; state.records.set(key, value); return "OK"; },
  del: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) state.records.delete(key); },
}) }));
vi.mock("../src/store.js", () => ({ getThread: async (id) => state.threads.get(id), patchThread: async (id, patch) => { const thread = state.threads.get(id); if (thread) Object.assign(thread, patch); return thread; } }));
vi.mock("../src/checkout.js", () => ({ cartRevision: (s) => JSON.stringify(s?.receipt), decideCart: state.checkout, refreshPayment: vi.fn(), cancelPayment: state.cancel }));
vi.mock("../src/config.js", () => ({ config: { telegramBotToken: "test-token", telegramWebhookSecret: "test-secret" } }));
vi.mock("../src/cart-customization.js", () => ({ customizeCart: state.customize }));
import { processTelegramCartUpdate, cartProductImage, deliverTelegramCart, richMessageChunks, cartMessage, confirmTelegramLink, disconnectTelegram, handleTelegramUpdate, startTelegramLink, telegramStatus } from "../src/telegram.js";
import { saveCartExperience } from "../src/cart-experience.js";

beforeEach(() => {
  state.records.clear(); state.threads.clear(); state.messages.length = 0; state.checkout.mockReset(); state.cancel.mockReset(); state.customize.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    const body = JSON.parse(options.body); state.messages.push({ method: url.split("/").pop(), body });
    return { json: async () => ({ ok: true, result: url.endsWith("getMe") ? { username: "cravelens_test_bot" } : { message_id: 1 } }) };
  }));
});
async function link() {
  const { url } = await startTelegramLink("device-a");
  const token = new URL(url).searchParams.get("start");
  await handleTelegramUpdate({ message: { chat: { id: 10, type: "private" }, from: { id: 10, first_name: "Owner" }, text: `/start ${token}` } });
  return { token, status: await telegramStatus("device-a") };
}
it("requires Telegram Start and extension confirmation before enabling delivery", async () => {
  await expect(saveCartExperience("device-a", { mode: "telegram" })).rejects.toThrow("verify");
  const { status } = await link();
  expect(status).toMatchObject({ connected: false, pending: true, pendingName: "Owner" });
  expect(await confirmTelegramLink("device-a")).toMatchObject({ connected: true, name: "Owner" });
  expect(await saveCartExperience("device-a", { mode: "telegram", silent: true })).toEqual({ mode: "telegram", silent: true });
});
it("ignores reused start tokens and group chats", async () => {
  const { token } = await link();
  await confirmTelegramLink("device-a");
  await handleTelegramUpdate({ message: { chat: { id: 20, type: "private" }, from: { id: 20 }, text: `/start ${token}` } });
  expect((await telegramStatus("device-a")).pending).toBe(false);
  const result = await startTelegramLink("device-b");
  await handleTelegramUpdate({ message: { chat: { id: -20, type: "group" }, from: { id: 20 }, text: `/start ${new URL(result.url).searchParams.get("start")}` } });
  await expect(confirmTelegramLink("device-b")).rejects.toThrow("press Start");
});
it("rejects callbacks from another Telegram user before touching checkout", async () => {
  await link(); await confirmTelegramLink("device-a");
  state.records.set("cravelens:telegram:action:button", JSON.stringify({ deviceId: "device-a", chatId: "10", type: "confirm", threadId: "cart", method: "COD" }));
  await handleTelegramUpdate({ callback_query: { id: "query", data: "button", from: { id: 999 }, message: { message_id: 1, chat: { id: 10, type: "private" } } } });
  expect(state.checkout).not.toHaveBeenCalled();
});
it("payment selection only shows a confirmation, without placing an order", async () => {
  await link(); await confirmTelegramLink("device-a");
  state.threads.set("cart", { deviceId: "device-a", threadId: "cart", status: "awaiting_confirmation", suggestion: { restaurant: "Restaurant", finalAmount: 251, expiresAt: new Date(Date.now()+60_000).toISOString(), receipt: { items: [] } } });
  state.records.set("cravelens:telegram:action:button", JSON.stringify({ deviceId: "device-a", chatId: "10", type: "select", threadId: "cart", method: "COD" }));
  await handleTelegramUpdate({ callback_query: { id: "query", data: "button", from: { id: 10 }, message: { message_id: 1, chat: { id: 10, type: "private" } } } });
  expect(state.checkout).not.toHaveBeenCalled();
  expect(state.messages.at(-1).body.reply_markup.inline_keyboard[0][0].text).toContain("Confirm order");
});
it("disconnect revokes callback authorization and resets the experience", async () => {
  await link(); await confirmTelegramLink("device-a"); await disconnectTelegram("device-a");
  expect(await telegramStatus("device-a")).toMatchObject({ connected: false, settings: { mode: "screen" } });
});
it("cart message contains actual receipt, payable, address and expiry", () => {
  expect(cartMessage({ restaurant: "Restaurant", receipt: { items: [{ name: "Biryani", quantity: 1, customizations: ["Egg"] }] }, finalAmount: 251, deliveryAddress: "Saved address", expiresAt: "2026-10-03T16:00:00Z" })).toContain("1 × <b>Biryani</b> — Egg");
});

const suggestion = () => ({ restaurant: "Restaurant & Kitchen", receipt: { items: [{ name: "Biryani <special>", quantity: 1, imageUrl: "https://media-assets.swiggy.com/item.jpg" }] }, finalAmount: 251, deliveryAddress: "Home & office", expiresAt: new Date(Date.now() + 60_000).toISOString() });
it("escapes rich receipt content and keeps complete formatting in long receipts", () => {
  const s = suggestion();
  s.receipt.items = Array.from({ length: 50 }, (_, i) => ({ name: `Item ${i} ${"&".repeat(160)}`, quantity: 1 }));
  const text = cartMessage(s);
  const chunks = richMessageChunks(text);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.length <= 3800)).toBe(true);
  expect(chunks.join("\n")).toContain("Item 49");
  expect(text).toContain("Restaurant &amp; Kitchen");
  expect(text).toContain("<b>Deliver to</b>\nHome &amp; office");
  for (const chunk of chunks) expect((chunk.match(/<b>/g) || []).length).toBe((chunk.match(/<\/b>/g) || []).length);
});
it("sends the product photo followed by an HTML receipt with checkout buttons", async () => {
  const thread = { deviceId: "device-a", threadId: "cart", suggestion: suggestion() };
  state.threads.set("cart", thread);
  state.messages.length = 0;
  await deliverTelegramCart(thread, { chatId: "10" }, { silent: false });
  expect(state.messages.map((message) => message.method)).toEqual(["sendPhoto", "sendMessage"]);
  expect(state.messages[0].body).toMatchObject({ photo: thread.suggestion.receipt.items[0].imageUrl, parse_mode: "HTML", disable_notification: false });
  expect(state.messages[1].body).toMatchObject({ parse_mode: "HTML", disable_notification: false });
  expect(state.messages[1].body.text).toContain("<b>Biryani &lt;special&gt;</b>");
  expect(state.messages[1].body.reply_markup.inline_keyboard).toHaveLength(1);
});
it("uses a text receipt when there is no image or Telegram rejects the photo", async () => {
  const thread = { deviceId: "device-a", threadId: "cart", suggestion: suggestion() };
  state.threads.set("cart", thread);
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    state.messages.push({ method: url.split("/").pop(), body: JSON.parse(options.body) });
    return { json: async () => url.endsWith("sendPhoto") ? { ok: false, error_code: 400 } : { ok: true, result: { message_id: 2 } } };
  }));
  await deliverTelegramCart(thread, { chatId: "10" }, { silent: true });
  expect(state.messages.at(-1).method).toBe("sendMessage");
  expect(state.messages.at(-1).body.disable_notification).toBe(true);
  state.messages.length = 0;
  delete thread.suggestion.receipt.items[0].imageUrl;
  await deliverTelegramCart(thread, { chatId: "10" }, { silent: false });
  expect(state.messages.map((message) => message.method)).toEqual(["sendMessage"]);
  expect(cartProductImage({ imageUrl: "javascript:alert(1)", receipt: { items: [] } })).toBeUndefined();
});
it("keeps checkout on the text receipt and does not resend a persisted photo", async () => {
  const thread = { deviceId: "device-a", threadId: "cart", suggestion: suggestion(), telegramPhoto: { messageId: 1 } };
  state.threads.set("cart", thread);
  await deliverTelegramCart(thread, { chatId: "10" }, { silent: false });
  expect(state.messages.map((message) => message.method)).toEqual(["sendMessage"]);
});

it("shows cancellation on pending UPI and delegates to the shared cancellation service", async () => {
  await link(); await confirmTelegramLink("device-a");
  state.threads.set("cart", { deviceId: "device-a", threadId: "cart", status: "awaiting_confirmation", suggestion: suggestion() });
  state.checkout.mockResolvedValue({ status: "payment_pending", payment: { amount: 251 } });
  state.records.set("cravelens:telegram:action:confirm", JSON.stringify({ deviceId: "device-a", chatId: "10", type: "confirm", threadId: "cart", method: "UPI" }));
  await handleTelegramUpdate({ callback_query: { id: "query", data: "confirm", from: { id: 10 }, message: { message_id: 1, chat: { id: 10, type: "private" } } } });
  const body = state.messages.findLast((entry) => entry.method === "editMessageText").body;
  expect(body.reply_markup.inline_keyboard.flat().some((button) => button.text === "Cancel payment process")).toBe(true);
  const cancel = body.reply_markup.inline_keyboard.flat().find((button) => button.text === "Cancel payment process");
  state.cancel.mockResolvedValue({ status: "cancelled", message: "Tracking stopped" });
  await handleTelegramUpdate({ callback_query: { id: "cancel", data: cancel.callback_data, from: { id: 10 }, message: { message_id: 1, chat: { id: 10, type: "private" } } } });
  expect(state.cancel).toHaveBeenCalledWith("device-a", "cart");
});
it("runs persisted Telegram follow-ups through shared customization with their current thread", async () => {
  await link(); await confirmTelegramLink("device-a");
  const thread = { deviceId: "device-a", threadId: "cart", status: "awaiting_confirmation", suggestion: suggestion() };
  state.threads.set("cart", thread);
  state.records.set("cravelens:telegram:update:command", JSON.stringify({ deviceId: "device-a", threadId: "cart", chatId: "10", input: { instruction: "Add another portion" } }));
  state.customize.mockResolvedValue({ suggestion: thread.suggestion });
  await processTelegramCartUpdate("command");
  expect(state.customize).toHaveBeenCalledWith("device-a", "cart", { instruction: "Add another portion" });
  expect(state.messages.some((message) => message.method === "sendMessage" && message.body.reply_markup)).toBe(true);
});

it("queues verified private follow-ups once and ignores a different sender", async () => {
  await link(); await confirmTelegramLink("device-a");
  state.threads.set("cart", { deviceId: "device-a", threadId: "cart", status: "awaiting_confirmation", suggestion: suggestion() });
  state.records.set("cravelens:active-cart:device-a", "cart");
  vi.useFakeTimers();
  try {
    const message = { message_id: 7, chat: { id: 10, type: "private" }, from: { id: 10 }, text: "Add another portion" };
    await handleTelegramUpdate({ message });
    await handleTelegramUpdate({ message });
    expect(state.records.get("cravelens:telegram:updates").size).toBe(1);
    expect(JSON.parse(state.records.get("cravelens:telegram:update:10:7"))).toMatchObject({ deviceId: "device-a", threadId: "cart", input: { instruction: "Add another portion" } });
    const count = state.messages.length;
    await handleTelegramUpdate({ message: { ...message, message_id: 8, from: { id: 999 } } });
    expect(state.messages).toHaveLength(count);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});
