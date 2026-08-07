import { afterEach, describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { config } from "./config.js";
import { decryptJson, encryptJson } from "./crypto-store.js";
import { inferenceBroker } from "./inference-broker.js";
import { assertSafeHostedBaseUrl, safeHostedFetch } from "./model-settings.js";
import { compactLocalMessages, compactLocalTools, compactToolResultContent, RemoteBrowserChatModel } from "./remote-browser-chat-model.js";
import { ModelSettingsSchema } from "@cravelens/shared";
import { ApprovalFallbackChatModel } from "./approval-fallback-chat-model.js";

const originalKey = config.credentialEncryptionKey;
afterEach(() => { config.credentialEncryptionKey = originalKey; vi.restoreAllMocks(); });

describe("encrypted credential envelopes", () => {
  it("round-trips JSON with authenticated encryption and rejects a modified tag", () => {
    config.credentialEncryptionKey = "a".repeat(64);
    const payload = encryptJson({ access_token: "never-return-this", expires_in: 60 }, "test-record");
    expect(payload).not.toContain("never-return-this");
    expect(decryptJson(payload, "test-record")).toEqual({ access_token: "never-return-this", expires_in: 60 });
    const envelope = JSON.parse(payload);
    const modifiedTag = Buffer.from(envelope.tag, "base64");
    modifiedTag[0] ^= 1;
    envelope.tag = modifiedTag.toString("base64");
    expect(() => decryptJson(JSON.stringify(envelope), "test-record")).toThrow();
  });
});

describe("model settings and hosted URL safety", () => {
  it("uses privacy-preserving local defaults", () => {
    expect(ModelSettingsSchema.parse({})).toEqual({ version: 1, vlm: { provider: "auto" }, orchestration: { provider: "auto", contextTokens: 16_384, thinkingEnabled: false }, ollama: { baseUrl: "http://localhost:11434" }, hostedFallback: "ask" });
    expect(ModelSettingsSchema.parse({ orchestration: { provider: "litert", model: "gemma-4-E4B-it-web", thinkingEnabled: true } }).orchestration).toMatchObject({ model: "gemma-4-E4B-it-web", thinkingEnabled: true });
    expect(ModelSettingsSchema.parse({ vlm: { provider: "litert-gemma4-e4b" } }).vlm.provider).toBe("litert-gemma4-e4b");
    expect(() => ModelSettingsSchema.parse({ orchestration: { provider: "litert", contextTokens: 65_536 } })).toThrow();
  });
  it("normalizes a custom Ollama origin and rejects credentials or API paths", () => {
    expect(ModelSettingsSchema.parse({ ollama: { baseUrl: "https://ollama.example.com/" } }).ollama.baseUrl).toBe("https://ollama.example.com");
    expect(() => ModelSettingsSchema.parse({ ollama: { baseUrl: "https://user:pass@ollama.example.com" } })).toThrow(/credentials/);
    expect(() => ModelSettingsSchema.parse({ ollama: { baseUrl: "https://ollama.example.com/api" } })).toThrow(/path/);
  });
  it("rejects local, private, and non-HTTPS model endpoints", async () => {
    await expect(assertSafeHostedBaseUrl("http://models.example.com/v1", vi.fn())).rejects.toThrow(/HTTPS/);
    await expect(assertSafeHostedBaseUrl("https://localhost/v1", vi.fn())).rejects.toThrow(/private|local/);
    await expect(assertSafeHostedBaseUrl("https://models.example.com/v1", async () => [{ address: "10.0.0.2" }])).rejects.toThrow(/private|local/);
  });
  it("accepts a public HTTPS endpoint after DNS validation", async () => {
    await expect(assertSafeHostedBaseUrl("https://models.example.com/v1", async () => [{ address: "203.0.113.5" }])).resolves.toBe("https://models.example.com/v1");
  });
  it("does not follow a hosted-model redirect into a private network", async () => {
    const response = new Response(null, { status: 302, headers: { location: "https://127.0.0.1/v1" } });
    await expect(safeHostedFetch("https://93.184.216.34/v1", {}, { fetchImpl: async () => response })).rejects.toThrow(/private|local/);
  });
});

describe("RemoteBrowserChatModel", () => {
  it("normalizes browser tool calls into an AIMessage and exposes local model metadata", async () => {
    vi.spyOn(inferenceBroker, "invoke").mockResolvedValue({ version: 1, requestId: crypto.randomUUID(), content: "", toolCalls: [{ id: "call-1", name: "search_menu", args: { query: "ramen" } }], finishReason: "tool_calls", usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 }, metrics: { totalMs: 42 } });
    const model = new RemoteBrowserChatModel({ deviceId: crypto.randomUUID(), provider: "litert", model: "gemma-4-E2B-it-web" }).bindTools([{ name: "search_menu", description: "Search", schema: z.object({ query: z.string() }) }]);
    const result = await model.invoke([new HumanMessage("Find ramen")]);
    expect(result.tool_calls).toEqual([{ id: "call-1", name: "search_menu", args: { query: "ramen" } }]);
    expect(result.usage_metadata).toEqual({ input_tokens: 12, output_tokens: 7, total_tokens: 19 });
    expect(inferenceBroker.invoke).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ provider: "litert", tools: [expect.objectContaining({ type: "function" })], options: expect.objectContaining({ contextTokens: 16_384, maxTokens: 2048, thinkingEnabled: false }) }), expect.any(Object));
  });
  it("forwards the persisted thinking toggle to browser-hosted models", async () => {
    vi.spyOn(inferenceBroker, "invoke").mockResolvedValue({ version: 1, requestId: crypto.randomUUID(), content: "", toolCalls: [], finishReason: "stop" });
    const model = new RemoteBrowserChatModel({ deviceId: crypto.randomUUID(), provider: "litert", model: "gemma-4-E4B-it-web", thinkingEnabled: true });
    await model.invoke([new HumanMessage("Find ramen")]);
    expect(inferenceBroker.invoke).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ model: "gemma-4-E4B-it-web", options: expect.objectContaining({ thinkingEnabled: true }) }), expect.any(Object));
  });
  it("forwards browser chunks through the LangChain streaming interface", async () => {
    vi.spyOn(inferenceBroker, "invoke").mockImplementation(async (_deviceId, input, options) => {
      options.onChunk?.("hello ");
      options.onChunk?.("world");
      return { version: 1, requestId: crypto.randomUUID(), content: "hello world", toolCalls: [], finishReason: "stop", metrics: { streamed: 1 } };
    });
    const model = new RemoteBrowserChatModel({ deviceId: crypto.randomUUID() });
    const chunks = [];
    for await (const chunk of await model.stream([new HumanMessage("Hello")])) chunks.push(String(chunk.content || ""));
    expect(chunks.join("")).toBe("hello world");
  });
  it("bounds local tool schemas and historical tool results while preserving the latest exchange", () => {
    const tools = compactLocalTools([{ type: "function", function: { name: "search_menu", description: "x".repeat(500), parameters: { type: "object", properties: { query: { type: "string", description: "y".repeat(500) } } } } }]);
    expect(tools[0].function.description).toHaveLength(240);
    expect(tools[0].function.parameters.properties.query.description).toHaveLength(160);

    const messages = compactLocalMessages([
      { role: "system", content: "Build a cart safely." },
      { role: "user", content: "Find ramen" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "search_restaurants", args: {} }] },
      { role: "tool", name: "search_restaurants", content: JSON.stringify({ restaurants: Array.from({ length: 50 }, (_, index) => ({ id: index, name: `Restaurant ${index}`, description: "z".repeat(1_000) })) }) },
      { role: "assistant", content: "", toolCalls: [{ id: "2", name: "search_menu", args: {} }] },
      { role: "tool", name: "search_menu", content: JSON.stringify({ items: [{ id: "ramen-1", name: "Miso ramen" }] }) },
    ], tools, 8_000);
    expect(messages[0].role).toBe("system");
    expect(messages.some((message) => message.role === "user")).toBe(true);
    expect(messages.at(-1).content).toContain("ramen-1");
    expect(messages.filter((message) => message.role === "tool").every((message) => String(message.content).length <= 4_500)).toBe(true);
  });
  it("uses TOON only when it materially reduces a local tool response", () => {
    const json = JSON.stringify({ items: Array.from({ length: 8 }, (_, index) => ({ id: `item-${index}`, name: `Ramen ${index}`, price: 200 + index, available: true })) });
    const compact = compactToolResultContent(json);
    expect(compact.startsWith("TOON\n")).toBe(true);
    expect(compact.length).toBeLessThan(json.length * 0.92);
    expect(compactToolResultContent('{"ok":true}')).toBe('{"ok":true}');
  });
});

describe("ApprovalFallbackChatModel", () => {
  it("switches the entire run to a tool-bound hosted runnable after one approval", async () => {
    const localGenerate = vi.fn(async () => { throw Object.assign(new Error("Browser model disconnected"), { code: "INFERENCE_DISCONNECTED" }); });
    const localModel = { _generate: localGenerate, bindTools() { return this; } };
    const hostedInvoke = vi.fn(async () => new AIMessage({ content: "", tool_calls: [{ id: "call-1", name: "get_addresses", args: {} }] }));
    const hostedModel = { invoke: hostedInvoke, bindTools() { return this; } };
    const requestApproval = vi.fn(async (_deviceId, runId) => ({ runId, status: "pending", expiresAt: Date.now() + 120_000 }));
    const waitForDecision = vi.fn(async () => "approved");
    const onFallbackActivated = vi.fn();
    const model = new ApprovalFallbackChatModel({
      localModel, hostedModel, deviceId: "device-1", runId: "run-1",
      requestApproval, waitForDecision, onFallbackActivated,
      localDescription: { provider: "ollama", hostedProvider: "google" },
    });
    const bound = model.bindTools([]);
    expect(model.isUsingLocal()).toBe(true);

    const first = await bound._generate([new HumanMessage("Find ramen")], {});
    expect(model.isUsingLocal()).toBe(false);
    const second = await model._generate([new HumanMessage("Continue")], {});

    expect(first.generations[0].message.tool_calls[0].name).toBe("get_addresses");
    expect(second.generations[0].message.tool_calls[0].name).toBe("get_addresses");
    expect(localGenerate).toHaveBeenCalledTimes(1);
    expect(hostedInvoke).toHaveBeenCalledTimes(2);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(waitForDecision).toHaveBeenCalledTimes(1);
    expect(onFallbackActivated).toHaveBeenCalledWith(expect.objectContaining({ status: "approved", hostedProvider: "google" }));
  });
});
