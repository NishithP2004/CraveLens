const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const percent = (value) => `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`;

export function renderVlmDebugResult(result, status = "idle") {
  if (!result) return `<div class="debug-gemma-empty">${escape(status)}</div>`;
  const dishes = result.isFood
    ? result.dishes?.length ? result.dishes : [{ ...result, dish: result.dish || "Food" }]
    : [];
  const rows = dishes.map((dish) => `<li class="debug-vlm-dish${dish.confidence < .65 ? " low-confidence" : ""}">
    <div class="debug-gemma-result"><strong>${escape(dish.dish)}</strong><b>${percent(dish.confidence)}</b></div>
    <p>${escape(dish.cuisine || "Cuisine unknown")}${dish.confidence < .65 ? " · Low confidence" : ""}</p>
    ${dish.description ? `<p>${escape(dish.description)}</p>` : ""}
    ${dish.ingredients?.length ? `<p>Visible ingredients: ${dish.ingredients.map(escape).join(", ")}</p>` : ""}
  </li>`).join("");
  return `<p class="debug-vlm-summary">${result.isFood ? "Food detected" : "Not food"} · Food presence ${percent(result.confidence)} · ${escape(String(result.context || "unknown").replaceAll("_", " "))}</p>
    <p class="debug-vlm-count">${dishes.length} VLM ${dishes.length === 1 ? "dish" : "dishes"}${result.isFood && !result.dishes?.length ? " · legacy single-dish result" : ""}</p>
    ${rows ? `<ol class="debug-vlm-dishes" tabindex="0" aria-label="Dishes identified by the VLM">${rows}</ol>` : ""}`;
}
