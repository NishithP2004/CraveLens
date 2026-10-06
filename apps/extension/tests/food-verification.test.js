import test from "node:test";
import assert from "node:assert/strict";
import { foodVerificationInstruction, parseVerification } from "../src/food-verification.js";
import { foodCravingIdentity } from "@cravelens/shared";
const primary = { isFood: true, dish: "Rice", cuisine: "Indian", description: "Rice and dal", ingredients: ["rice"], confidence: .9, context: "ready_to_eat" };
const dishes = [
  { dish: "Rice", cuisine: "Indian", description: "Steamed rice", ingredients: ["rice"], confidence: .9 },
  { dish: "Dal", cuisine: "Indian", description: "Yellow lentils", ingredients: ["lentils"], confidence: .8 },
];
test("preserves separate dish descriptions, ingredients and uncertainty", () => {
  const parsed = parseVerification(JSON.stringify({ ...primary, dishes }));
  assert.deepEqual(parsed.dishes, dishes);
  assert.equal(parsed.dish, "Rice");
});
test("accepts legacy single-dish results without inventing additional dishes", () => {
  assert.deepEqual(parseVerification(JSON.stringify(primary)).dishes, []);
});
test("rejects invalid or oversized dish arrays rather than dropping evidence", () => {
  assert.throws(() => parseVerification(JSON.stringify({ ...primary, dishes: [...dishes, { ...dishes[0], confidence: 2 }] })));
  assert.throws(() => parseVerification(JSON.stringify({ ...primary, dishes: Array(9).fill(dishes[0]) })));
});
test("instructs all local vision providers to report multiple visible dishes conservatively", () => {
  const prompt = foodVerificationInstruction("Meal screenshot");
  assert.match(prompt, /only the main prepared dishes/);
  assert.match(prompt, /Ignore garnishes, condiments, dips, small side accompaniments/);
  assert.match(prompt, /at most 8/);
  assert.match(prompt, /never invent hidden ingredients/);
  assert.match(prompt, /dishes:\[\] for non-food/);
});
test("deduplicates confidence variation but distinguishes a changed side dish", () => {
  const first = { ...primary, dishes };
  const confidenceChange = { ...first, confidence: .8, dishes: dishes.map((dish) => ({ ...dish, confidence: .7 })) };
  assert.deepEqual(foodCravingIdentity(first), foodCravingIdentity(confidenceChange));
  assert.notDeepEqual(foodCravingIdentity(first), foodCravingIdentity({ ...first, dishes: [dishes[0]] }));
});

test("keeps all six dishes when the VLM omits their cuisine labels", () => {
  const withoutCuisine = Array.from({ length: 6 }, (_, index) => ({ dish: `Dish ${index + 1}`, description: "Visible food", ingredients: ["rice"], confidence: .8 }));
  const parsed = parseVerification(JSON.stringify({ ...primary, dishes: withoutCuisine }));
  assert.equal(parsed.dishes.length, 6);
  assert.deepEqual(parsed.dishes.map((dish) => dish.cuisine), Array(6).fill("unknown"));
  assert.deepEqual(parsed.dishes.map(({ cuisine, ...dish }) => dish), withoutCuisine);
  assert.throws(() => parseVerification(JSON.stringify({ ...primary, dishes: [{ ...withoutCuisine[0], cuisine: 42 }] })));
});
