import { webcrypto } from "node:crypto";
import { createAgent, tool } from "langchain";
import { ChatGoogle } from "@langchain/google";
import { ChatOpenAI } from "@langchain/openai";
import { config } from "./config.js";
import { publishAgentEvent } from "./agent-events.js";

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

export async function runFoodCartAgent(mcp, { food, addressId, addressSummary, streamId }) {
  if (!["gemini", "openai"].includes(config.agentModelProvider)) throw new Error(`Unsupported agent provider: ${config.agentModelProvider}`);
  if (!config.agentModelApiKey) throw new Error("AGENT_MODEL_API_KEY is required for Swiggy cart orchestration.");

  const runId = crypto.randomUUID().slice(0, 8);
  let selectedRestaurantName;
  const startedAt = performance.now();
  agentLog(runId, streamId, "started", { dish: food.dish, context: food.context, model: config.agentModelName });
  const definitions = (await mcp.listTools()).filter((definition) => SAFE_TOOLS.has(definition.name));
  agentLog(runId, streamId, "tools_ready", { count: definitions.length, tools: definitions.map((definition) => definition.name) });
  const tools = definitions.map((definition) => tool(
    async (input) => {
      const args = { ...(input || {}) };
      if (ADDRESS_TOOLS.has(definition.name)) args.addressId = addressId;
      if (definition.name === "update_food_cart" && typeof args.restaurantName === "string" && args.restaurantName.trim()) selectedRestaurantName = args.restaurantName.trim();
      const toolStartedAt = performance.now();
      agentLog(runId, streamId, "tool_call", { tool: definition.name, args: safeToolArgs(args) });
      try {
        const result = await mcp.call(definition.name, args);
        agentLog(runId, streamId, "tool_complete", { tool: definition.name, durationMs: elapsed(toolStartedAt) });
        return JSON.stringify(result);
      } catch (error) {
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
    systemPrompt: `You are CraveLens' Swiggy Food ReAct cart agent. You may prepare and optimize a real cart, but you must NEVER place an order.

Complete the task through tool calls; do not merely describe what should be done.
1. Call get_addresses first and use only addressId ${addressId} (${addressSummary}). Every location-sensitive tool must use that address.
2. Inspect get_food_orders and relevant get_food_order_details. Infer favorite dishes/restaurants at this location, vegetarian patterns, repeated special instructions, allergens, and items or ingredients to avoid. Treat allergy/avoidance evidence as a hard safety constraint; do not invent one.
3. Search for the detected dish. Prefer search_menu because it returns orderable item IDs and full variants/add-ons. If a literal query fails, reason about close menu synonyms and retry. Ramen may appear as Japanese noodles, noodle bowl, tonkotsu, shoyu, miso ramen, or instant ramen; never stop after one empty literal match.
4. Choose an OPEN, serviceable restaurant using history preference first, then rating/distance. Select an orderable item configuration consistent with the profile. Preserve the exact variants/variantsV2 and addon shapes returned by Swiggy. Never select an ingredient that conflicts with an allergy or avoidance.
5. Call update_food_cart with the exact current schema, including addressId, restaurantId, restaurantName, and cartItems.
6. Call get_food_cart to verify the actual cart. If invalid, inspect the error/result and revise the item or configuration.
7. Call fetch_food_coupons for the chosen restaurant/address. Compare applicable COD-compatible offers by actual discount, apply the maximum valid one with apply_food_coupon, then call get_food_cart again to verify non-zero applied savings.
8. Stop only when the cart contains the intended configured item and has been verified. Return a brief rationale mentioning history/preferences, safety choices, restaurant choice, and discount. The application—not you—asks the user for final confirmation.`,
  });

  agentLog(runId, streamId, "reasoning_started");
  try {
    const result = await agent.invoke({
      messages: [{ role: "user", content: `Prepare a personalized Swiggy Food cart for this locally identified video dish:\n${JSON.stringify(food)}\nSelected delivery address: ${addressSummary} (${addressId}).` }],
    }, { recursionLimit: 40 });
    const final = [...result.messages].reverse().find((message) => message.getType?.() === "ai" || message.type === "ai");
    agentLog(runId, streamId, "completed", { durationMs: elapsed(startedAt), messageCount: result.messages.length });
    return { rationale: textContent(final?.content) || "Prepared and verified by the CraveLens Swiggy ReAct agent.", restaurantName: selectedRestaurantName };
  } catch (error) {
    agentLog(runId, streamId, "failed", { durationMs: elapsed(startedAt), error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function createAgentModel() {
  if (config.agentModelProvider === "openai") {
    return new ChatOpenAI({
      model: config.agentModelName,
      apiKey: config.agentModelApiKey,
      temperature: 1,
      maxTokens: 2048,
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
