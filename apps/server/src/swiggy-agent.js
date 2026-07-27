import { webcrypto } from "node:crypto";
import { createAgent, createMiddleware, tool } from "langchain";
import { ChatGoogle } from "@langchain/google";
import { MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage } from "@langchain/core/messages";
import { config } from "./config.js";
import { publishAgentEvent } from "./agent-events.js";
import { AgentFollowUpSchema } from "@cravelens/shared";
import { createLangfuseHandler } from "./langfuse.js";

// LangGraph's UUID implementation uses the Web Crypto global. Node 20 exposes
// it by default; provide the standards-compatible Node implementation on 18.
globalThis.crypto ??= webcrypto;

const SAFE_TOOLS = new Set([
  "get_addresses",
  "get_food_orders",
  "get_food_order_details",
  "search_restaurants",
  "search_menu",
  "get_restaurant_menu",
  "flush_food_cart",
  "get_food_cart",
  "update_food_cart",
  "fetch_food_coupons",
  "apply_food_coupon",
]);
const ADDRESS_TOOLS = new Set([
  "search_restaurants", "search_menu", "get_restaurant_menu", "get_food_cart",
  "update_food_cart", "fetch_food_coupons", "apply_food_coupon", "flush_food_cart",
]);
const conversationMemory = new MemorySaver();
const AGENT_MAX_MODEL_CALLS = 16;
const TOOL_CHOICE_MISMATCH_MAX_RETRIES = 2;
const TRANSIENT_MODEL_MAX_RETRIES = 3;
const TRANSIENT_MODEL_RETRY_DELAYS_MS = [500, 1_500, 3_000];
const SEARCH_TOOL_LIMITS = {
  search_menu: 5,
  search_restaurants: 2,
  get_restaurant_menu: 2,
};

export function shouldFinalizeCartAgent({ modelCallCount = 0, cartUpdated = false, couponsChecked = false, verificationPending = false } = {}) {
  return modelCallCount >= AGENT_MAX_MODEL_CALLS
    || (cartUpdated && couponsChecked && !verificationPending);
}

export async function runFoodCartAgent(mcp, { food, addressId, addressSummary, streamId, threadId, instruction, currentSuggestion, personalContext = "", temporalContext }) {
  if (!["gemini", "openai"].includes(config.agentModelProvider)) throw new Error(`Unsupported agent provider: ${config.agentModelProvider}`);
  if (!config.agentModelApiKey) throw new Error("AGENT_MODEL_API_KEY is required for Swiggy cart orchestration.");

  const runId = crypto.randomUUID().slice(0, 8);
  let selectedRestaurantName = currentSuggestion?.restaurant;
  let selectedRestaurantId = currentSuggestion?.restaurantId;
  let appliedCouponCode = currentSuggestion?.coupon;
  let cartMutationItems = currentSuggestion?.cartMutationItems;
  const loopState = {
    modelCallCount: 0,
    cartUpdated: false,
    couponsChecked: false,
    verificationPending: false,
  };
  const searchBudget = createSearchBudgetGuard();
  const startedAt = performance.now();
  agentLog(runId, streamId, "started", { dish: food.dish, context: food.context, model: config.agentModelName });
  const definitions = (await mcp.listTools()).filter((definition) => SAFE_TOOLS.has(definition.name));
  agentLog(runId, streamId, "tools_ready", { count: definitions.length, tools: definitions.map((definition) => definition.name) });
  const tools = definitions.map((definition) => tool(
    async (input) => {
      const args = { ...(input || {}) };
      if (ADDRESS_TOOLS.has(definition.name)) args.addressId = addressId;
      const searchDecision = searchBudget.check(definition.name, args);
      if (!searchDecision.allowed) {
        agentLog(runId, streamId, "tool_skipped", {
          tool: definition.name,
          reason: searchDecision.reason,
          remaining: searchDecision.remaining,
        });
        return JSON.stringify({
          success: false,
          error: {
            code: searchDecision.reason,
            message: searchDecision.message,
          },
          searchBudget: { remaining: searchDecision.remaining },
        });
      }
      if (definition.name === "update_food_cart") {
        const restaurantName = args.restaurantName || args.restaurant_name || args.restaurant?.name;
        const restaurantId = args.restaurantId || args.restaurant_id || args.restaurant?.id;
        const submittedItems = args.cartItems || args.cart_items || args.items;
        const verifiedRestaurantName = validToolRestaurantName(restaurantName);
        if (verifiedRestaurantName) selectedRestaurantName = verifiedRestaurantName;
        if (restaurantId !== undefined && restaurantId !== null && String(restaurantId).trim()) selectedRestaurantId = String(restaurantId).trim();
        if (Array.isArray(submittedItems)) cartMutationItems = structuredClone(submittedItems);
      }
      if (definition.name === "apply_food_coupon") {
        const couponCode = args.couponCode || args.coupon_code || args.code;
        if (typeof couponCode === "string" && couponCode.trim()) appliedCouponCode = couponCode.trim();
      }
      const toolStartedAt = performance.now();
      agentLog(runId, streamId, "tool_call", { tool: definition.name, args: safeToolArgs(args) });
      try {
        const result = await mcp.call(definition.name, args);
        if (definition.name === "update_food_cart") {
          loopState.cartUpdated = true;
          loopState.couponsChecked = false;
          loopState.verificationPending = true;
        }
        if (definition.name === "fetch_food_coupons") loopState.couponsChecked = true;
        if (definition.name === "apply_food_coupon") loopState.verificationPending = true;
        if (definition.name === "get_food_cart" && loopState.cartUpdated) loopState.verificationPending = false;
        if (["update_food_cart", "get_food_cart"].includes(definition.name)) {
          selectedRestaurantName = findToolRestaurantName(result) || selectedRestaurantName;
        }
        agentLog(runId, streamId, "tool_complete", { tool: definition.name, durationMs: elapsed(toolStartedAt) });
        return JSON.stringify(result);
      } catch (error) {
        if (definition.name === "fetch_food_coupons") loopState.couponsChecked = true;
        agentLog(runId, streamId, "tool_failed", { tool: definition.name, durationMs: elapsed(toolStartedAt), error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    {
      name: definition.name,
      description: definition.description || `Swiggy MCP tool ${definition.name}`,
      schema: normalizeToolSchema(definition.inputSchema),
    },
  ));

  const agent = createAgent({
    model: createAgentModel(),
    tools,
    checkpointer: conversationMemory,
    middleware: [createMiddleware({
      name: "CraveLensCartLoopGuard",
      wrapModelCall: async (request, handler) => {
        loopState.modelCallCount += 1;
        let modelRequest = request;
        if (shouldFinalizeCartAgent(loopState)) {
          const reason = loopState.modelCallCount >= AGENT_MAX_MODEL_CALLS ? "model_call_limit" : "cart_verified";
          agentLog(runId, streamId, "finalizing", { reason, modelCallCount: loopState.modelCallCount });
          modelRequest = replaceSystemInstruction({
            ...request,
            tools: [],
          }, `You are finalizing a CraveLens Swiggy cart run. Tools are disabled for this turn, so never call or name a tool.
Return immediately in exactly this format:
CART_RATIONALE:
<brief factual summary based only on completed tool results; clearly say if no cart was built>
HUMAN_INPUT_UI:
<a valid compact version-1 JSON form when user input is required, otherwise NONE>
Use the CraveLens version-1 fields format shown in the main instructions. Never return JSON Schema with top-level type, properties, or required keys.
Do not continue searching. Do not claim a cart was updated or verified unless the completed tool results prove it.`);
        }
        return invokeModelWithToolChoiceRetry(modelRequest, handler, {
          onRetry: ({ attempt, reason, delayMs }) => {
            loopState.modelCallCount += 1;
            agentLog(runId, streamId, "model_retry", {
              attempt,
              reason,
              ...(delayMs ? { delayMs } : {}),
            });
          },
        });
      },
    })],
    systemPrompt: `You are CraveLens' Swiggy Food ReAct cart agent. You may prepare and optimize a real cart, but you must NEVER place an order.

Complete the task through tool calls; do not merely describe what should be done.
When the user sends a follow-up request, continue the existing cart conversation, inspect the current cart, and modify or replace it to satisfy the new instruction.
The user may provide a PERSONAL CONTEXT block and a trusted CURRENT DATETIME block. Apply time-dependent preferences using the supplied local day and datetime. Treat explicit current personal context as higher priority than inferred order-history patterns, while continuing to treat allergies and safety constraints as hard constraints.
1. Call get_addresses first and use only addressId ${addressId} (${addressSummary}). Every location-sensitive tool must use that address.
2. Inspect get_food_orders and relevant get_food_order_details. Infer favorite dishes/restaurants at this location, vegetarian patterns, repeated special instructions, allergens, and items or ingredients to avoid. Treat allergy/avoidance evidence as a hard safety constraint; do not invent one.
3. Search for the detected dish. Prefer search_menu because it returns orderable item IDs and full variants/add-ons. If a literal query fails, reason about close menu synonyms and retry. Ramen may appear as Japanese noodles, noodle bowl, tonkotsu, shoyu, miso ramen, or instant ramen; never stop after one empty literal match.
3a. Search calls are deliberately bounded: at most 5 search_menu calls, 2 search_restaurants calls, and 2 get_restaurant_menu calls. Never repeat the same normalized query in the same restaurant scope. Before the budget is exhausted, choose the best orderable item already found and proceed to update_food_cart. If no orderable match exists, stop searching and return a HUMAN_INPUT_UI choice using the closest alternatives already found.
4. Optimize the cart jointly for preference fit and total delivered cost. Compare multiple OPEN, serviceable candidates using order history, dietary patterns, restaurant/item rating, distance, item price, fees, portion/value, and eligible payment-neutral discounts. Do not choose the cheapest option when it is a materially worse preference match; when candidates fit similarly, prefer the lower verified final payable amount. Briefly explain the cost/preference tradeoff in CART_RATIONALE.
5. Select an orderable item configuration consistent with the profile. Preserve the exact variants/variantsV2 and addon shapes returned by Swiggy. Never select an ingredient that conflicts with an allergy or avoidance.
6. Call update_food_cart with the exact current schema, including addressId, restaurantId, restaurantName, and cartItems. restaurantName must contain only the exact restaurant display name from Swiggy—never rationale, choices, or a follow-up question.
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
Never put a question or choice for the user inside CART_RATIONALE. Never wrap the JSON in Markdown fences. The application—not you—renders the follow-up form and asks the user for final order confirmation.`,
  });

  agentLog(runId, streamId, "reasoning_started");
  try {
    const preferenceContext = `CURRENT DATETIME:
${JSON.stringify(temporalContext || {})}
PERSONAL CONTEXT:
${personalContext ? personalContext : "None provided"}`;
    const userMessage = instruction
      ? `Continue customizing the existing verified Swiggy cart. Apply this user instruction through tool calls: ${instruction}
${preferenceContext}
Current cart context: ${JSON.stringify(currentSuggestion)}
Keep using selected delivery address ${addressSummary} (${addressId}). Verify the resulting cart before finishing.`
      : `Prepare a personalized Swiggy Food cart for this locally identified video dish:
${JSON.stringify(food)}
${preferenceContext}
Selected delivery address: ${addressSummary} (${addressId}).`;
    const langfuseHandler = createLangfuseHandler({
      sessionId: threadId,
      traceMetadata: {
        provider: config.agentModelProvider,
        model: config.agentModelName,
        streamId,
        runId,
      },
    });
    const result = await agent.invoke({
      messages: [{ role: "user", content: userMessage }],
    }, {
      recursionLimit: 64,
      configurable: { thread_id: threadId },
      ...(langfuseHandler ? { callbacks: [langfuseHandler] } : {}),
    });
    const final = [...result.messages].reverse().find((message) => message.getType?.() === "ai" || message.type === "ai");
    agentLog(runId, streamId, "completed", { durationMs: elapsed(startedAt), messageCount: result.messages.length });
    const response = splitAgentResponse(textContent(final?.content));
    return {
      rationale: response.rationale,
      agentPrompt: response.agentPrompt,
      agentFollowUp: response.agentFollowUp,
      restaurantId: selectedRestaurantId,
      restaurantName: selectedRestaurantName,
      couponCode: appliedCouponCode,
      cartMutationItems,
      cartUpdated: loopState.cartUpdated,
      cartVerified: loopState.cartUpdated && !loopState.verificationPending,
    };
  } catch (error) {
    agentLog(runId, streamId, "failed", { durationMs: elapsed(startedAt), error: error instanceof Error ? error.message : String(error) });
    if (/recursion limit|GRAPH_RECURSION_LIMIT/i.test(error instanceof Error ? error.message : String(error))
      && loopState.cartUpdated && !loopState.verificationPending) {
      return {
        rationale: "The cart was updated and verified with Swiggy. CraveLens stopped the agent after it exceeded its reasoning budget.",
        agentPrompt: "",
        agentFollowUp: undefined,
        restaurantId: selectedRestaurantId,
        restaurantName: selectedRestaurantName,
        couponCode: appliedCouponCode,
        cartMutationItems,
        cartUpdated: loopState.cartUpdated,
        cartVerified: loopState.cartUpdated && !loopState.verificationPending,
      };
    }
    throw error;
  }
}

export async function invokeModelWithToolChoiceRetry(request, handler, {
  maxRetries = TOOL_CHOICE_MISMATCH_MAX_RETRIES,
  transientMaxRetries = TRANSIENT_MODEL_MAX_RETRIES,
  transientRetryDelaysMs = TRANSIENT_MODEL_RETRY_DELAYS_MS,
  onRetry,
  sleep = wait,
} = {}) {
  let currentRequest = request;
  let toolChoiceRetries = 0;
  let transientRetries = 0;
  for (;;) {
    try {
      return await handler(currentRequest);
    } catch (error) {
      if (isToolChoiceMismatchError(error) && toolChoiceRetries < maxRetries) {
        toolChoiceRetries += 1;
        await onRetry?.({ attempt: toolChoiceRetries, reason: "tool_choice_mismatch", delayMs: 0, error });
        currentRequest = appendSystemInstruction(
          currentRequest,
          "The previous model generation attempted a tool call even though tools are disabled for this model turn. Retry now without calling or naming a tool. Respond only with the requested final text format.",
        );
        continue;
      }
      if (isTransientModelError(error) && transientRetries < transientMaxRetries) {
        transientRetries += 1;
        const delayMs = transientRetryDelaysMs[Math.min(transientRetries - 1, transientRetryDelaysMs.length - 1)] || 0;
        await onRetry?.({ attempt: transientRetries, reason: "transient_model_error", delayMs, error });
        if (delayMs > 0) await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }
}

export function appendSystemInstruction(request, instruction) {
  const suffix = `\n\n${String(instruction || "").trim()}`;
  if (request?.systemMessage && typeof request.systemMessage.concat === "function") {
    return {
      ...request,
      // Keep this synchronized with the current SystemMessage so LangChain sees
      // only systemMessage as changed, including on consecutive retries.
      systemPrompt: request.systemMessage.text,
      systemMessage: request.systemMessage.concat(suffix),
    };
  }
  return {
    ...request,
    systemPrompt: `${request?.systemPrompt || ""}${suffix}`,
  };
}

export function replaceSystemInstruction(request, instruction) {
  const content = String(instruction || "").trim();
  if (request?.systemMessage) {
    return {
      ...request,
      systemPrompt: request.systemMessage.text,
      systemMessage: new SystemMessage(content),
    };
  }
  return {
    ...request,
    systemPrompt: content,
  };
}

export function createSearchBudgetGuard(limits = SEARCH_TOOL_LIMITS) {
  const counts = new Map();
  const seenQueries = new Set();
  return {
    check(toolName, args = {}) {
      const limit = limits[toolName];
      if (!limit) return { allowed: true, remaining: undefined };
      const count = counts.get(toolName) || 0;
      const query = String(args.query || "").trim().toLowerCase().replace(/\s+/g, " ");
      const restaurantScope = String(args.restaurantIdOfAddedItem || args.restaurantId || "").trim();
      const queryKey = query ? `${toolName}:${restaurantScope}:${query}` : "";
      if (queryKey && seenQueries.has(queryKey)) {
        return {
          allowed: false,
          reason: "DUPLICATE_SEARCH",
          remaining: Math.max(0, limit - count),
          message: "This search was already completed. Use the existing results and proceed to update the cart, or return the closest alternatives to the user.",
        };
      }
      if (count >= limit) {
        return {
          allowed: false,
          reason: "SEARCH_BUDGET_EXHAUSTED",
          remaining: 0,
          message: `The ${toolName} budget is exhausted. Do not search again; use an existing orderable result to update the cart, or return the closest alternatives to the user.`,
        };
      }
      counts.set(toolName, count + 1);
      if (queryKey) seenQueries.add(queryKey);
      return { allowed: true, remaining: limit - count - 1 };
    },
  };
}

export function isToolChoiceMismatchError(error) {
  const message = modelErrorText(error);
  return /tool choice is none,\s*but model called a tool/i.test(message)
    || (/tool_use_failed/i.test(message) && /tool choice[\s\S]*none[\s\S]*called a tool/i.test(message));
}

export function isTransientModelError(error) {
  const message = modelErrorText(error);
  return /\b(?:429|500|502|503|504)\b/.test(message)
    || /service unavailable|temporar(?:y|ily) (?:unavailable|unreachable)|no_db_connection|rate.?limit|timed? ?out|econnreset|econnrefused|socket hang up/i.test(message);
}

function modelErrorText(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 6 && !seen.has(current); depth += 1) {
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    seen.add(current);
    for (const value of [
      current.name, current.message, current.status, current.code, current.type,
      current.error?.message, current.error?.code, current.error?.type,
    ]) {
      if (value !== undefined && value !== null) parts.push(String(value));
    }
    current = current.cause;
  }
  return parts.join(" ");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function splitAgentResponse(content) {
  const fallback = "Prepared and verified by the CraveLens Swiggy ReAct agent.";
  const text = String(content || "").trim();
  if (!text) return { rationale: fallback, agentPrompt: "", agentFollowUp: undefined };

  const rationaleMarker = text.match(/(?:^|\n)\s*(?:\*\*)?CART_RATIONALE\s*:\s*(?:\*\*)?\s*/i);
  const uiMarker = text.match(/(?:^|\n)\s*(?:\*\*)?HUMAN_INPUT_UI\s*:\s*(?:\*\*)?\s*/i);
  const promptMarker = text.match(/(?:^|\n)\s*(?:\*\*)?(?:HUMAN_INPUT_REQUIRED|FOLLOW_UP)\s*:\s*(?:\*\*)?\s*/i);
  if (uiMarker) {
    const rationaleStart = rationaleMarker ? rationaleMarker.index + rationaleMarker[0].length : 0;
    const rationale = text.slice(rationaleStart, uiMarker.index).trim() || fallback;
    const raw = text.slice(uiMarker.index + uiMarker[0].length).trim();
    if (/^(?:none|n\/a|not required)\.?(?:\s|$)/i.test(raw)) return { rationale, agentPrompt: "", agentFollowUp: undefined };
    try {
      const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      const jsonStart = unfenced.indexOf("{");
      const jsonEnd = unfenced.lastIndexOf("}");
      const payload = jsonStart >= 0 && jsonEnd > jsonStart ? unfenced.slice(jsonStart, jsonEnd + 1) : unfenced;
      const parsed = normalizeAgentFollowUpPayload(JSON.parse(payload));
      if (parsed) return { rationale, agentPrompt: "", agentFollowUp: parsed };
    } catch { /* Fall through to a safe text prompt for malformed model output. */ }
    return { rationale, agentPrompt: raw, agentFollowUp: undefined };
  }
  if (promptMarker) {
    const rationaleStart = rationaleMarker ? rationaleMarker.index + rationaleMarker[0].length : 0;
    const rationale = text.slice(rationaleStart, promptMarker.index).trim() || fallback;
    const prompt = text.slice(promptMarker.index + promptMarker[0].length).trim();
    return { rationale, agentPrompt: /^(?:none|n\/a|not required)\.?$/i.test(prompt) ? "" : prompt, agentFollowUp: undefined };
  }

  // Backward-compatible separation for model responses created before the
  // explicit output contract was introduced.
  const humanPrompt = text.match(/\n\s*(?=(?:Would you like(?:\s+me)?\s+to|Which (?:option|one)|What would you prefer|Please (?:choose|select|confirm))\b)/i);
  if (humanPrompt?.index !== undefined) {
    return {
      rationale: text.slice(0, humanPrompt.index).trim() || fallback,
      agentPrompt: text.slice(humanPrompt.index).trim(),
      agentFollowUp: undefined,
    };
  }
  return {
    rationale: rationaleMarker ? text.slice(rationaleMarker.index + rationaleMarker[0].length).trim() || fallback : text,
    agentPrompt: "",
    agentFollowUp: undefined,
  };
}

export function normalizeAgentFollowUpPayload(payload) {
  const native = AgentFollowUpSchema.safeParse(payload);
  if (native.success) return native.data;
  if (!payload || payload.type !== "object" || !payload.properties || typeof payload.properties !== "object") return undefined;

  const requiredFields = new Set(Array.isArray(payload.required) ? payload.required.map(String) : []);
  const fields = Object.entries(payload.properties).slice(0, 4).flatMap(([rawId, definition]) => {
    if (!definition || typeof definition !== "object") return [];
    const id = normalizeFollowUpFieldId(rawId);
    if (!id) return [];
    const label = boundedText(definition.title || humanizeFollowUpFieldId(rawId), 240);
    if (!label) return [];
    const enumOptions = followUpEnumOptions(definition);
    const isArray = definition.type === "array";
    const options = isArray ? followUpEnumOptions(definition.items) : enumOptions;
    const type = options.length
      ? isArray ? "checkbox" : options.length > 4 ? "select" : "radio"
      : definition.type === "string" && (definition.format === "textarea" || Number(definition.maxLength) > 200)
        ? "textarea"
        : "text";
    const defaultValue = followUpDefaultValue(definition, options);
    const field = {
      id,
      type,
      label,
      required: requiredFields.has(rawId),
      ...(boundedText(definition.description, 240) ? { placeholder: boundedText(definition.description, 240) } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      ...(options.length ? { options: options.slice(0, 12) } : {}),
    };
    return [field];
  });
  if (!fields.length) return undefined;

  const converted = AgentFollowUpSchema.safeParse({
    version: 1,
    title: boundedText(payload.title || "Choose an option", 100),
    ...(boundedText(payload.description, 400) ? { description: boundedText(payload.description, 400) } : {}),
    fields,
    submitLabel: boundedText(payload.submitLabel || "Continue", 40),
  });
  return converted.success ? converted.data : undefined;
}

function normalizeFollowUpFieldId(value) {
  const id = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return /^[a-z][a-z0-9_]{0,39}$/.test(id) ? id : "";
}

function humanizeFollowUpFieldId(value) {
  const text = String(value || "").replace(/[_-]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "Your choice";
}

function followUpEnumOptions(definition) {
  if (!definition || typeof definition !== "object") return [];
  if (Array.isArray(definition.enum)) {
    return definition.enum
      .filter((value) => ["string", "number", "boolean"].includes(typeof value))
      .map((value) => ({ value: String(value).slice(0, 120), label: String(value).slice(0, 160) }));
  }
  if (Array.isArray(definition.oneOf)) {
    return definition.oneOf.flatMap((option) => {
      if (!option || typeof option !== "object" || option.const === undefined) return [];
      return [{
        value: String(option.const),
        label: boundedText(option.title || option.const, 160),
        ...(boundedText(option.description, 240) ? { description: boundedText(option.description, 240) } : {}),
      }];
    });
  }
  return [];
}

function followUpDefaultValue(definition, options) {
  const rawDefault = definition?.default;
  if (rawDefault === undefined) return undefined;
  const values = (Array.isArray(rawDefault) ? rawDefault : [rawDefault]).map(String);
  const allowed = new Set(options.map((option) => option.value));
  const normalized = values.filter((value) => !options.length || allowed.has(value)).map((value) => value.slice(0, 120));
  if (!normalized.length) return undefined;
  return Array.isArray(rawDefault) ? normalized : normalized[0];
}

function boundedText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function createAgentModel() {
  if (config.agentModelProvider === "openai") {
    return new ChatOpenAI({
      model: config.agentModelName,
      apiKey: config.agentModelApiKey,
      temperature: 1,
      maxTokens: 2048,
      maxRetries: 0,
      configuration: { baseURL: config.agentModelBaseUrl },
    });
  }
  return new ChatGoogle(config.agentModelName, { apiKey: config.agentModelApiKey, temperature: 0.7, maxOutputTokens: 2048 });
}

function agentLog(runId, streamId, event, details = {}) {
  console.log(`[agent:${runId}] ${event}`, Object.keys(details).length ? details : "");
  publishAgentEvent(streamId, event, details);
}

function elapsed(startedAt) { return Math.round(performance.now() - startedAt); }

function safeToolArgs(args) {
  const safe = { ...args };
  if (safe.addressId) safe.addressId = "[selected]";
  if (safe.cartItems) safe.cartItems = `[${safe.cartItems.length} item(s)]`;
  return safe;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part?.text || "").join(" ").trim();
}

function findToolRestaurantName(value, parentKey = "", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
    if (["restaurantname", "restaurantdisplayname", "outletname", "storename"].includes(normalized)) {
      const name = validToolRestaurantName(child);
      if (name) return name;
    }
    if (/restaurant|outlet|store/i.test(parentKey) && /^(name|title|displayname)$/.test(normalized)) {
      const name = validToolRestaurantName(child);
      if (name) return name;
    }
  }
  for (const [key, child] of Object.entries(value)) {
    const found = findToolRestaurantName(child, key, seen);
    if (found) return found;
  }
  return "";
}

function validToolRestaurantName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || /^(?:swiggy\s+)?restaurant(?:\s+name)?$/i.test(name)) return "";
  if (name.length > 120 || name.split(/\s+/).length > 14 || /[\r\n]/.test(name)) return "";
  if (/\b(?:to proceed|please (?:select|choose|confirm)|would you|your existing cart|available alternatives|keep the current cart|which (?:option|one))\b/i.test(name)) return "";
  return name;
}

export function normalizeToolSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  if (Array.isArray(schema)) return schema.map(normalizeToolSchema);

  const source = { ...schema };
  delete source.$schema;
  const alternatives = source.anyOf || source.oneOf;
  delete source.anyOf;
  delete source.oneOf;

  if (Array.isArray(alternatives) && alternatives.length) {
    const normalized = alternatives.map(normalizeToolSchema).filter((value) => value.type !== "null");
    const objects = normalized.filter((value) => value.type === "object" || value.properties);
    if (objects.length) {
      const requiredSets = objects.map((value) => new Set(value.required || []));
      const required = requiredSets.length ? [...requiredSets[0]].filter((key) => requiredSets.every((set) => set.has(key))) : [];
      Object.assign(source, {
        type: "object",
        properties: Object.assign({}, ...objects.map((value) => value.properties || {})),
        ...(required.length ? { required } : {}),
      });
    } else Object.assign(source, normalized[0] || { type: "string" });
  }

  if (Array.isArray(source.type)) source.type = source.type.find((type) => type !== "null") || "string";
  if (Array.isArray(source.enum) && source.enum.some((value) => typeof value !== "string")) {
    const numericValues = source.enum.filter((value) => typeof value === "number");
    delete source.enum;
    if (numericValues.length) {
      source.type = numericValues.every(Number.isInteger) ? "integer" : "number";
      source.minimum = Math.min(...numericValues);
      source.maximum = Math.max(...numericValues);
      source.description = `${source.description ? `${source.description} ` : ""}Allowed values: ${numericValues.join(", ")}.`;
    }
  }
  if (source.const !== undefined && typeof source.const !== "string") delete source.const;
  if (source.properties) source.properties = Object.fromEntries(Object.entries(source.properties).map(([key, value]) => [key, normalizeToolSchema(value)]));
  if (source.items) source.items = normalizeToolSchema(source.items);
  if (source.additionalProperties && typeof source.additionalProperties === "object") source.additionalProperties = normalizeToolSchema(source.additionalProperties);
  for (const key of ["allOf", "prefixItems"]) if (Array.isArray(source[key])) source[key] = source[key].map(normalizeToolSchema);
  return source;
}
