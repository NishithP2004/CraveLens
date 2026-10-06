import { tracedOperation, traceOperation } from "./trace-context.js";
import { customizeCart } from "./cart-customization.js";
import { CartCustomizationSchema } from "@cravelens/shared";
import { formatCartExplanation } from "./cart-explanation.js";
import crypto from "node:crypto";
import { config } from "./config.js";
import { getRedis } from "./redis.js";
import { getThread, patchThread } from "./store.js";
import { cartRevision, decideCart, refreshPayment, cancelPayment } from "./checkout.js";
import { getCartExperience, saveCartExperience } from "./cart-experience.js";
import { decideFallback } from "./fallback-approval.js";

const key = (suffix) => `cravelens:telegram:${suffix}`;
const deliveryKey = key("deliveries");
let stopped = false;
let pumpTimer;
let pollingAbort;
let bot;
async function telegramCallImpl(method, body = {}, { signal } = {}) {
  if (!config.telegramBotToken) throw new Error("Telegram bot is not configured on this server");
  let response;
  try { response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: signal || AbortSignal.timeout(25_000) }); }
  catch { throw new Error("Telegram connection failed"); }
  let value;
  try { value = await response.json(); } catch { throw new Error("Telegram returned an unreadable response"); }
  if (!value.ok) throw Object.assign(new Error(`Telegram request failed (${value.error_code || response.status})`), { telegramErrorCode: value.error_code || response.status });
  return value.result;
}
async function botIdentity() { return bot || (bot = await telegramCall("getMe")); }
export async function telegramStatus(deviceId) {
  const redis = await getRedis();
  const link = JSON.parse(await redis.get(key(`link:${deviceId}`)) || "null");
  const pending = JSON.parse(await redis.get(key(`pending:${deviceId}`)) || "null");
  return { configured: Boolean(config.telegramBotToken), connected: Boolean(link), name: link?.name, pendingName: pending?.name, pending: Boolean(pending), settings: await getCartExperience(deviceId) };
}
export async function startTelegramLink(deviceId) {
  const redis = await getRedis();
  const identity = await botIdentity();
  const token = crypto.randomBytes(24).toString("base64url");
  await redis.del(key(`pending:${deviceId}`));
  await redis.set(key(`start:${token}`), deviceId, { EX: 300 });
  await redis.set(key(`latest:${deviceId}`), token, { EX: 300 });
  return { url: `https://t.me/${identity.username}?start=${token}`, expiresAt: Date.now() + 300_000 };
}
export async function confirmTelegramLink(deviceId) {
  const redis = await getRedis();
  const raw = await redis.getDel(key(`pending:${deviceId}`));
  if (!raw) throw new Error("Open Telegram and press Start before confirming the connection");
  const link = JSON.parse(raw);
  if (await redis.get(key(`latest:${deviceId}`)) !== link.token) throw new Error("Link request expired; connect again");
  const owner = await redis.get(key(`owner:${link.userId}`));
  if (owner && owner !== deviceId) throw new Error("This Telegram account is already linked to another device. Disconnect it first.");
  if (!owner && !await redis.set(key(`owner:${link.userId}`), deviceId, { NX: true })) throw new Error("Telegram account was linked elsewhere; try again");
  const previous = JSON.parse(await redis.get(key(`link:${deviceId}`)) || "null");
  if (previous && previous.userId !== link.userId) await redis.del(key(`owner:${previous.userId}`));
  await redis.set(key(`link:${deviceId}`), JSON.stringify(link));
  await redis.del(key(`latest:${deviceId}`));
  return telegramStatus(deviceId);
}
export async function disconnectTelegram(deviceId) {
  const redis = await getRedis();
  const link = JSON.parse(await redis.get(key(`link:${deviceId}`)) || "null");
  if (link) await redis.del(key(`owner:${link.userId}`));
  await redis.del([key(`link:${deviceId}`), key(`pending:${deviceId}`), key(`latest:${deviceId}`)]);
  await saveCartExperience(deviceId, { mode: "screen" });
}
async function button(deviceId, chatId, text, action) {
  const redis = await getRedis();
  const token = crypto.randomBytes(18).toString("base64url");
  const revision = action.threadId ? cartRevision((await getThread(action.threadId))?.suggestion) : undefined;
  await redis.set(key(`action:${token}`), JSON.stringify({ deviceId, chatId, revision, ...action }), { EX: 900 });
  return { text, callback_data: token };
}
const html = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapedLines = (value) => String(value ?? "").split("\n").flatMap((line) => line.match(/[\s\S]{1,500}/gu) || [""]).map(html).join("\n");
const field = (value) => html(String(value ?? "").replace(/\s+/g, " ").trim());
export function cartMessage(s) {
  const items = (s.receipt?.items || []).map((item) => `• ${field(item.quantity)} × <b>${field(item.name)}</b>${item.customizations?.length ? ` — ${field(item.customizations.join(", "))}` : ""}`);
  return [
    "<b>Your CraveLens cart is ready</b>",
    `<b>${field(s.restaurant)}</b>`,
    `<b>Items</b>\n${items.join("\n") || "Review your items in Swiggy."}`,
    `<b>Payable: ₹${field(s.finalAmount)}</b>`,
    s.deliveryEta ? `<b>Delivery estimate</b>\n${field(s.deliveryEta)}` : "",
    `<b>Deliver to</b>\n${field(s.deliveryAddress)}`,
    `<b>Review before</b>\n${field(new Date(s.expiresAt).toLocaleString("en-IN", { timeZone: s.timeZone || "Asia/Kolkata" }))}`,
    "<i>Review the cart and address. Select a payment method, then confirm your order.</i>",
  ].filter(Boolean).join("\n\n");
}
export function richMessageChunks(text) {
  const chunks = [];
  const openTags = [];
  let current = "";
  const closing = () => [...openTags].reverse().map((tag) => `</${tag}>`).join("");
  // Split only between entities/code points, closing and reopening generated tags.
  for (const token of text.match(/<\/?(?:b|i)>|&(?:amp|lt|gt);|[\s\S]/gu) || []) {
    if (current.length + token.length + closing().length + 8 > 3800) {
      chunks.push(current + closing());
      current = openTags.map((tag) => `<${tag}>`).join("");
    }
    current += token;
    if (token === "<b>" || token === "<i>") openTags.push(token.slice(1, -1));
    else if (token === "</b>" || token === "</i>") openTags.pop();
  }
  if (current) chunks.push(current + closing());
  return chunks;
}

async function sendRichText(chatId, text, silent, replyMarkup) {
  const chunks = richMessageChunks(text);
  let sent;
  for (const [index, chunk] of chunks.entries()) sent = await telegramCall("sendMessage", { chat_id: chatId, text: chunk, parse_mode: "HTML", disable_notification: silent, link_preview_options: { is_disabled: true }, ...(index === chunks.length - 1 && replyMarkup ? { reply_markup: replyMarkup } : {}) });
  return sent;
}
export function cartProductImage(suggestion) {
  for (const candidate of [...(suggestion.receipt?.items || []).map((item) => item.imageUrl), suggestion.imageUrl]) {
    try { const url = new URL(candidate); if (url.protocol === "https:" && !url.username && !url.password) return url.href; } catch { /* No usable product image. */ }
  }
}
async function deliverTelegramCartImpl(thread, link, settings) {
  const photo = cartProductImage(thread.suggestion);
  if (photo && !thread.telegramPhoto) {
    try {
      const sent = await telegramCall("sendPhoto", { chat_id: link.chatId, photo, caption: `<b>${field(String(thread.suggestion.receipt?.items?.find((item) => item.imageUrl === photo)?.name || thread.suggestion.restaurant || "Cart item").slice(0, 160))}</b>`, parse_mode: "HTML", disable_notification: settings.silent });
      await patchThread(thread.threadId, { telegramPhoto: { chatId: link.chatId, messageId: sent.message_id } });
      await (await getRedis()).set(key(`message:${link.chatId}:${sent.message_id}`), thread.threadId, { EX: 3600 });
    } catch (error) {
      // A rejected photo must not prevent the receipt. Ambiguous transport failures
      // remain in the outbox instead of immediately submitting another photo.
      if (error.telegramErrorCode !== 400) throw error;
    }
  }
  const sent = await sendRichText(link.chatId, cartMessage(thread.suggestion), settings.silent, await cartKeyboard(thread.deviceId, link.chatId, thread));
  await (await getRedis()).set(key(`message:${link.chatId}:${sent.message_id}`), thread.threadId, { EX: 3600 });
  return sent;
}

async function cartKeyboard(deviceId, chatId, thread) {
  const rows = [];
  for (const [method, title] of [["UPI", "UPI"], ["COD", "Cash on delivery"], ["SWIGGYPAY", "Swiggy Money"]]) if (thread.suggestion.paymentOptions?.[method.toLowerCase()]?.available) rows.push([await button(deviceId, chatId, title, { type: "select", threadId: thread.threadId, method })]);
  rows.push([await button(deviceId, chatId, "Why this cart?", { type: "why", threadId: thread.threadId }), await button(deviceId, chatId, "Dismiss", { type: "dismiss", threadId: thread.threadId })]);
  return { inline_keyboard: rows };
}
export async function queueTelegramCart(threadId) { await (await getRedis()).sAdd(deliveryKey, threadId); }
export async function sendTelegramFallback(deviceId, runId, details) {
  const redis = await getRedis();
  if ((await getCartExperience(deviceId)).mode !== "telegram") return false;
  const link = JSON.parse(await redis.get(key(`link:${deviceId}`)) || "null");
  if (!link) throw new Error("Telegram was disconnected; hosted fallback is not authorized");
  await telegramCall("sendMessage", { chat_id: link.chatId, text: `The local model failed. Allow this run to send its model context to ${details.hostedProvider || "the configured hosted provider"}? No order is placed without confirmation.`, disable_notification: true, reply_markup: { inline_keyboard: [[await button(deviceId, link.chatId, "Allow for this run", { type: "fallback", runId, decision: "approve" }), await button(deviceId, link.chatId, "Stop", { type: "fallback", runId, decision: "deny" })]] } });
  return true;
}
export async function handleTelegramUpdate(update) {
  const redis = await getRedis();
  const message = update.message;
  if (message?.chat?.type === "private" && message.from && /^\/start\s+[-\w]+$/.test(message.text || "")) {
    const token = message.text.split(/\s+/)[1];
    const deviceId = await redis.getDel(key(`start:${token}`));
    if (!deviceId || await redis.get(key(`latest:${deviceId}`)) !== token) return;
    await redis.set(key(`pending:${deviceId}`), JSON.stringify({ token, userId: String(message.from.id), chatId: String(message.chat.id), name: [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") }), { EX: 300 });
    await telegramCall("sendMessage", { chat_id: message.chat.id, text: "Return to the CraveLens extension and confirm this Telegram account to finish connecting." });
    return;
  }
  if (message?.chat?.type === "private" && message.from && message.text && !message.text.startsWith("/")) {
    const deviceId = await redis.get(key(`owner:${message.from.id}`));
    const link = deviceId && JSON.parse(await redis.get(key(`link:${deviceId}`)) || "null");
    if (!link || link.userId !== String(message.from.id) || link.chatId !== String(message.chat.id)) return;
    const commandId = `${link.chatId}:${message.message_id}`;
    if (!await redis.set(key(`received:${commandId}`), "1", { NX: true, EX: 86400 })) return;
    try {
      const replied = message.reply_to_message?.message_id;
      const threadId = replied ? await redis.get(key(`message:${link.chatId}:${replied}`)) : await redis.get(`cravelens:active-cart:${deviceId}`);
      const thread = threadId && await getThread(threadId);
      if (!thread || thread.deviceId !== deviceId || thread.status !== "awaiting_confirmation" || Date.parse(thread.suggestion.expiresAt) <= Date.now()) throw new Error("No editable cart was found. Finish or stop any pending payment, or prepare a fresh cart.");
      if (message.text.trim().length > 500) throw new Error("Keep cart change requests under 500 characters.");
      const input = CartCustomizationSchema.parse({ instruction: message.text });
      await redis.set(key(`update:${commandId}`), JSON.stringify({ deviceId, threadId, chatId: link.chatId, input }), { EX: 900 });
      await redis.sAdd(key("updates"), commandId);
      await telegramCall("sendMessage", { chat_id: link.chatId, text: "Updating your cart using your request and the current cart context. Review the refreshed receipt before confirming." });
      setTimeout(() => { void processTelegramCartUpdate(commandId).catch(() => console.warn("[telegram] Cart update processing failed")); }, 0).unref?.();
    } catch (error) { await telegramCall("sendMessage", { chat_id: link.chatId, text: String(error.message).slice(0, 1000) }); }
    return;
  }
  const query = update.callback_query;
  if (!query?.message || query.message.chat.type !== "private") return;
  await telegramCall("answerCallbackQuery", { callback_query_id: query.id });
  const raw = await redis.get(key(`action:${query.data}`));
  if (!raw) return;
  const action = JSON.parse(raw);
  const link = JSON.parse(await redis.get(key(`link:${action.deviceId}`)) || "null");
  if (!link || link.userId !== String(query.from.id) || link.chatId !== String(query.message.chat.id) || action.chatId !== link.chatId) return;
  return traceOperation("telegram.cart.action", {sessionId: action.threadId || action.runId, operation: "telegram.action"}, async () => {
  const edit = async (text, reply_markup = { inline_keyboard: [] }, rich = false) => {
    const formatted = rich ? text : escapedLines(String(text).slice(0, 1500));
    if (formatted.length <= 3800) return telegramCall("editMessageText", { chat_id: link.chatId, message_id: query.message.message_id, text: formatted, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup });
    const sent = await sendRichText(link.chatId, formatted, true, reply_markup);
    await telegramCall("editMessageReplyMarkup", { chat_id: link.chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
    if (action.threadId) await patchThread(action.threadId, { telegramMessage: { chatId: link.chatId, messageId: sent.message_id } });
    return sent;
  };
  try {
    if (action.type === "fallback") { await decideFallback(action.deviceId, action.runId, action.decision); await edit(action.decision === "approve" ? "Hosted fallback approved for this run." : "Run stopped."); return; }
    const thread = await getThread(action.threadId);
    if (!thread || thread.deviceId !== action.deviceId) throw new Error("Cart not found");
    if (action.type === "cancel") {
      if (action.revision && action.revision !== cartRevision(thread.suggestion)) throw new Error("This cart changed. Review its current payment request before cancelling.");
      const result = await cancelPayment(action.deviceId, thread.threadId);
      if (["cancelled", "failed", "payment_cancelled", "payment_failed"].includes(result.status)) await redis.sRem(key("payments"), thread.threadId);
      await edit(result.status === "paid" ? "Payment already succeeded and cannot be stopped here. Check payment to see your order status." : result.message || `Payment status: ${result.status}`, result.status === "paid" ? { inline_keyboard: [[await button(action.deviceId, link.chatId, "Check payment", { type: "status", threadId: thread.threadId })]] } : undefined);
      return;
    }
    if (action.type === "status") { const result = await refreshPayment(action.deviceId, thread.threadId); await edit(result.status === "ordered" ? "Swiggy order placed successfully." : `Payment status: ${result.status}`, result.status === "payment_pending" ? await paymentKeyboard(action.deviceId, link.chatId, thread) : undefined); return; }
    if (action.revision && action.revision !== cartRevision(thread.suggestion)) throw new Error("This cart changed. Review the updated cart in CraveLens before ordering.");
    if (thread.status !== "awaiting_confirmation" || Date.parse(thread.suggestion.expiresAt) <= Date.now()) throw new Error("This cart expired or is already being processed. Check your current order in Swiggy.");
    if (action.type === "why") { await sendRichText(link.chatId, `<b>Why this cart?</b>\n\n${escapedLines(formatCartExplanation(thread.suggestion.rationale || "No explanation is available.").replace(/^[-*] /gm, "• "))}`, true); return; }
    if (action.type === "select") { await edit(`${cartMessage(thread.suggestion)}\n\n<b>Selected: ${field(action.method === "SWIGGYPAY" ? "Swiggy Money" : action.method)}</b>\nConfirm payment and order to the address above.`, { inline_keyboard: [[await button(action.deviceId, link.chatId, `Confirm order · ₹${thread.suggestion.finalAmount}`, { ...action, type: "confirm" })], [await button(action.deviceId, link.chatId, "Back", { ...action, type: "back" })]] }, true); return; }
    if (action.type === "back") { await edit(cartMessage(thread.suggestion), await cartKeyboard(action.deviceId, link.chatId, thread), true); return; }
    const result = await decideCart(action.deviceId, thread.threadId, action.type === "dismiss" ? "reject" : "approve", action.method, action.revision);
    if (result.status === "payment_pending" || result.status === "payment_paid") {
      await redis.sAdd(key("payments"), thread.threadId);
      const payment = result.payment;
      await edit(`Complete UPI payment of ₹${payment.amount}. The order will be confirmed only after payment succeeds. Stop payment tracking here if you do not want to continue; it does not cancel a transfer in your UPI app.`, await paymentKeyboard(action.deviceId, link.chatId, { ...thread, status: result.status, payment }));
      if (payment.upiString) {
        const { default: QRCode } = await import("qrcode");
        const image = await QRCode.toBuffer(payment.upiString);
        const form = new FormData(); form.set("chat_id", link.chatId); form.set("photo", new Blob([image], { type: "image/png" }), "payment.png");
        const response = await traceOperation("telegram.sendPhoto", {tool: "sendPhoto", phase: "telegram_transport"}, () => fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) }));
        if (!response.ok) throw new Error("Open the Swiggy payment link to complete UPI");
      }
    } else if (result.status === "payment_declined") await edit(result.message, await cartKeyboard(action.deviceId, link.chatId, await getThread(thread.threadId)));
    else await edit(result.status === "ordered" ? `Swiggy order placed successfully.\nOrder: ${result.order?.orderId || result.order?.order_id || "See Swiggy for order details"}` : result.message || "Cart dismissed.");
  } catch (error) { await telegramCall("sendMessage", { chat_id: link.chatId, text: String(error.message || "Check your order in Swiggy before trying again.").slice(0, 1500), disable_notification: true }); }
  });
}
async function pump() {
  const redis = await getRedis();
  for (const commandId of await redis.sMembers(key("updates"))) await processTelegramCartUpdate(commandId);
  for (const id of await redis.sMembers(deliveryKey)) {
    if (!await redis.set(key(`delivery-lock:${id}`), "1", { NX: true, EX: 60 })) continue;
    try {
      const thread = await getThread(id);
      const link = thread && JSON.parse(await redis.get(key(`link:${thread.deviceId}`)) || "null");
      if (!thread || !link || thread.telegramMessage || Date.parse(thread.suggestion.expiresAt) <= Date.now()) { await redis.sRem(deliveryKey, id); continue; }
      const settings = await getCartExperience(thread.deviceId);
      if (settings.mode !== "telegram") { await redis.sRem(deliveryKey, id); continue; }
      const sent = await deliverTelegramCart(thread, link, settings);
      await patchThread(id, { telegramMessage: { chatId: link.chatId, messageId: sent.message_id } });
      await redis.sRem(deliveryKey, id);
    } finally { await redis.del(key(`delivery-lock:${id}`)); }
  }
  for (const id of await redis.sMembers(key("payments"))) {
    if (!await redis.set(key(`payment-lock:${id}`), "1", { NX: true, EX: 60 })) continue;
    try {
      const thread = await getThread(id);
      if (!thread) { await redis.sRem(key("payments"), id); continue; }
      const result = await refreshPayment(thread.deviceId, id);
      if (!["payment_pending", "payment_cancelling", "confirming_payment"].includes(result.status)) {
        await redis.sRem(key("payments"), id);
        const msg = thread.telegramMessage;
        if (msg) await telegramCall("editMessageText", { chat_id: msg.chatId, message_id: msg.messageId, text: result.status === "ordered" ? "Swiggy order placed successfully." : `Payment: ${result.status}. Check your order in the Swiggy app.`, reply_markup: { inline_keyboard: [] } });
      }
    } finally { await redis.del(key(`payment-lock:${id}`)); }
  }
}
export async function startTelegram() {
  if (!config.telegramBotToken) return;
  await botIdentity();
  stopped = false;
  const webhook = config.telegramTransport === "webhook" || config.telegramTransport === "auto" && config.publicBaseUrl.startsWith("https://");
  if (webhook) {
    if (config.telegramWebhookSecret.length < 32) throw new Error("Set TELEGRAM_WEBHOOK_SECRET to at least 32 characters for webhook mode");
    await telegramCall("setWebhook", { url: `${config.publicBaseUrl.replace(/\/$/, "")}/telegram/webhook`, secret_token: config.telegramWebhookSecret, allowed_updates: ["message", "callback_query"] });
  } else {
    await telegramCall("deleteWebhook");
    void poll();
  }
  const runPump = async () => { if (stopped) return; try { await pump(); } catch { console.warn("[telegram] Delivery/payment processing failed; will retry"); } finally { if (!stopped) { pumpTimer = setTimeout(runPump, 30_000); pumpTimer.unref?.(); } } };
  void runPump();
}
async function poll() {
  const redis = await getRedis();
  while (!stopped) {
    const owner = crypto.randomUUID();
    if (!await redis.set(key("poll-lock"), owner, { NX: true, EX: 60 })) { await new Promise((resolve) => setTimeout(resolve, 5000)); continue; }
    try {
      pollingAbort = new AbortController();
      const offset = Number(await redis.get(key("offset")) || 0);
      const updates = await telegramCall("getUpdates", { offset, timeout: 20, allowed_updates: ["message", "callback_query"] }, { signal: pollingAbort.signal });
      for (const update of updates) { await handleTelegramUpdate(update); await redis.set(key("offset"), String(update.update_id + 1)); }
    } catch { if (!stopped) await new Promise((resolve) => setTimeout(resolve, 3000)); }
    finally { await redis.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", { keys: [key("poll-lock")], arguments: [owner] }); }
  }
}
export function stopTelegram() { stopped = true; clearTimeout(pumpTimer); pollingAbort?.abort(); }

async function paymentKeyboard(deviceId, chatId, thread) {
  const rows = [];
  if (thread.payment?.bridgeUrl?.startsWith("https://")) rows.push([{ text: "Open Swiggy payment", url: thread.payment.bridgeUrl }]);
  rows.push([await button(deviceId, chatId, "Check payment", { type: "status", threadId: thread.threadId })]);
  if (thread.status === "payment_pending") rows.push([await button(deviceId, chatId, "Cancel payment process", { type: "cancel", threadId: thread.threadId })]);
  return { inline_keyboard: rows };
}
export async function processTelegramCartUpdate(commandId) {
  const redis = await getRedis();
  if (!await redis.set(key(`update-lock:${commandId}`), "1", { NX: true, EX: 600 })) return;
  let command;
  try {
    command = JSON.parse(await redis.get(key(`update:${commandId}`)) || "null");
    if (!command) return;
    const link = JSON.parse(await redis.get(key(`link:${command.deviceId}`)) || "null");
    if (!link || link.chatId !== command.chatId) return;
    if (command.started) { await telegramCall("sendMessage", { chat_id: link.chatId, text: "A cart update was interrupted. Check your cart in Swiggy before retrying." }); return; }
    command.started = true;
    await redis.set(key(`update:${commandId}`), JSON.stringify(command), { EX: 900 });
    const old = await getThread(command.threadId);
    await customizeCart(command.deviceId, command.threadId, command.input);
    const updated = await getThread(command.threadId);
    if (old.telegramMessage) await telegramCall("editMessageReplyMarkup", { chat_id: link.chatId, message_id: old.telegramMessage.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await patchThread(command.threadId, { telegramMessage: null, telegramPhoto: null });
    await queueTelegramCart(command.threadId);
    const sent = await deliverTelegramCart({ ...updated, telegramPhoto: null }, link, await getCartExperience(command.deviceId));
    await patchThread(command.threadId, { telegramMessage: { chatId: link.chatId, messageId: sent.message_id } });
    await redis.sRem(deliveryKey, command.threadId);
  } catch (error) {
    if (command) await telegramCall("sendMessage", { chat_id: command.chatId, text: `Cart update failed: ${String(error.message || "Check your cart in Swiggy before retrying.").slice(0, 1000)}` }).catch(() => {});
  } finally { await redis.sRem(key("updates"), commandId); await redis.del(key(`update-lock:${commandId}`)); }
}

const tracedTelegramCall = tracedOperation("telegram.api", telegramCallImpl, (method) => ({tool: method, phase: "telegram_transport"}));
// Idle polling is transport housekeeping, not a cart workflow.
export const telegramCall = (method, ...args) => method === "getUpdates" ? telegramCallImpl(method, ...args) : tracedTelegramCall(method, ...args);

export const deliverTelegramCart = tracedOperation("telegram.cart.deliver", deliverTelegramCartImpl, (thread) => ({sessionId: thread.threadId, operation: "telegram.delivery"}));
