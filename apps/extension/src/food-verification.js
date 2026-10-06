import { FoodVerificationSchema } from "@cravelens/shared";

export function foodVerificationInstruction(videoTitle, transcriptText = "No transcript context was available.") {
  return `Inspect the image. Pixels are authoritative; title and transcript are weak hints. Return only minified JSON: {"isFood":boolean,"dish":string,"description":string,"cuisine":string,"ingredients":string[],"confidence":number,"context":"ready_to_eat"|"recipe"|"restaurant_experience","dishes":[{"dish":string,"description":string,"cuisine":string,"ingredients":string[],"confidence":number}]}. Identify only the main prepared dishes that are the visual focus of this frame, ordered by prominence, with separate confidence and visible ingredients (at most 8). Ignore garnishes, condiments, dips, small side accompaniments, isolated ingredients, drinks and incidental background food. Do not report every edible object. A separately served substantial dish can be a main dish; an ingredient or garnish of another dish cannot. Keep each dish description under 120 characters and list at most 5 visible ingredients. Do not split one dish into its ingredients or duplicate portions. Set top-level dish/cuisine/ingredients to the most prominent dish and description to a brief overview of all dishes. Top-level confidence describes food presence; each dish confidence describes its identification. Return dishes:[] for non-food. Use "unknown" when a dish cuisine cannot be identified. Be conservative; never invent hidden ingredients. Title: ${String(videoTitle || "YouTube video").slice(0, 240)}\n${transcriptText}`;
}

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

