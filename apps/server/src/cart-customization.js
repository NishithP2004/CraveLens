import { tracedOperation } from "./trace-context.js";
import { claimThreadStatus, getThread, patchThread } from "./store.js";
import { customizePersonalizedCart } from "./swiggy.js";
import { publishAgentEvent } from "./agent-events.js";

async function customizeCartImpl(deviceId, threadId, input) {
  const existing = await getThread(threadId);
  if (!existing || existing.deviceId !== deviceId) throw Object.assign(new Error("Cart not found"), { statusCode: 404 });
  if (!Number.isFinite(Date.parse(existing.suggestion?.expiresAt)) || Date.parse(existing.suggestion?.expiresAt) <= Date.now()) throw Object.assign(new Error("This cart expired. Prepare a fresh cart."), { statusCode: 410 });
  const thread = await claimThreadStatus(threadId, ["awaiting_confirmation"], "customizing");
  if (!thread) throw Object.assign(new Error("This cart can no longer be customized."), { statusCode: 409 });
  publishAgentEvent(input.streamId, "customization_started", { instruction: input.instruction });
  try {
    const conversationId = thread.conversationId || thread.threadId;
    const suggestion = await customizePersonalizedCart(thread.suggestion, input.instruction, conversationId, deviceId, input.streamId, { personalContext: input.personalContext, timeZone: input.timeZone });
    await patchThread(threadId, { status: "awaiting_confirmation", suggestion, conversationId, lastInstruction: input.instruction, customizedAt: new Date() });
    publishAgentEvent(input.streamId, "cart_ready", { restaurant: suggestion.restaurant, item: suggestion.item, finalAmount: suggestion.finalAmount });
    return { status: "awaiting_confirmation", conversationId, suggestion };
  } catch (error) {
    await patchThread(threadId, { status: "awaiting_confirmation", customizationError: String(error.message || error) });
    throw error;
  }
}

export const customizeCart = tracedOperation("cart.customize", customizeCartImpl, (_device, threadId) => ({sessionId: threadId, operation: "cart.customize"}));
