import test from "node:test";
import assert from "node:assert/strict";
import { renderVlmDebugResult } from "../src/debug-vlm.js";
test("renders every VLM dish with independent confidence and uncertainty", () => {
  const dishes = Array.from({ length: 8 }, (_, i) => ({ dish: `Dish ${i}`, confidence: i === 7 ? .4 : .9, cuisine: "Indian", ingredients: ["rice"], description: `Description ${i}` }));
  const html = renderVlmDebugResult({ isFood: true, confidence: .95, context: "ready_to_eat", dishes });
  assert.match(html, /8 VLM dishes/);
  assert.equal((html.match(/<li /g) || []).length, 8);
  assert.match(html, /Dish 7/); assert.match(html, /40%/); assert.match(html, /Low confidence/);
  assert.match(html, /Food presence 95%/); assert.match(html, /Description 7/);
});
test("escapes model text in every displayed field", () => {
  const html = renderVlmDebugResult({ isFood: true, context: '<img src=x>', dishes: [{ dish: '<script>x</script>', cuisine: '<b>x</b>', ingredients: ['<iframe>'], description: '<img>', confidence: .9 }] });
  assert.doesNotMatch(html, /<script>|<img|<iframe>|<b>x/);
  assert.match(html, /&lt;script&gt;/);
});
test("supports legacy results and does not list dishes for a non-food verdict", () => {
  assert.match(renderVlmDebugResult({ isFood: true, dish: "Rice", confidence: .9 }), /legacy single-dish result/);
  const html = renderVlmDebugResult({ isFood: false, confidence: .1, dishes: [{ dish: "Rice" }] });
  assert.match(html, /0 VLM dishes/); assert.doesNotMatch(html, /<li /);
  assert.match(renderVlmDebugResult(null, '<loading>'), /&lt;loading&gt;/);
});
