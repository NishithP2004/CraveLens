import { beforeEach, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({ place: vi.fn(), check: vi.fn(), confirm: vi.fn() }));
vi.mock("../src/swiggy.js", () => ({ placeOrder: sdk.place, publicPayment: (p) => p, checkUPIPayment: sdk.check, confirmUPIPayment: sdk.confirm }));
import { cartRevision, decideCart, refreshPayment, cancelPayment } from "../src/checkout.js";
import { getThread, patchThread, saveThread } from "../src/store.js";
let id;
const suggestion = { expiresAt: new Date(Date.now() + 600_000).toISOString(), finalAmount: 251, receipt: { items: [{ id: "dish", quantity: 1 }] }, addressId: "saved", paymentOptions: { cod: { available: true } } };
beforeEach(async () => {
  id = crypto.randomUUID(); sdk.place.mockReset(); sdk.check.mockReset(); sdk.confirm.mockReset();
  await saveThread({ threadId: id, deviceId: "owner", status: "awaiting_confirmation", suggestion });
});
it("does not let a different device authorize the cart", async () => {
  await expect(decideCart("other", id, "approve", "COD")).rejects.toThrow("Cart not found");
  expect(sdk.place).not.toHaveBeenCalled();
});
it("claims checkout atomically across concurrent browser and Telegram confirmations", async () => {
  sdk.place.mockResolvedValue({ order: { orderId: "placed" } });
  const results = await Promise.allSettled([decideCart("owner", id, "approve", "COD"), decideCart("owner", id, "approve", "COD")]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(sdk.place).toHaveBeenCalledTimes(1);
  expect((await getThread(id)).status).toBe("ordered");
});
it("rejects a confirmation button created for a different cart revision", async () => {
  const old = cartRevision(suggestion);
  await patchThread(id, { suggestion: { ...suggestion, finalAmount: 300 } });
  await expect(decideCart("owner", id, "approve", "COD", old)).rejects.toThrow("changed");
  expect(sdk.place).not.toHaveBeenCalled();
});
it("retains uncertain placement state without automatically repeating the order", async () => {
  sdk.place.mockRejectedValue(new Error("Connection lost"));
  await expect(decideCart("owner", id, "approve", "COD")).rejects.toThrow("Connection lost");
  await expect(decideCart("owner", id, "approve", "COD")).rejects.toThrow("already being processed");
  expect(sdk.place).toHaveBeenCalledTimes(1);
});
it("does not finalize a still-pending UPI payment", async () => {
  await patchThread(id, { status: "payment_pending", payment: { expiresAt: suggestion.expiresAt } });
  sdk.check.mockResolvedValue("pending");
  expect(await refreshPayment("owner", id)).toEqual({ status: "payment_pending" });
  expect(sdk.confirm).not.toHaveBeenCalled();
});
it("finalizes a paid UPI order and never repeats confirmation after completion", async () => {
  await patchThread(id, { status: "payment_pending", payment: { expiresAt: suggestion.expiresAt } });
  sdk.check.mockResolvedValue("paid"); sdk.confirm.mockResolvedValue({ orderId: "paid-order", result: "success" });
  expect(await refreshPayment("owner", id)).toMatchObject({ status: "ordered" });
  expect(await refreshPayment("owner", id)).toMatchObject({ status: "ordered" });
  expect(sdk.confirm).toHaveBeenCalledTimes(1);
});

it("does not confirm failed UPI payments or announce ambiguous confirmations", async () => {
  await patchThread(id, { status: "payment_pending", payment: { expiresAt: suggestion.expiresAt } });
  sdk.check.mockResolvedValue("failed");
  expect(await refreshPayment("owner", id)).toMatchObject({ status: "payment_failed" });
  expect(sdk.confirm).not.toHaveBeenCalled();
  await patchThread(id, { status: "payment_pending" }); sdk.check.mockResolvedValue("paid"); sdk.confirm.mockResolvedValue({ result: "pending" });
  expect(await refreshPayment("owner", id)).toMatchObject({ status: "payment_review_required" });
});
it("honors Swiggy auto-confirmation without making another confirm call", async () => {
  await patchThread(id, { status: "payment_pending", payment: { orderId: "already-confirmed", expiresAt: suggestion.expiresAt } });
  sdk.check.mockResolvedValue({ status: "paid", confirmed: true, raw: { confirmed: true } });
  expect(await refreshPayment("owner", id)).toMatchObject({ status: "ordered" }); expect(sdk.confirm).not.toHaveBeenCalled();
});

it("stops only pending UPI tracking after checking live payment status", async () => {
  await patchThread(id, { status: "payment_pending", payment: { expiresAt: new Date(Date.now()+60_000).toISOString() } });
  sdk.check.mockResolvedValue({ status: "pending" });
  expect((await cancelPayment("owner", id)).status).toBe("cancelled");
  expect((await getThread(id)).status).toBe("payment_cancelled");
  expect(sdk.confirm).not.toHaveBeenCalled();
});
it("does not cancel a paid UPI payment or another user's payment", async () => {
  await patchThread(id, { status: "payment_pending", payment: {} });
  await expect(cancelPayment("other", id)).rejects.toThrow("Cart not found");
  sdk.check.mockResolvedValue({ status: "paid" });
  expect((await cancelPayment("owner", id)).status).toBe("paid");
  expect((await getThread(id)).status).toBe("payment_paid");
});
it("holds unknown payment outcomes for review instead of reporting cancellation", async () => {
  await patchThread(id, { status: "payment_pending", payment: {} });
  sdk.check.mockResolvedValue({ status: "unknown" });
  expect((await cancelPayment("owner", id)).status).toBe("payment_review_required");
});
