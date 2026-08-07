import assert from "node:assert/strict";
import test from "node:test";
import { buildOllamaChatPayload, DEFAULT_LOCAL_CONTEXT_TOKENS, MAX_LOCAL_CONTEXT_TOKENS, toOllamaMessage } from "./ollama-chat.js";

test("builds a bounded Ollama agent request with thinking disabled by default", () => {
  const payload = buildOllamaChatPayload({
    model: "gemma4:e2b",
    messages: [{ role: "system", content: "Use tools." }, { role: "user", content: "Find ramen." }],
    tools: [{ type: "function", function: { name: "search_menu", parameters: { type: "object" } } }],
    options: { temperature: 0.2, maxTokens: 512, contextTokens: 32_768, toolChoice: "required" },
  });

  assert.equal(payload.think, false);
  assert.equal(payload.options.num_ctx, MAX_LOCAL_CONTEXT_TOKENS);
  assert.equal(payload.options.num_predict, 512);
  assert.match(payload.messages[0].content, /CURRENT TURN REQUIREMENT/);
});

test("enables Ollama native thinking when requested", () => {
  const payload = buildOllamaChatPayload({ model: "gemma4:e4b", messages: [{ role: "user", content: "Find ramen." }], options: { thinkingEnabled: true } });
  assert.equal(payload.think, true);
});

test("serializes assistant calls and named tool results in Ollama chat format", () => {
  assert.deepEqual(toOllamaMessage({
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call-1", name: "search_restaurants", args: { query: "Ramen" } }],
  }), {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call-1", function: { name: "search_restaurants", arguments: { query: "Ramen" } } }],
  });
  assert.deepEqual(toOllamaMessage({ role: "tool", name: "search_restaurants", content: "{}" }), {
    role: "tool",
    content: "{}",
    tool_name: "search_restaurants",
  });

  const payload = buildOllamaChatPayload({
    model: "gemma4:e2b",
    messages: [
      { role: "assistant", content: "", toolCalls: [{ id: "call-2", name: "search_menu", args: { query: "Ramen" } }] },
      { role: "tool", toolCallId: "call-2", content: "{}" },
    ],
    tools: [],
    options: {},
  });
  assert.equal(payload.messages[1].tool_name, "search_menu");
  assert.equal(payload.options.num_ctx, DEFAULT_LOCAL_CONTEXT_TOKENS);
});
