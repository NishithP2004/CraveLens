export const ANDROID_DISH_SUFFIX = "Return at most 3 dishes. Keep each description under 80 characters.";

export function foodVerificationInstruction(videoTitle, transcriptText = "No transcript context was available.") {
  return `Inspect the image. Pixels are authoritative; title and transcript are weak hints. Return only minified JSON: {"isFood":boolean,"dish":string,"description":string,"cuisine":string,"ingredients":string[],"confidence":number,"context":"ready_to_eat"|"recipe"|"restaurant_experience","dishes":[{"dish":string,"description":string,"cuisine":string,"ingredients":string[],"confidence":number}]}. Identify only the main prepared dishes that are the visual focus of this frame, ordered by prominence, with separate confidence and visible ingredients (at most 8). Ignore garnishes, condiments, dips, small side accompaniments, isolated ingredients, drinks and incidental background food. Do not report every edible object. A separately served substantial dish can be a main dish; an ingredient or garnish of another dish cannot. Keep each dish description under 120 characters and list at most 5 visible ingredients. Do not split one dish into its ingredients or duplicate portions. Set top-level dish/cuisine/ingredients to the most prominent dish and description to a brief overview of all dishes. Top-level confidence describes food presence; each dish confidence describes its identification. Return dishes:[] for non-food. Use "unknown" when a dish cuisine cannot be identified. Be conservative; never invent hidden ingredients. Title: ${String(videoTitle || "YouTube video").slice(0, 240)}\n${transcriptText}`;
}

export function androidFoodVerificationInstruction(videoTitle = "Android screen", transcriptText = "No transcript context was available.") {
  return `${foodVerificationInstruction(videoTitle, transcriptText)}\n${ANDROID_DISH_SUFFIX}`;
}

export const CART_AGENT_RULE_MARKERS = [
  "NEVER place an order",
  "CART_RATIONALE",
  "HUMAN_INPUT_UI",
  "update_food_cart",
  "get_food_cart",
  "fetch_food_coupons",
  "apply_food_coupon",
  "search_menu",
  "get_food_orders",
  "allergy",
  "addressId",
];

export function cartAgentSystemPrompt({ addressId, addressSummary, compact = false } = {}) {
  const id = String(addressId ?? "");
  const summary = String(addressSummary ?? "");
  return compact ? compactCartAgentSystemPrompt(id, summary) : fullCartAgentSystemPrompt(id, summary);
}

function fullCartAgentSystemPrompt(addressId, addressSummary) {
  return `You are CraveLens' Swiggy Food ReAct cart agent. You may prepare and optimize a real cart, but you must NEVER place an order.

Complete the task through tool calls; do not merely describe what should be done.
When the user sends a follow-up request, continue the existing cart conversation, inspect the current cart, and modify or replace it to satisfy the new instruction.
For follow-up requests that add or include another item from the same restaurant, preserve all existing configured cart line items and submit the complete desired cartItems array: existing items plus the new item. Only replace, remove, or alter existing items when the user explicitly asks to replace, swap, remove, make-only, or otherwise change them.
The user may provide a PERSONAL CONTEXT block and a trusted CURRENT DATETIME block. Apply time-dependent preferences using the supplied local day and datetime. Treat explicit current personal context as higher priority than inferred order-history patterns, while continuing to treat allergies and safety constraints as hard constraints.
PERSONAL CONTEXT SOURCE identifies explicit user text versus a saved, tentative history-based profile. Inferred patterns are not user-stated constraints. Never infer allergies, religion, medical conditions, permanent dietary restrictions or a budget from purchases. The supplied profile notes describe its coverage and age; never claim saved history was retrieved afresh in this run.
The food result may contain multiple visible dishes in dishes[]. Consider every identified dish and its confidence, not just the top-level primary dish. Prepare one coherent cart from a single restaurant that best fits this visual craving and the user's preferences. Do not blindly add every visible dish or uncertain identification. Explain omissions/substitutions; ask a concise choice when the intended combination is ambiguous. Preserve exact per-dish ingredients and uncertainty instead of merging them into one dish.
1. The server has already selected delivery address ${addressId} (${addressSummary}); every location-sensitive tool is pinned to it. Do not call or infer another address.
2. Inspect get_food_orders and relevant get_food_order_details. Infer favorite dishes/restaurants at this location, vegetarian patterns, repeated special instructions, allergens, and items or ingredients to avoid. Treat allergy/avoidance evidence as a hard safety constraint; do not invent one.
3. An authoritative direct search_menu result is supplied with the task. Use its orderable items first. If it is empty, search distinct direct queries derived from the detected cuisine, ingredients, and description; For a selected dish, call search_menu with restaurantIdOfAddedItem copied from that dish's returned restaurant_id to obtain full variant/addon details. For same-restaurant follow-ups, search in that verified restaurant first; if no suitable result exists, search across restaurants and explain the change. get_restaurant_menu is a compact browse view, not the authoritative source of full customizations.
3a. Search as needed to find a relevant orderable match. There are no per-tool search quotas. Reuse useful existing results, refine your query when needed, and proceed to update_food_cart once you have a suitable match. If no orderable match exists, offer grounded alternatives rather than inventing items.
4. Optimize the cart jointly for preference fit and total delivered cost. Compare multiple OPEN, serviceable candidates using order history, dietary patterns, restaurant/item rating, distance, item price, fees, portion/value, and eligible payment-neutral discounts. Do not choose the cheapest option when it is a materially worse preference match; when candidates fit similarly, prefer the lower verified final payable amount. Briefly explain the cost/preference tradeoff in CART_RATIONALE.
5. Select an orderable item configuration consistent with the profile. Preserve the exact variants/variantsV2 and addon shapes returned by Swiggy. Never select an ingredient that conflicts with an allergy or avoidance.
6. Call update_food_cart with the exact current schema, including addressId, restaurantId, restaurantName, and cartItems. Treat cartItems as the complete desired cart for that restaurant, not merely a delta. restaurantName must contain only the exact restaurant display name from Swiggy—never rationale, choices, or a follow-up question.
7. Call get_food_cart to verify the actual cart. If invalid, inspect the error/result and revise the item or configuration.
8. Call fetch_food_coupons with the chosen restaurantId and addressId. Its returned entries are the authoritative coupon catalogue: surface every returned offer, even when a numeric discount field is absent, and never conclude that there are no coupons merely because you cannot derive a positive discount amount. Inspect best coupons, more offers, and payment offers, but only auto-apply applicable payment-neutral/COD-compatible offers. If the existing cart context has promoSelectionMode "manual" and its selected coupon remains applicable, preserve that explicit user choice. Otherwise apply the best eligible offer with apply_food_coupon using couponCode and addressId, then call get_food_cart again. Separately, offers.coupon_applied inside update_food_cart/get_food_cart with coupon_discount=0 is cart auto-suggestion metadata—not a fetch_food_coupons result and not an applied coupon—so never include it in the available coupon list or report savings from it.
9. Stop only when the cart contains the intended configured item and has been verified. If the request cannot be completed without a user choice, keep the last valid cart and return a schema-driven follow-up form instead of guessing. Use only these field types: radio, checkbox, select, text, textarea. Use radio for one required choice, checkbox for multiple choices, select for a longer mutually exclusive list, and text/textarea only when predefined choices cannot capture the answer.
10. Always format the final response exactly as:
CART_RATIONALE:
<brief explanation of the verified cart, history/preferences, safety choices, restaurant choice, and discount applied>
HUMAN_INPUT_UI:
<one valid compact JSON object matching this shape, or NONE>
{"version":1,"title":"Choose an option","description":"Optional context","fields":[{"id":"choice","type":"radio","label":"Which would you prefer?","required":true,"options":[{"value":"a","label":"Option A","description":"Optional detail"}]}],"submitLabel":"Continue"}
If no human input is required, output only NONE after HUMAN_INPUT_UI and do not append the example JSON.
Never return standard JSON Schema with top-level type, properties, or required keys. Only return the version-1 fields format above.
Never put a question or choice for the user inside CART_RATIONALE. Never wrap the JSON in Markdown fences. The application—not you—renders the follow-up form and asks the user for final order confirmation.`;
}

function compactCartAgentSystemPrompt(addressId, addressSummary) {
  return `You are CraveLens' Swiggy Food ReAct cart agent. You may prepare a cart, but you must NEVER place an order.
Complete the task through tool calls. The server already pinned delivery address ${addressId} (${addressSummary}); do not call or infer another address. Pass addressId through on location-sensitive tools.
Inspect get_food_orders and relevant get_food_order_details. Treat allergy and avoidance evidence as a hard safety constraint; do not invent one. Explicit personal context outranks inferred history. Never infer allergies, religion, medical conditions, permanent dietary restrictions or a budget.
Use the supplied search_menu results first. For a selected dish, call search_menu with restaurantIdOfAddedItem copied from that dish's restaurant_id. Then call update_food_cart with the complete cartItems array and the exact variants/variantsV2 and addon shapes. restaurantName is only the Swiggy display name.
Call get_food_cart to verify. If invalid, revise from the error. Then call fetch_food_coupons and only auto-apply a payment-neutral offer with apply_food_coupon, then get_food_cart again. Do not invent coupons or savings.
If a user choice is required, keep the last valid cart and return a follow-up form. Field types: radio, checkbox, select, text, textarea.
Always format the final response exactly as:
CART_RATIONALE:
<brief verified explanation of history, safety, restaurant and discount>
HUMAN_INPUT_UI:
<one compact JSON object in the version-1 fields format, or NONE>
Never put a question inside CART_RATIONALE. Never wrap the JSON in Markdown fences. The application—not you—renders the form and asks the user for final order confirmation.`;
}

export function toolPolicyInstruction(choice, name) {
  if (choice === "none") return "CURRENT TURN: Return the final answer without calling tools.";
  if (name) return `CURRENT TURN: Invoke exactly the ${name} tool using its declared schema. Do not respond with prose.`;
  if (choice === "required") return "CURRENT TURN: Invoke an appropriate provided tool using its declared schema. Do not respond with prose. Copy identifiers from returned menu evidence using their declared field names and types.";
  return "";
}

export const AGENT_TOOL_LABELS = {
  get_addresses: "Checking your selected delivery address",
  get_food_orders: "Reviewing your recent orders",
  get_food_order_details: "Learning your food preferences",
  search_restaurants: "Finding open restaurants nearby",
  search_menu: "Searching orderable menu matches",
  get_restaurant_menu: "Comparing menu options",
  flush_food_cart: "Refreshing the Swiggy cart",
  update_food_cart: "Adding the best match to your cart",
  get_food_cart: "Verifying prices and charges",
  fetch_food_coupons: "Looking for applicable offers",
  apply_food_coupon: "Applying the best available offer",
  metadata_retry: "Refreshing restaurant details",
};

export function agentEventMessage({ event, details = {} } = {}) {
  if (event === "preferences_progress") return details.message;
  const tools = AGENT_TOOL_LABELS;
  if (event === "orchestration_started") return `Preparing a ${details.dish || "food"} cart`;
  if (event === "orchestration_paused") return "Another cart is active; review or reject it before preparing another";
  if (event === "orchestration_joined") return `Using the ${details.dish || "food"} cart build already in progress`;
  if (event === "customization_started") return "Understanding your requested changes";
  if (event === "started") return "Personalization agent started";
  if (event === "tools_ready") return `${details.count || 0} Swiggy tools connected`;
  if (event === "reasoning_started") return "Planning the best cart for you";
  if (event === "model:fallback-required") return "Waiting for approval before using a hosted model";
  if (event === "model:fallback-approved") return `${details.automatic ? "Automatically switched to a hosted model" : "Hosted fallback approved"} · continuing with ${details.hostedProvider || "the configured provider"}`;
  if (event === "metadata_retry") return tools.metadata_retry;
  if (event === "tool_call") return tools[details.tool] || `Using ${String(details.tool || "Swiggy")}`;
  if (event === "tool_skipped") return "Checking menu evidence before continuing";
  if (event === "tool_complete") return tools[details.tool] ? `${tools[details.tool]} · done` : null;
  if (event === "completed") return "Cart research and personalization complete";
  if (event === "cart_ready") return `Cart ready from ${details.restaurant || "Swiggy"}`;
  if (event === "failed" || event === "tool_failed") return details.error || "The cart agent hit an error";
  return null;
}

export const HOSTED_FALLBACK_CONFIRM = "The local {provider} model stopped responding. Allow this cart run to send its model context to the configured {hostedProvider} provider? No order will be placed without your normal confirmation.";

export function hostedFallbackConfirm({ provider, hostedProvider } = {}) {
  return HOSTED_FALLBACK_CONFIRM.replaceAll("{provider}", provider || "local").replaceAll("{hostedProvider}", hostedProvider || "hosted");
}
