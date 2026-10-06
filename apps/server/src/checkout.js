import { tracedOperation } from "./trace-context.js";
import crypto from "node:crypto";
import { claimThreadStatus, getThread, patchThread } from "./store.js";
import { placeOrder, publicPayment, checkUPIPayment, confirmUPIPayment } from "./swiggy.js";

async function decideCartImpl(deviceId, threadId, decision, paymentMethod, expectedRevision) {
    if (!["approve", "reject"].includes(decision)) throw Object.assign(new Error("decision must be approve or reject"), { statusCode: 400 });
    const thread = await getThread(threadId);
    if (thread && thread.deviceId !== deviceId) throw Object.assign(new Error("Cart not found"), { statusCode: 404 });
    if (!thread) throw Object.assign(new Error("Suggestion expired or not found"), { statusCode: 404 });
    if (expectedRevision && cartRevision(thread.suggestion) !== expectedRevision) throw Object.assign(new Error("This cart changed. Review the updated cart before confirming."), { statusCode: 409 });
    if (isSuggestionExpired(thread.suggestion)) throw Object.assign(new Error("Cart expired. Build a fresh Swiggy cart."), { statusCode: 410 });
    if (decision === "reject") {
      const rejected = await claimThreadStatus(threadId, ["awaiting_confirmation"], "rejected");
      if (!rejected) throw Object.assign(new Error("This cart is already being processed."), { statusCode: 409 });
      return ({ status: "rejected" });
    }
    if (thread.status === "payment_pending" || thread.status === "payment_paid") return ({ status: thread.status, payment: publicPayment(thread.payment) });
    if (thread.status === "ordered") return ({ status: "ordered", order: thread.order });
    if (thread.status === "payment_review_required") return ({ status: thread.status, order: thread.order, message: thread.placementError });
    paymentMethod = String(paymentMethod || "").toUpperCase();
    if (!["COD", "UPI", "SWIGGYPAY"].includes(paymentMethod)) throw Object.assign(new Error("Choose Swiggy Money, COD or UPI before confirming the order."), { statusCode: 400 });
    if (!thread.suggestion.paymentOptions?.[paymentMethod.toLowerCase()]?.available) throw Object.assign(new Error(`${paymentMethod} is not available for this Swiggy cart.`), { statusCode: 400 });
    const claimed = await claimThreadStatus(threadId, ["awaiting_confirmation"], "placing_order");
    if (!claimed) throw Object.assign(new Error("This cart is already being processed."), { statusCode: 409 });
    try {
      if (cartRevision(claimed.suggestion) !== (expectedRevision || cartRevision(thread.suggestion))) {
        await patchThread(threadId, { status: "awaiting_confirmation" });
        throw Object.assign(new Error("This cart changed. Review the updated cart before confirming."), { statusCode: 409, beforePlacement: true });
      }
      const result = await placeOrder(claimed.suggestion, deviceId, paymentMethod);
      if (result.reviewRequired) {
        await patchThread(threadId, { status: "payment_review_required", paymentMethod, order: result.order, placementError: result.message });
        return ({ status: "payment_review_required", order: result.order, message: result.message });
      }
      if (result.declined) {
        const suggestion = { ...claimed.suggestion, paymentOptions: result.paymentOptions, availablePaymentMethods: Object.entries(result.paymentOptions).filter(([, option]) => option.available).map(([method]) => method.toUpperCase()) };
        await patchThread(threadId, { status: "awaiting_confirmation", suggestion, placementError: result.message });
        return ({ status: "payment_declined", suggestion, message: result.message });
      }
      if (result.payment) {
        await patchThread(threadId, { status: "payment_pending", paymentMethod, payment: result.payment });
        return ({ status: "payment_pending", payment: publicPayment(result.payment) });
      }
      await patchThread(threadId, { status: "ordered", paymentMethod, order: result.order });
      return ({ status: "ordered", order: result.order });
    } catch (error) {
      if (!error.beforePlacement) await patchThread(threadId, { status: "placement_failed", placementError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
}

function isSuggestionExpired(suggestion) { return !suggestion?.expiresAt || Date.parse(suggestion.expiresAt) <= Date.now(); }

async function refreshPaymentImpl(deviceId, threadId) {
  const thread = await getThread(threadId);
  if (!thread || thread.deviceId !== deviceId) throw new Error("Cart not found");
  if (!["payment_pending", "payment_paid"].includes(thread.status)) return { status: thread.status, order: thread.order };
  const expired = Date.parse(thread.payment.expiresAt) <= Date.now();
  const checked = await checkUPIPayment(thread.payment, deviceId, { detailed: true });
  const status = typeof checked === "string" ? checked : checked.status;
  if (status === "pending" && !expired) return { status: "payment_pending" };
  const claimed = await claimThreadStatus(threadId, ["payment_pending", "payment_paid"], "confirming_payment");
  if (!claimed) return { status: (await getThread(threadId)).status };
  try {
    if (status !== "paid") {
      const next = status === "failed" ? "payment_failed" : "payment_review_required";
      await patchThread(threadId, { status: next });
      return { status: next };
    }
    const order = checked.confirmed ? { ...checked.raw, orderId: thread.payment.orderId } : await confirmUPIPayment(thread.payment, deviceId);
    const complete = checked.confirmed || order?.result === "success" || order?.normalizedStatus === "success" || ["CONFIRMED", "PLACED"].includes(order?.orderStatus || order?.status);
    const next = complete ? "ordered" : "payment_review_required";
    await patchThread(threadId, { status: next, order });
    return { status: next, order };

  } catch (error) {
    await patchThread(threadId, { status: "confirmation_failed", confirmationError: "Check this order in Swiggy before retrying." });
    throw error;
  }
}

export function cartRevision(s) { return crypto.createHash("sha256").update(JSON.stringify([s?.receipt, s?.finalAmount, s?.addressId, s?.cartMutationItems])).digest("hex"); }

async function cancelPaymentImpl(deviceId, threadId) {
  const thread = await getThread(threadId);
  if (!thread || thread.deviceId !== deviceId) throw Object.assign(new Error("Cart not found"), { statusCode: 404 });
  if (!thread.payment) throw Object.assign(new Error("No UPI payment is pending for this cart."), { statusCode: 404 });
  if (thread.status !== "payment_pending") return { status: ({ payment_paid: "paid", payment_cancelled: "cancelled", payment_failed: "failed" })[thread.status] || thread.status, order: thread.order };
  const claimed = await claimThreadStatus(threadId, ["payment_pending"], "payment_cancelling");
  if (!claimed) return { status: (await getThread(threadId)).status };
  try {
    const checked = await checkUPIPayment(claimed.payment, deviceId, { detailed: true });
    const status = typeof checked === "string" ? checked : checked.status;
    if (status === "paid") { await patchThread(threadId, { status: "payment_paid" }); return { status: "paid" }; }
    if (status === "failed") { await patchThread(threadId, { status: "payment_failed" }); return { status: "failed" }; }
    if (status !== "pending") { await patchThread(threadId, { status: "payment_review_required" }); return { status: "payment_review_required" }; }
    await patchThread(threadId, { status: "payment_cancelled", paymentCancelledAt: new Date() });
    return { status: "cancelled", message: "Payment tracking stopped. This does not cancel or refund a payment made in your UPI app. Check Swiggy before retrying." };
  } catch (error) { await patchThread(threadId, { status: "payment_pending" }); throw error; }
}

export const decideCart = tracedOperation("checkout.decision", decideCartImpl, (_device, threadId) => ({sessionId: threadId, operation: "checkout.decision"}));

export const refreshPayment = tracedOperation("payment.refresh", refreshPaymentImpl, (_device, threadId) => ({sessionId: threadId, operation: "payment.refresh"}));

export const cancelPayment = tracedOperation("payment.cancel", cancelPaymentImpl, (_device, threadId) => ({sessionId: threadId, operation: "payment.cancel"}));
