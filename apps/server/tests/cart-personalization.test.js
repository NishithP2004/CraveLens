import { beforeEach, expect, it, vi } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
const boundary = vi.hoisted(() => ({ model: null, local: false, preferences: vi.fn(), order: [] }));
vi.mock("../src/model-provider.js", () => ({ resolveAgentModel: async () => ({ provider: boundary.local ? "ollama" : "google", local: boundary.local, chatModel: boundary.model }) }));
vi.mock("../src/preference-bootstrap.js", () => ({ ensureCartPreferences: (...args) => { boundary.order.push("preferences"); return boundary.preferences(...args); } }));
import { runFoodCartAgent, directMenuSearchPlan } from "../src/swiggy-agent.js";
import { orchestrationFlightKey } from "../src/app.js";
class CaptureModel extends BaseChatModel {
  constructor() { super({}); this.messages = []; }
  _llmType() { return "cart-personalization-test"; }
  bindTools() { return this; }
  async _generate(messages) { this.messages = messages; return { generations: [{ text: "", message: new AIMessage("CART_RATIONALE:\nA choice is needed.\nHUMAN_INPUT_UI:\nNONE") }] }; }
}
beforeEach(() => { boundary.model = new CaptureModel(); boundary.local = false; boundary.preferences.mockReset(); boundary.order = []; });
const food = { dish: "Rice", description: "Rice and dal", cuisine: "Indian", ingredients: ["rice"], confidence: .9, context: "ready_to_eat", dishes: [
  { dish: "Rice", cuisine: "Indian", ingredients: ["rice"], confidence: .9 },
  { dish: "Dal", cuisine: "Indian", ingredients: ["lentils"], confidence: .8 },
] };
it("supplies saved inferred preferences and every dish before cart-model selection", async () => {
  boundary.preferences.mockResolvedValue({ personalContext: "Rice is a tentative preference.", personalContextSource: "inferred_history", preferenceHistoryRetrieved: true, preferenceProfile: { addressId: "home", source: "inferred_history", history: { matched: 7 }, notes: "Limited history", generatedAt: 123 } });
  const result = await runFoodCartAgent({ listTools: async () => [], call: async (tool) => { boundary.order.push(tool); return { items: [] }; } }, { food, addressId: "home", addressSummary: "Home", threadId: crypto.randomUUID(), deviceId: "owner" });
  expect(boundary.order.slice(0, 2)).toEqual(["preferences", "search_menu"]);
  const text = JSON.stringify(boundary.model.messages.map((message) => message.content));
  expect(text).toContain("Rice is a tentative preference.");
  expect(text).toContain("Dal");
  expect(text).toContain("inferred_history");
  expect(text).toContain("not user-stated constraints");
  expect(result).toMatchObject({ personalContextSource: "inferred_history", historyReviewed: true });
});
it("keeps side dishes in grounded discovery queries and separates multi-dish requests", () => {
  expect(directMenuSearchPlan(food)).toContain("Dal");
  const input = { videoId: "page-test", addressId: "home", verification: food };
  const key = orchestrationFlightKey(input, "owner");
  expect(key).not.toBe(orchestrationFlightKey({ ...input, verification: { ...food, dishes: [food.dishes[0]] } }, "owner"));
  expect(key).not.toBe(orchestrationFlightKey({ ...input, personalContext: "Avoid dairy" }, "owner"));
});

it("accepts omitted dish cuisines at the API contract boundary", async () => {
  const { OrchestrateRequestSchema } = await import("@cravelens/shared");
  const request = { videoId: "source-123", timestamp: 0, triggerConfidence: .9, addressId: "home", verification: { ...food, isFood: true, dishes: food.dishes.map(({ cuisine, ...dish }) => dish) } };
  const parsed = OrchestrateRequestSchema.parse(request);
  expect(parsed.verification.dishes.map((dish) => dish.cuisine)).toEqual(["unknown", "unknown"]);
});

it.each([false, true])("dispatches searches beyond the former quotas, including repeated queries (local=%s)", async (local) => {
  boundary.local = local;
  const names = [...Array(6).fill("search_menu"), ...Array(3).fill("search_restaurants"), ...Array(3).fill("get_restaurant_menu")];
  class SearchModel extends CaptureModel {
    constructor() { super(); this.index = 0; }
    async _generate() {
      if (this.index >= 41) throw new Error("Test inference completed");
      const name = names[this.index++] || "search_menu";
      const message = name ? new AIMessage({ content: "", tool_calls: [{ name, args: { query: "Rice" }, id: `search-${this.index}`, type: "tool_call" }] }) : new AIMessage("CART_RATIONALE:\nNo cart was prepared.\nHUMAN_INPUT_UI:\nNONE");
      return { generations: [{ text: "", message }] };
    }
  }
  boundary.model = new SearchModel();
  boundary.preferences.mockResolvedValue({ personalContext: "", personalContextSource: "none", preferenceHistoryRetrieved: false });
  const calls = [];
  const mcp = {
    listTools: async () => [...new Set(names)].map((name) => ({ name, description: `Read ${name}`, inputSchema: { type: "object", properties: { query: { type: "string" }, addressId: { type: "string" } }, required: ["query", "addressId"] } })),
    call: async (name, args) => { calls.push({ name, args }); return { items: [] }; },
  };
  await expect(runFoodCartAgent(mcp, { food, addressId: "home", addressSummary: "Home", threadId: crypto.randomUUID(), deviceId: "owner" })).rejects.toThrow("Test inference completed");
  expect(boundary.model.index).toBe(41);
  expect(calls).toHaveLength(42);
  expect(calls.filter((call) => call.name === "search_menu").length).toBeGreaterThanOrEqual(7); // preflight plus at least six agent calls
  expect(calls.filter((call) => call.name === "search_restaurants")).toHaveLength(3);
  expect(calls.filter((call) => call.name === "get_restaurant_menu")).toHaveLength(3);
  expect(calls.every((call) => call.args.query === "Rice" && call.args.addressId === "home")).toBe(true);
});
