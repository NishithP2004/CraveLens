import { expect, it } from "vitest";
import { normalizePaymentOptions, placeConfirmedCart, swiggyMoneyOutcome } from "../src/swiggy.js";

const liveOptions = { swiggyMoney: { available: true, id: "SwiggyPay", displayName: "Swiggy Money" }, cod: { available: true, id: "Cash", displayName: "Cash on delivery" } };
const suggestion = { addressId: "saved-address", paymentOptions: normalizePaymentOptions(liveOptions) };

it("offers Money only from the explicit live availability flag", () => {
  expect(normalizePaymentOptions({ success: true, data: liveOptions }).swiggypay).toEqual({ available: true, id: "SwiggyPay", label: "Swiggy Money", code: "SwiggyPay" });
  for (const value of [undefined, { allMethods: [{ id: "SwiggyPay" }] }, { swiggyMoney: { available: false } }, { swiggyMoney: { available: "true" } }, { success: false, data: liveOptions }]) {
    expect(normalizePaymentOptions(value, ["SwiggyPay"]).swiggypay.available).toBe(false);
  }
});

it("rechecks live availability and sends only the inline wallet checkout contract", async () => {
  const calls = [];
  const order = { normalizedStatus: "success", status: "CONFIRMED", orderId: "confirmed-order" };
  const mcp = { async call(name, args) { calls.push({ name, args }); return name === "get_payment_options" ? liveOptions : order; } };
  expect(await placeConfirmedCart(mcp, suggestion, "SWIGGYPAY")).toEqual({ paymentMethod: "SWIGGYPAY", order });
  expect(calls).toEqual([
    { name: "get_payment_options", args: { addressId: "saved-address" } },
    { name: "place_food_order", args: { addressId: "saved-address", paymentMethod: "SwiggyPay" } },
  ]);
});

it("does not debit when Money is no longer available", async () => {
  const calls = [];
  await expect(placeConfirmedCart({ async call(name) { calls.push(name); return {}; } }, suggestion, "SWIGGYPAY")).rejects.toThrow("not available");
  expect(calls).toEqual(["get_payment_options"]);
});

it("refreshes alternate methods after a confirmed decline without retrying the wallet", async () => {
  const calls = [];
  const result = await placeConfirmedCart({ async call(name) {
    calls.push(name);
    return name === "get_payment_options" ? liveOptions : { normalizedStatus: "failed", status: "FAILED", message: "Balance is insufficient" };
  } }, suggestion, "SwiggyPay");
  expect(result.declined).toBe(true);
  expect(result.message).toContain("Balance is insufficient");
  expect(result.paymentOptions.swiggypay.available).toBe(false);
  expect(result.paymentOptions.cod.available).toBe(true);
  expect(calls).toEqual(["get_payment_options", "place_food_order", "get_payment_options"]);
});

it("never treats transport errors as confirmed non-payment or retries the debit", async () => {
  const calls = [];
  const result = await placeConfirmedCart({ async call(name) {
    calls.push(name);
    if (name === "get_payment_options") return liveOptions;
    throw new Error("Connection lost after submission");
  } }, suggestion, "SWIGGYPAY");
  expect(result.reviewRequired).toBe(true);
  expect(result.order).toBeUndefined();
  expect(result.message).toContain("outcome is unknown");
  expect(calls).toEqual(["get_payment_options", "place_food_order"]);
});

it("keeps unsettled or ambiguous wallet orders out of the success flow", async () => {
  for (const order of [{ orderId: "unsettled", status: "PENDING_PAYMENT", normalizedStatus: "pending" }, { orderId: "ambiguous", status: "CONFIRMED", normalizedStatus: "pending" }, { orderId: "failed-order", status: "FAILED" }, { message: "Request accepted" }]) {
    const result = await placeConfirmedCart({ async call(name) { return name === "get_payment_options" ? liveOptions : order; } }, suggestion, "SWIGGYPAY");
    expect(result.reviewRequired).toBe(true);
    expect(result.order).toBe(order);
    if (order.orderId) expect(result.message).toContain(order.orderId);
    expect(swiggyMoneyOutcome(order)).toBe("unknown");
  }
});

it("preserves COD and UPI request contracts", async () => {
  const options = normalizePaymentOptions({ ...liveOptions, platforms: { desktop: { methods: [{ id: "PayWithQR", kind: "qr", displayName: "UPI" }] } } });
  for (const method of ["COD", "UPI"]) {
    const calls = [];
    await placeConfirmedCart({ async call(name, args) {
      calls.push({ name, args });
      return method === "UPI" ? { orderId: "pending", upiIntentUrl: "upi://pay?pa=merchant" } : { orderId: "cash-order", status: "CONFIRMED" };
    } }, { ...suggestion, paymentOptions: options }, method);
    expect(calls).toEqual([{ name: "place_food_order", args: method === "UPI" ? { addressId: "saved-address", paymentMethod: "UPI", generateUPIQR: true } : { addressId: "saved-address", paymentMethod: "Cash" } }]);
  }
});
