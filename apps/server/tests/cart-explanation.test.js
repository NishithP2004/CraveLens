import { expect, it } from "vitest";
import { activeExplanationModel, decisionToolSummary, evidenceCartExplanation, explanationEvidence, generateCartExplanation } from "../src/cart-explanation.js";

const context = {
  food: { dish: "Biryani", description: "Chicken biryani" },
  personalContext: "Chicken and fish preferred; vegetarian on Thursdays.",
  temporalContext: { localDateTime: "Saturday evening" },
  observations: [{ tool: "get_food_orders", beforeCartUpdate: false, summary: { observedNames: ["Chicken biryani"] } }],
};
const verified = { restaurant: "Paradise", receipt: { items: [{ name: "Royal Chicken Biryani", quantity: 1, customizations: ["Boiled egg"], imageUrl: "private-image", total: 365 }], finalAmount: 421 }, addressId: "private-address" };

it("builds compact explanation evidence from verified cart facts without address data", () => {
  const evidence = explanationEvidence(context, verified);
  expect(evidence.verifiedCart).toMatchObject({ restaurant: "Paradise", payable: 421, items: [{ customizations: ["Boiled egg"] }] });
  expect(JSON.stringify(evidence)).not.toContain("private-address");
  expect(JSON.stringify(evidence)).not.toContain("private-image");
});

it("preserves history timing when many later searches are compacted", () => {
  const earlyHistory = { tool: "get_food_orders", beforeCartUpdate: true, summary: { observedNames: ["Fish curry"] } };
  const observations = [earlyHistory, ...Array.from({ length: 20 }, () => ({ tool: "search_menu", beforeCartUpdate: false, summary: { candidates: [] } }))];
  const evidence = explanationEvidence({ ...context, observations }, verified);
  expect(evidence.observations).toContain(earlyHistory);
  expect(evidence.observations).toHaveLength(7);
  expect(evidence.observationCount).toBe(21);
});

it("does not present unknown menu prices and ratings as free or zero-rated", () => {
  const summary = decisionToolSummary("search_menu", {}, [{ id: "item", name: "Biryani", price: 0, rating: 0 }]);
  expect(summary.candidates[0].price).toBeUndefined();
  expect(summary.candidates[0].rating).toBeUndefined();
});

it("uses the already approved hosted provider without another fallback approval", () => {
  const localModel = {};
  const hostedModel = {};
  expect(activeExplanationModel({ isUsingLocal: () => false, localModel, hostedModel })).toBe(hostedModel);
  expect(activeExplanationModel({ isUsingLocal: () => true, localModel, hostedModel })).toBe(localModel);
  expect(activeExplanationModel(localModel)).toBe(localModel);
});

for (const local of [true, false]) it(`generates a personalized explanation using the active ${local ? "local" : "hosted"} model`, async () => {
  const calls = [];
  const active = { async invoke(messages, options) {
    calls.push({ messages, options });
    return { content: JSON.stringify({ explanation: "Royal Chicken Biryani matches your requested dish and stated chicken preference on Saturday. Swiggy confirmed one serving with boiled egg. History was retrieved after selection." }) };
  } };
  const inactive = { invoke() { throw new Error("Inactive provider must not be called"); } };
  const result = await generateCartExplanation({ isUsingLocal: () => local, localModel: local ? active : inactive, hostedModel: local ? inactive : active }, explanationEvidence(context, verified));
  expect(result.source).toBe("model");
  expect(result.rationale).toContain("chicken preference");
  expect(calls).toHaveLength(1);
  expect(calls[0].messages[0].text).toContain("not a transcript of hidden internal reasoning");
  expect(calls[0].messages[1].text).toContain('"beforeCartUpdate":false');
  expect(calls[0].options.tools).toBeUndefined();
  expect(calls[0].options.tool_choice).toBeUndefined();
});

it("keeps a verified cart useful with a personalized evidence summary when generation fails", async () => {
  const result = await generateCartExplanation({ invoke: async () => { throw new Error("Model unavailable"); } }, explanationEvidence(context, verified));
  expect(result.source).toBe("recorded_evidence");
  expect(result.rationale).toContain("Royal Chicken Biryani");
  expect(result.rationale).toContain("₹421");
  expect(result.rationale).toContain("vegetarian on Thursdays");
  expect(result.rationale).toContain("after the cart update");
});

it("does not expose an explanation tool call or malformed output", async () => {
  for (const response of [{ tool_calls: [{ name: "update_food_cart" }], content: '{}' }, { content: "Not JSON" }, { content: '{"explanation":""}' }]) {
    const result = await generateCartExplanation({ invoke: async () => response }, explanationEvidence(context, verified));
    expect(result.source).toBe("recorded_evidence");
  }
});

it("bounds explanation latency even when a provider ignores cancellation", async () => {
  const result = await generateCartExplanation({ invoke: () => new Promise(() => {}) }, explanationEvidence(context, verified), { timeoutMs: 5 });
  expect(result.source).toBe("recorded_evidence");
});

it("distinguishes absent history from observed history without asserting invented preferences", () => {
  const rationale = evidenceCartExplanation(explanationEvidence({ ...context, observations: [] }, verified));
  expect(rationale).toContain("Order history was not retrieved");
  expect(rationale).not.toContain("favorite");
  const summary = decisionToolSummary("get_food_orders", { orders: [{ address: "private-address", items: [{ name: "Fish curry" }] }] });
  expect(summary.observedNames).toEqual(["Fish curry"]);
  expect(JSON.stringify(summary)).not.toContain("private-address");
});

it("asks for point-form explanations and returns a spaced Markdown list", async () => {
  let prompt;
  const result = await generateCartExplanation({ invoke: async (messages) => { prompt = messages[0].content; return { content: JSON.stringify({ points: ["Matches the requested dish.", "Uses the verified available item."] }) }; } }, explanationEvidence(context, verified));
  expect(prompt).toContain('"points"');
  expect(result.rationale).toBe("- Matches the requested dish.\n\n- Uses the verified available item.");
});
