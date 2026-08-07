import { webcrypto } from "node:crypto";
import { createAgent, createMiddleware, tool } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { publishAgentEvent } from "./agent-events.js";
import { AgentFollowUpSchema } from "@cravelens/shared";
import { createLangfuseHandler } from "./langfuse.js";
import { resolveAgentModel } from "./model-provider.js";
import { requestFallbackApproval } from "./fallback-approval.js";
import { cartReflectsItems } from "./cart-verification.js";
import { normalizeMenuCatalog } from "./swiggy.js";

// LangGraph's UUID implementation uses the Web Crypto global. Node 20 exposes
// it by default; provide the standards-compatible Node implementation on 18.
globalThis.crypto ??= webcrypto;

const SAFE_TOOLS = new Set([
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
const PROSE_RECOVERABLE_READ_TOOLS = new Set([
  "get_food_orders", "get_food_order_details", "search_restaurants",
  "search_menu", "get_restaurant_menu", "get_food_cart", "fetch_food_coupons",
]);
const ADDRESS_TOOLS = new Set([
  "search_restaurants", "search_menu", "get_restaurant_menu", "get_food_cart",
  "update_food_cart", "fetch_food_coupons", "apply_food_coupon", "flush_food_cart",
]);
const conversationMemory = new MemorySaver();
const AGENT_MAX_MODEL_CALLS = 16;
const LOCAL_AGENT_MAX_MODEL_CALLS = 20;
const TOOL_CHOICE_MISMATCH_MAX_RETRIES = 2;
const TRANSIENT_MODEL_MAX_RETRIES = 3;
const TRANSIENT_MODEL_RETRY_DELAYS_MS = [500, 1_500, 3_000];
const MISSING_TOOL_CALL_MAX_RETRIES = 2;
const SEARCH_TOOL_LIMITS = {
  search_menu: 5,
  search_restaurants: 2,
  get_restaurant_menu: 2,
};

export function shouldFinalizeCartAgent({ modelCallCount = 0, modelCallLimit = AGENT_MAX_MODEL_CALLS, cartUpdated = false, couponsChecked = false, verificationPending = false } = {}) {
  return modelCallCount >= modelCallLimit
    || (cartUpdated && couponsChecked && !verificationPending);
}

export async function runFoodCartAgent(mcp, { food, addressId, addressSummary, streamId, threadId, deviceId, instruction, currentSuggestion, personalContext = "", temporalContext }) {
  const runId = crypto.randomUUID().slice(0, 8);
  const resolvedModel = await resolveAgentModel(deviceId, {
    runId,
    onApprovalRequired: (fallback) => agentLog(runId, streamId, "model:fallback-required", fallback),
    onFallbackActivated: (fallback) => agentLog(runId, streamId, "model:fallback-approved", fallback),
  });
  let selectedRestaurantName = currentSuggestion?.restaurant;
  let selectedRestaurantId = currentSuggestion?.restaurantId;
  let appliedCouponCode = currentSuggestion?.coupon;
  let cartMutationItems = currentSuggestion?.cartMutationItems;
  const loopState = {
    modelCallCount: 0,
    modelCallLimit: resolvedModel.local ? LOCAL_AGENT_MAX_MODEL_CALLS : AGENT_MAX_MODEL_CALLS,
    cartMutationAttempted: false,
    cartUpdated: false,
    couponsChecked: false,
    verificationPending: false,
    mutationCandidateAvailable: false,
    menuSearchExhausted: false,
  };
  const searchBudget = createSearchBudgetGuard();
  const menuSearchPlan = instruction ? [] : directMenuSearchPlan(food);
  let nextMenuSearchPlanIndex = 1;
  const startedAt = performance.now();
  agentLog(runId, streamId, "started", { dish: food.dish, context: food.context, provider: resolvedModel.provider, model: resolvedModel.model, local: resolvedModel.local, thinkingEnabled: resolvedModel.thinkingEnabled === true, observedAtUtc: temporalContext?.iso, observedAtLocal: temporalContext?.localDateTime, timeZone: temporalContext?.timeZone, ...(resolvedModel.contextTokens ? { contextTokens: resolvedModel.contextTokens } : {}) });
  const directMenuSearch = instruction ? undefined : await discoverDirectMenuSearch({ mcp, food, addressId, query: menuSearchPlan[0], runId, streamId });
  if (menuSearchPlan[0]) searchBudget.remember("search_menu", { addressId, query: menuSearchPlan[0] });
  if (resolvedModel.local && hasQuickAddMenuCandidate(directMenuSearch)) {
    loopState.mutationCandidateAvailable = true;
    agentLog(runId, streamId, "local_cart_mutation_phase", { sourceTool: "direct_menu_search" });
  }
  const definitions = (await mcp.listTools()).filter((definition) => SAFE_TOOLS.has(definition.name));
  agentLog(runId, streamId, "tools_ready", { count: definitions.length, tools: definitions.map((definition) => definition.name) });
  const tools = definitions.map((definition) => tool(
    async (input) => {
      const args = { ...(input || {}) };
      if (ADDRESS_TOOLS.has(definition.name)) args.addressId = addressId;
      if (resolvedModel.local && definition.name === "search_menu") {
        // Search results from the restaurant search endpoint are not a trusted
        // menu scope. Use direct dish/synonym discovery until Swiggy returns a
        // menu item that can safely be placed in a cart.
        delete args.restaurantIdOfAddedItem;
        delete args.restaurant_id_of_added_item;
      }
      let searchDecision = searchBudget.check(definition.name, args);
      if (!searchDecision.allowed && definition.name === "search_menu" && searchDecision.reason === "DUPLICATE_SEARCH") {
        const replacementQuery = menuSearchPlan[nextMenuSearchPlanIndex];
        if (replacementQuery) {
          nextMenuSearchPlanIndex += 1;
          const requestedQuery = args.query;
          args.query = replacementQuery;
          searchDecision = searchBudget.check(definition.name, args);
          agentLog(runId, streamId, "search_query_rewritten", { requestedQuery, query: replacementQuery, remaining: searchDecision.remaining });
        } else {
          loopState.menuSearchExhausted = true;
        }
      }
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
        const completion = recordCartToolCompletion(loopState, {
          toolName: definition.name,
          result,
          expectedItems: cartMutationItems,
        });
        if (completion.cartVerified !== undefined) {
          agentLog(runId, streamId, "cart_verification", {
            verified: completion.cartVerified,
            expectedItemCount: Array.isArray(cartMutationItems) ? cartMutationItems.length : 0,
          });
        }
        if (["update_food_cart", "get_food_cart"].includes(definition.name)) {
          selectedRestaurantName = findToolRestaurantName(result) || selectedRestaurantName;
        }
        if (resolvedModel.local && !loopState.cartMutationAttempted
          && ["search_menu", "get_restaurant_menu"].includes(definition.name)
          && hasQuickAddMenuCandidate(result)) {
          loopState.mutationCandidateAvailable = true;
          agentLog(runId, streamId, "local_cart_mutation_phase", { sourceTool: definition.name });
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
    model: resolvedModel.chatModel,
    tools,
    checkpointer: conversationMemory,
    middleware: [createMiddleware({
      name: "CraveLensCartLoopGuard",
      wrapModelCall: async (request, handler) => {
        loopState.modelCallCount += 1;
        const isActiveLocalModel = () => resolvedModel.local
          && (typeof resolvedModel.chatModel?.isUsingLocal !== "function" || resolvedModel.chatModel.isUsingLocal());
        let modelRequest = withActiveToolChoice(localCartPhaseRequest(request, loopState, isActiveLocalModel()));
        if (loopState.menuSearchExhausted) {
          agentLog(runId, streamId, "finalizing", { reason: "menu_search_exhausted", modelCallCount: loopState.modelCallCount });
          return new AIMessage(finalCartAgentResponseContent(loopState, "menu_search_exhausted"));
        }
        if (shouldFinalizeCartAgent(loopState)) {
          const reason = loopState.modelCallCount >= loopState.modelCallLimit ? "model_call_limit" : "cart_verified";
          agentLog(runId, streamId, "finalizing", { reason, modelCallCount: loopState.modelCallCount });
          // The cart state is already authoritative here. Some OpenAI-compatible
          // backends still emit tool calls when tool_choice is none, so avoid a
          // redundant provider call and finish from the verified loop state.
          return new AIMessage(finalCartAgentResponseContent(loopState, reason));
        }
        const onRetry = ({ attempt, reason, delayMs, finishReason, outputTokens }) => {
          agentLog(runId, streamId, "model_retry", {
            attempt,
            reason,
            ...(delayMs ? { delayMs } : {}),
            ...(finishReason ? { finishReason } : {}),
            ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
          });
        };
        let missingToolRetries = 0;
        for (;;) {
          const response = await invokeModelWithToolChoiceRetry(modelRequest, handler, {
            onRetry,
            onRecoveredToolCall: (call) => agentLog(runId, streamId, "model_tool_call_recovered", { tool: call.name }),
            shouldRequireToolChoice: isActiveLocalModel,
          });
          if (!shouldRetryMissingToolCall({ response, tools: modelRequest.tools, retryCount: missingToolRetries })) return response;
          missingToolRetries += 1;
          await onRetry({
            attempt: missingToolRetries,
            reason: "missing_required_tool_call",
            delayMs: 0,
            finishReason: response?.response_metadata?.finishReason,
            outputTokens: response?.usage_metadata?.output_tokens,
          });
          const retryRequiresTool = isActiveLocalModel();
          modelRequest = withRequiredToolReminder(withActiveToolChoice(modelRequest, {
            required: retryRequiresTool,
            forceAuto: !retryRequiresTool,
          }));
        }
      },
    })],
    systemPrompt: `You are CraveLens' Swiggy Food ReAct cart agent. You may prepare and optimize a real cart, but you must NEVER place an order.

Complete the task through tool calls; do not merely describe what should be done.
When the user sends a follow-up request, continue the existing cart conversation, inspect the current cart, and modify or replace it to satisfy the new instruction.
For follow-up requests that add or include another item from the same restaurant, preserve all existing configured cart line items and submit the complete desired cartItems array: existing items plus the new item. Only replace, remove, or alter existing items when the user explicitly asks to replace, swap, remove, make-only, or otherwise change them.
The user may provide a PERSONAL CONTEXT block and a trusted CURRENT DATETIME block. Apply time-dependent preferences using the supplied local day and datetime. Treat explicit current personal context as higher priority than inferred order-history patterns, while continuing to treat allergies and safety constraints as hard constraints.
1. The server has already selected delivery address ${addressId} (${addressSummary}); every location-sensitive tool is pinned to it. Do not call or infer another address.
2. Inspect get_food_orders and relevant get_food_order_details. Infer favorite dishes/restaurants at this location, vegetarian patterns, repeated special instructions, allergens, and items or ingredients to avoid. Treat allergy/avoidance evidence as a hard safety constraint; do not invent one.
3. An authoritative direct search_menu result is supplied with the task. Use its orderable items first. If it is empty, search distinct direct queries derived from the detected cuisine, ingredients, and description; do not pass restaurantIdOfAddedItem to search_menu. search_restaurants is only for finding alternatives, not a source of menu scopes.
3a. Search calls are deliberately bounded: one direct search is already completed as free context, leaving at most 5 additional search_menu calls, 2 search_restaurants calls, and 2 get_restaurant_menu calls. Never repeat the same normalized direct query. Before the budget is exhausted, choose the best orderable item already found and proceed to update_food_cart. If no orderable match exists, stop searching and return a HUMAN_INPUT_UI choice using the closest alternatives already found.
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
Selected delivery address: ${addressSummary} (${addressId}).
AUTHORITATIVE DIRECT MENU SEARCH (already completed; do not repeat this exact query):
${compactAgentResult(directMenuSearch)}`;
    const langfuseHandler = createLangfuseHandler({
      sessionId: threadId,
      traceMetadata: {
        provider: resolvedModel.provider,
        model: resolvedModel.model,
        local: resolvedModel.local,
        streamId,
        runId,
        observedAtUtc: temporalContext?.iso,
        observedAtLocal: temporalContext?.localDateTime,
        timeZone: temporalContext?.timeZone,
      },
    });
    const result = await agent.invoke({
      messages: [{ role: "user", content: userMessage }],
    }, {
      recursionLimit: 64,
      configurable: { thread_id: threadId },
      ...(langfuseHandler ? { callbacks: [langfuseHandler] } : {}),
    });
    const postAgentVerification = await verifyPendingCartMutation({
      mcp,
      state: loopState,
      addressId,
      expectedItems: cartMutationItems,
      runId,
      streamId,
    });
    if (postAgentVerification.cart) {
      selectedRestaurantName = findToolRestaurantName(postAgentVerification.cart) || selectedRestaurantName;
    }
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
    if (resolvedModel.local && resolvedModel.fallbackAvailable && /^INFERENCE_/.test(error?.code || "") && !error?.fallbackRequested) {
      const fallback = await requestFallbackApproval(deviceId, runId, { provider: resolvedModel.provider, model: resolvedModel.model, reason: error.code });
      agentLog(runId, streamId, "model:fallback-required", fallback);
      error.fallback = fallback;
    }
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
  onRecoveredToolCall,
  shouldRequireToolChoice,
  sleep = wait,
} = {}) {
  let currentRequest = request;
  let toolChoiceRetries = 0;
  let transientRetries = 0;
  for (;;) {
    try {
      return await handler(currentRequest);
    } catch (error) {
      const toolProtocolFailure = isToolChoiceMismatchError(error) || isOutputParseFailedError(error);
      if (toolProtocolFailure) {
        const recovered = recoverFailedGenerationToolCall(error, currentRequest.tools);
        if (recovered) {
          await onRecoveredToolCall?.(recovered);
          return new AIMessage({ content: "", tool_calls: [recovered] });
        }
      }
      if (toolProtocolFailure && toolChoiceRetries < maxRetries) {
        toolChoiceRetries += 1;
        await onRetry?.({ attempt: toolChoiceRetries, reason: isOutputParseFailedError(error) ? "output_parse_failed" : "tool_choice_mismatch", delayMs: 0 });
        if (shouldRequireToolChoice?.() === false) currentRequest = withActiveToolChoice(currentRequest, { forceAuto: true });
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

export function recoverFailedGenerationToolCall(error, tools = []) {
  const generation = failedGeneration(error);
  if (!generation) return undefined;
  if (typeof generation === "string") return isOutputParseFailedError(error) ? recoverProseToolCall(generation, tools) : undefined;
  const call = Array.isArray(generation.tool_calls) ? generation.tool_calls[0]?.function || generation.tool_calls[0] : generation.function || generation;
  const tool = resolveAvailableTool(call?.name, tools);
  // A provider's rejected generation is not an authenticated instruction to
  // mutate a cart. Only recover idempotent/read-only calls; the model gets a
  // normal bounded retry for update_food_cart, coupon, and flush operations.
  if (!tool || !PROSE_RECOVERABLE_READ_TOOLS.has(toolName(tool))) return undefined;
  let args = call?.arguments ?? call?.args ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return undefined; }
  }
  if (!args || typeof args !== "object" || Array.isArray(args) || !toolAcceptsArguments(tool, args)) return undefined;
  return recoveredToolCall(toolName(tool), args);
}

function failedGeneration(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 6 && !seen.has(current); depth += 1) {
    if (typeof current !== "object") break;
    seen.add(current);
    for (const value of [current.failed_generation, current.failedGeneration, current.error?.failed_generation, current.error?.failedGeneration]) {
      const parsed = parseFailedGeneration(value);
      if (parsed) return parsed;
    }
    const match = String(current.message || "").match(/"failed_generation"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (match) {
      try {
        const parsed = parseFailedGeneration(JSON.parse(`"${match[1]}"`));
        if (parsed) return parsed;
      } catch { /* Ignore malformed provider diagnostics. */ }
    }
    current = current.cause;
  }
  return undefined;
}

function parseFailedGeneration(value) {
  if (!value) return undefined;
  if (typeof value === "object") return value;
  const text = String(value).trim();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

function recoverProseToolCall(generation, tools) {
  const matches = (Array.isArray(tools) ? tools : []).filter((tool) => {
    const name = toolName(tool);
    if (!name || !PROSE_RECOVERABLE_READ_TOOLS.has(name) || !toolAllowsEmptyArguments(tool)) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\b(?:call|use|invoke)\\s+(?:the\\s+)?(?:tool\\s+)?(?:tool\\.)?${escaped}(?![A-Za-z0-9_])`, "i").exec(generation);
    if (!match) return false;
    const prefix = generation.slice(Math.max(0, match.index - 16), match.index);
    return !/(?:do\s+not|don't|never|avoid)\s*$/i.test(prefix);
  });
  return matches.length === 1 ? recoveredToolCall(toolName(matches[0]), {}) : undefined;
}

function resolveAvailableTool(value, tools) {
  const supplied = String(value || "").trim();
  if (!supplied) return undefined;
  const candidates = [supplied];
  for (const prefix of ["tool.", "function.", "functions."]) {
    if (supplied.startsWith(prefix)) candidates.push(supplied.slice(prefix.length));
  }
  return (Array.isArray(tools) ? tools : []).find((tool) => candidates.includes(toolName(tool)));
}

function toolAllowsEmptyArguments(tool) {
  const schema = tool?.schema || tool?.function?.parameters || tool?.parameters;
  if (!schema) return false;
  if (typeof schema.safeParse === "function") return schema.safeParse({}).success;
  return schema.type === "object" && (!Array.isArray(schema.required) || schema.required.length === 0);
}

function toolAcceptsArguments(tool, args) {
  const schema = tool?.schema || tool?.function?.parameters || tool?.parameters;
  if (!schema) return true;
  if (typeof schema.safeParse === "function") return schema.safeParse(args).success;
  if (!Array.isArray(schema.required)) return true;
  return schema.required.every((key) => Object.hasOwn(args, key));
}

function recoveredToolCall(name, args) {
  return { id: `recovered_${crypto.randomUUID()}`, name, args };
}

function toolName(tool) {
  return String(tool?.name || tool?.function?.name || "").trim();
}

export function localCartPhaseRequest(request, state = {}, local = false) {
  if (!local || !Array.isArray(request?.tools)) return request;
  // LiteRT-JS and some Ollama models do not reliably honor LangChain's
  // provider-level tool-choice protocol. Keep the same Swiggy tool surface as
  // hosted models, but ask the local connector to prefer an actual tool call.
  return { ...request, toolChoice: "required" };
}

export function withRequiredToolReminder(request) {
  const reminder = new HumanMessage("Your previous response did not invoke a tool. Do not explain or plan in prose. Invoke exactly one available tool now.");
  return {
    ...request,
    messages: [...(Array.isArray(request?.messages) ? request.messages : []), reminder],
  };
}

export function hasQuickAddMenuCandidate(result) {
  try {
    return normalizeMenuCatalog(result).some((item) => item.canQuickAdd && item.id && item.name);
  } catch {
    return false;
  }
}

export function directMenuSearchPlan(food = {}) {
  const dish = String(food?.dish || "").trim();
  const cuisine = String(food?.cuisine || "").trim();
  const ingredients = (Array.isArray(food?.ingredients) ? food.ingredients : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, 3);
  const description = String(food?.description || "").trim().replace(/\s+/g, " ");
  // Every fallback query is grounded in the VLM's own detection data. This
  // avoids a brittle cuisine/dish alias catalogue while still guaranteeing a
  // bounded set of distinct queries when a small local model repeats itself.
  return [...new Set([
    dish,
    cuisine && `${cuisine} ${dish}`,
    ingredients.length && ingredients.join(" "),
    dish && ingredients.length && `${dish} ${ingredients.join(" ")}`,
    description,
  ].map((value) => String(value || "").trim()).filter(Boolean).map((value) => value.slice(0, 180)))].slice(0, 5);
}

export async function discoverDirectMenuSearch({ mcp, food, addressId, query: suppliedQuery, searchBudget, runId, streamId } = {}) {
  const query = String(suppliedQuery || food?.dish || "").trim();
  if (!mcp || !addressId || !query) return undefined;
  const decision = searchBudget?.check("search_menu", { addressId, query }) || { allowed: true };
  if (!decision.allowed) return undefined;
  const startedAt = performance.now();
  agentLog(runId || "preflight", streamId, "direct_menu_search", { query, remaining: decision.remaining });
  try {
    const result = await mcp.call("search_menu", { addressId, query });
    agentLog(runId || "preflight", streamId, "direct_menu_search_complete", {
      query,
      durationMs: elapsed(startedAt),
      quickAddCandidate: hasQuickAddMenuCandidate(result),
    });
    return result;
  } catch (error) {
    agentLog(runId || "preflight", streamId, "direct_menu_search_failed", {
      query,
      durationMs: elapsed(startedAt),
      error: error instanceof Error ? error.message : String(error),
    });
    return { items: [], error: "Direct menu discovery was unavailable; try a direct dish synonym." };
  }
}

function compactAgentResult(value, limit = 4_500) {
  if (value === undefined) return "No direct result was available.";
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= limit) return serialized;
    const items = normalizeMenuCatalog(value).slice(0, 8);
    return JSON.stringify({ items, _cravelensTruncated: true });
  } catch {
    return "No usable direct result was available.";
  }
}

export function appendSystemInstruction(request, instruction) {
  const suffix = `\n\n${String(instruction || "").trim()}`;
  if (request?.systemMessage && typeof request.systemMessage.concat === "function") {
    const { systemPrompt: _systemPrompt, ...withoutSystemPrompt } = request;
    return {
      ...withoutSystemPrompt,
      systemMessage: request.systemMessage.concat(suffix),
    };
  }
  const { systemMessage: _systemMessage, ...withoutSystemMessage } = request || {};
  return {
    ...withoutSystemMessage,
    systemPrompt: `${withoutSystemMessage.systemPrompt || ""}${suffix}`,
  };
}

export function replaceSystemInstruction(request, instruction) {
  const content = String(instruction || "").trim();
  if (request?.systemMessage) {
    const { systemPrompt: _systemPrompt, ...withoutSystemPrompt } = request;
    return {
      ...withoutSystemPrompt,
      systemMessage: new SystemMessage(content),
    };
  }
  const { systemMessage: _systemMessage, ...withoutSystemMessage } = request || {};
  return {
    ...withoutSystemMessage,
    systemPrompt: content,
  };
}

export function createSearchBudgetGuard(limits = SEARCH_TOOL_LIMITS) {
  const counts = new Map();
  const seenQueries = new Set();
  const queryKeyFor = (toolName, args = {}) => {
    const query = String(args.query || "").trim().toLowerCase().replace(/\s+/g, " ");
    const restaurantScope = String(args.restaurantIdOfAddedItem || args.restaurantId || "").trim();
    return query ? `${toolName}:${restaurantScope}:${query}` : "";
  };
  return {
    remember(toolName, args = {}) {
      const queryKey = queryKeyFor(toolName, args);
      if (queryKey) seenQueries.add(queryKey);
    },
    check(toolName, args = {}) {
      const limit = limits[toolName];
      if (!limit) return { allowed: true, remaining: undefined };
      const count = counts.get(toolName) || 0;
      const queryKey = queryKeyFor(toolName, args);
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

export function isOutputParseFailedError(error) {
  const message = modelErrorText(error);
  return /output_parse_failed/i.test(message)
    || /parsing failed[\s\S]*failed_generation/i.test(message);
}

export function isTransientModelError(error) {
  const message = modelErrorText(error);
  return /\b(?:429|500|502|503|504)\b/.test(message)
    || /service unavailable|temporar(?:y|ily) (?:unavailable|unreachable)|no_db_connection|rate.?limit|timed? ?out|econnreset|econnrefused|socket hang up/i.test(message);
}

export function shouldRetryMissingToolCall({ response, tools, runComplete = false, retryCount = 0, maxRetries = MISSING_TOOL_CALL_MAX_RETRIES } = {}) {
  if (runComplete || retryCount >= maxRetries || !Array.isArray(tools) || tools.length === 0) return false;
  return !(Array.isArray(response?.tool_calls) && response.tool_calls.length > 0)
    && !(Array.isArray(response?.additional_kwargs?.tool_calls) && response.additional_kwargs.tool_calls.length > 0);
}

export function recordCartToolCompletion(state, { toolName, result, expectedItems } = {}) {
  if (toolName === "update_food_cart") {
    state.cartMutationAttempted = true;
    state.cartUpdated = false;
    state.couponsChecked = false;
    state.verificationPending = true;
  }
  if (toolName === "fetch_food_coupons") state.couponsChecked = true;
  if (toolName === "apply_food_coupon") state.verificationPending = true;
  if (toolName !== "get_food_cart" || !state.cartMutationAttempted) return {};
  const cartVerified = cartReflectsItems(result, expectedItems);
  state.cartUpdated = cartVerified;
  state.verificationPending = !cartVerified;
  return { cartVerified };
}

export async function verifyPendingCartMutation({
  mcp,
  state,
  addressId,
  expectedItems,
  runId,
  streamId,
  delaysMs = [250, 750, 1_250],
} = {}) {
  if (!mcp || !state?.cartMutationAttempted || state.cartUpdated || !state.verificationPending || !addressId) return {};
  let lastCart;
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    if (attempt > 0) await wait(delaysMs[attempt - 1]);
    const startedAt = performance.now();
    agentLog(runId || "post-agent", streamId, "deterministic_verification", { tool: "get_food_cart", attempt: attempt + 1 });
    try {
      const cart = await mcp.call("get_food_cart", { addressId });
      lastCart = cart;
      const completion = recordCartToolCompletion(state, {
        toolName: "get_food_cart",
        result: cart,
        expectedItems,
      });
      agentLog(runId || "post-agent", streamId, "cart_verification", {
        verified: completion.cartVerified,
        deterministic: true,
        attempt: attempt + 1,
        expectedItemCount: Array.isArray(expectedItems) ? expectedItems.length : 0,
        durationMs: elapsed(startedAt),
      });
      if (completion.cartVerified) return { cart, cartVerified: true };
    } catch (error) {
      agentLog(runId || "post-agent", streamId, "tool_failed", {
        tool: "get_food_cart",
        deterministic: true,
        attempt: attempt + 1,
        durationMs: elapsed(startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { cart: lastCart, cartVerified: false };
}

export function withActiveToolChoice(request, { required = false, forceAuto = false } = {}) {
  if (!Array.isArray(request?.tools) || request.tools.length === 0) return request;
  const current = request.toolChoice;
  if (forceAuto) return { ...request, toolChoice: "auto" };
  return { ...request, toolChoice: required ? "required" : current && current !== "none" ? current : "auto" };
}

export function finalCartAgentResponseContent({ cartUpdated = false, verificationPending = false } = {}, reason = "cart_verified") {
  const rationale = cartUpdated && !verificationPending
    ? "The Swiggy cart was updated and verified. Final restaurant, item, discount, and payable details are taken from the verified cart response."
    : cartUpdated
      ? "The Swiggy cart was updated; final cart details will be verified from Swiggy before they are shown."
      : reason === "model_call_limit"
        ? "The cart agent reached its reasoning limit before an orderable item was added."
        : "No verified cart change was completed.";
  return `CART_RATIONALE:\n${rationale}\nHUMAN_INPUT_UI:\nNONE`;
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

function agentLog(runId, streamId, event, details = {}) {
  console.log(`[agent:${runId}] ${event}`, Object.keys(details).length ? details : "");
  publishAgentEvent(streamId, event, { runId, ...details });
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
