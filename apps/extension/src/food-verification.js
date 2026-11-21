import { FoodVerificationSchema, foodVerificationInstruction } from "@cravelens/shared";

export { foodVerificationInstruction };

export function parseVerification(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) throw new Error("The configured VLM did not return a JSON object");
  const value = JSON.parse(match[0]);
  console.info("[CraveLens] VLM JSON output:", JSON.stringify(value));
  const contexts = new Set(["ready_to_eat", "recipe", "restaurant_experience"]);
  if (typeof value.isFood !== "boolean" || typeof value.dish !== "string" || !contexts.has(value.context)) throw new Error("The configured VLM returned an invalid food result");
  return FoodVerificationSchema.parse({
    isFood: value.isFood,
    dish: value.dish,
    description: typeof value.description === "string" ? value.description.trim().slice(0, 1200) : "",
    cuisine: typeof value.cuisine === "string" ? value.cuisine : "unknown",
    ingredients: Array.isArray(value.ingredients) ? value.ingredients.filter((item) => typeof item === "string").slice(0, 20) : [],
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    context: value.context,
    dishes: value.dishes ?? [],
  });
}

