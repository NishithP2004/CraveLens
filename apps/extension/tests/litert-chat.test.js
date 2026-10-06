import assert from "node:assert/strict";
import test from "node:test";
import { InferenceResultSchema } from "@cravelens/shared";
import { createInferenceDeadline, liteRtToolPolicy, liteRtUsage, runLiteRtConversation, toLiteRtMessages, trimOldestExchange } from "../src/litert-chat.js";

test("tool responses use function names resolved from call IDs", () => {
  const messages = toLiteRtMessages([{ role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "search_menu", args: { query: "pasta" } }] }, { role: "tool", toolCallId: "call-1", content: '{"items":[]}' }]);
  assert.equal(messages[1].content[0].name, "search_menu");
  assert.deepEqual(messages[1].content[0].response, { items: [] });
});

test("context trimming preserves task, menu IDs/customizations, and latest cart exchange", () => {
  const messages = toLiteRtMessages([
    { role: "system", content: "instructions" }, { role: "user", content: "task" },
    { role: "assistant", content: "", toolCalls: [{ id: "old", name: "search_restaurants", args: {} }] },
    { role: "tool", name: "search_restaurants", content: '{}' },
    { role: "assistant", content: "", toolCalls: [{ id: "menu", name: "search_menu", args: {} }] },
    { role: "tool", name: "search_menu", content: '{"items":[{"menu_item_id":"205459659","restaurant_id":"10096","variantsV2":[{"groupId":"g","variations":[{"id":"v"}]}]}]}' },
    { role: "assistant", content: "", toolCalls: [{ id: "cart", name: "update_food_cart", args: {} }] },
    { role: "tool", name: "update_food_cart", content: '{"success":false}' },
  ]);
  const trimmed = trimOldestExchange(messages);
  assert.equal(trimmed.length, 6);
  assert.equal(trimmed[1].content, "task");
  assert.match(JSON.stringify(trimmed), /205459659/);
  assert.match(JSON.stringify(trimmed), /variantsV2/);
  assert.equal(trimOldestExchange(trimmed), undefined);
});

test("streaming returns the completed message and decode-only output usage", async () => {
  let config;
  let deleted = false;
  const full = { role: "model", content: [{ type: "text", text: "hello world" }], tool_calls: [{ id: "call", function: { name: "search_menu", arguments: { query: "pasta" } } }] };
  // An SDK boundary test double; no simulated data enters the product runtime.
  const conversation = {
    getTokenCount: async () => 1200,
    getBenchmarkInfo: async () => ({ lastDecodeTokenCount: 100, lastDecodeTokensPerSecond: 20, timeToFirstTokenInSecond: 0.5 }),
    sendMessageStreaming: () => new ReadableStream({ start(controller) {
      controller.enqueue({ content: [{ type: "text", text: "hello " }] });
      controller.enqueue({ content: [{ type: "text", text: "world" }] });
      controller.close();
    } }),
    getHistory: async () => [full], delete: async () => { deleted = true; },
  };
  const chunks = [];
  const result = await runLiteRtConversation({ createConversation: async (value) => { config = value; return conversation; } }, { messages: [{ role: "user", content: "Find pasta" }], tools: [{ name: "search_menu" }], options: { thinkingEnabled: false }, stream: true }, { contextTokens: 4096, onChunk: (chunk) => chunks.push(chunk) });
  assert.equal(config.preface.extra_context.enable_thinking, false);
  assert.equal(result.content, "hello world");
  assert.equal(chunks.join(""), "hello world");
  assert.deepEqual(result.toolCalls[0].args, { query: "pasta" });
  assert.deepEqual(result.usage, { inputTokens: 1100, outputTokens: 100, totalTokens: 1200 });
  assert.equal(InferenceResultSchema.safeParse({ version: 1, requestId: "182f6674-694f-4f20-9237-1fc6136441d0", ...result }).success, true);
  assert.equal(deleted, true);
});

test("tool policy implements required, named, and none choices", () => {
  const tools = [{ name: "search_menu" }, { type: "function", function: { name: "get_food_cart" } }];
  assert.equal(liteRtToolPolicy({ tools, options: { toolChoice: "required" } }).required, true);
  assert.deepEqual(liteRtToolPolicy({ tools, options: { toolChoice: "none" } }).tools, []);
  const named = liteRtToolPolicy({ tools, options: { toolChoice: { type: "function", function: { name: "get_food_cart" } } } });
  assert.deepEqual(named.tools, [tools[1]]);
  assert.match(named.instruction, /get_food_cart/);
  assert.throws(() => liteRtToolPolicy({ tools, options: { toolChoice: { name: "container.exec" } } }), { code: "INFERENCE_INVALID_TOOL_CALL" });
});

test("zero or failed benchmark collection keeps generated usage unknown", async () => {
  const response = { content: "", tool_calls: [{ function: { name: "update_food_cart" } }] };
  const unavailable = await liteRtUsage({ getBenchmarkInfo: async () => ({ lastDecodeTokenCount: 0 }), getTokenCount: async () => 6000 }, response);
  assert.equal(unavailable.usage, undefined);
  assert.equal(unavailable.usageAvailable, false);
  const failed = await liteRtUsage({ getBenchmarkInfo: () => { throw new Error("benchmark unavailable"); }, getTokenCount: async () => 6000 }, response);
  assert.equal(failed.usage, undefined);
});

test("required tool policy is applied to the conversation and detects prose-only output", async () => {
  let config;
  const result = await runLiteRtConversation({ createConversation: async (value) => {
    config = value;
    return { getTokenCount: async () => 100, getBenchmarkInfo: async () => ({ lastDecodeTokenCount: 0 }), sendMessage: async () => ({ role: "model", content: "I will update the cart" }), delete: async () => {} };
  } }, { messages: [{ role: "user", content: "Prepare Biryani" }], tools: [{ name: "update_food_cart" }], options: { toolChoice: "required" } }, { contextTokens: 4096 });
  assert.match(config.preface.messages[0].content, /CURRENT TURN/);
  assert.equal(config.enableConstrainedDecoding, true);
  assert.equal(result.finishReason, "missing_required_tool_call");
  assert.equal(result.metrics.toolChoiceSatisfied, 0);
  assert.equal(result.usage, undefined);
});

test("completed calls outside the phase tool set are rejected before dispatch", async () => {
  await assert.rejects(runLiteRtConversation({ createConversation: async () => ({ getTokenCount: async () => 100, sendMessage: async () => ({ tool_calls: [{ function: { name: "update_food_cart", arguments: {} } }] }), delete: async () => {} }) }, {
    messages: [{ role: "user", content: "Verify the cart" }], tools: [{ name: "get_food_cart" }, { name: "update_food_cart" }], options: { toolChoice: { function: { name: "get_food_cart" } } },
  }, { contextTokens: 4096 }), { code: "INFERENCE_INVALID_TOOL_CALL" });
});

test("context overflow rejects before generation when protected evidence cannot fit", async () => {
  let deleted = false;
  let generated = false;
  await assert.rejects(runLiteRtConversation({ createConversation: async () => ({ getTokenCount: async () => 4000, delete: async () => { deleted = true; }, sendMessage: async () => { generated = true; } }) }, { messages: [{ role: "user", content: "task" }], options: {} }, { contextTokens: 4096 }), { code: "INFERENCE_CONTEXT_OVERFLOW" });
  assert.equal(deleted, true);
  assert.equal(generated, false);
});

test("deadlines report timeout and cancellation distinctly", async () => {
  const expired = createInferenceDeadline(Date.now() - 1);
  assert.equal(expired.signal.reason.code, "INFERENCE_TIMEOUT");
  expired.dispose();
  const cancelled = createInferenceDeadline(Date.now() + 10000);
  cancelled.cancel();
  assert.equal(cancelled.signal.reason.code, "INFERENCE_CANCELLED");
  cancelled.dispose();
  const pending = createInferenceDeadline(Date.now() + 10);
  await new Promise((resolve) => pending.signal.addEventListener("abort", resolve, { once: true }));
  assert.equal(pending.signal.reason.code, "INFERENCE_TIMEOUT");
  pending.dispose();
});
