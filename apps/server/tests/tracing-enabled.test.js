import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const client = vi.hoisted(() => ({callTool: vi.fn(), listTools: vi.fn()}));
vi.mock("../src/swiggy-auth.js", () => ({getSwiggySession: async () => ({client})}));
vi.stubEnv("NODE_ENV", "development");
vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
const {initializeLangfuse, createLangfuseHandler, shutdownLangfuse, PrivacySpanProcessor} = await import("../src/langfuse.js");
const {traceOperation, traceContext} = await import("../src/trace-context.js");
const {connectSwiggyFood} = await import("../src/swiggy-mcp.js");
const {generateCartExplanation} = await import("../src/cart-explanation.js");
const {refinePreferences} = await import("../src/preference-builder.js");
const {ApprovalFallbackChatModel} = await import("../src/approval-fallback-chat-model.js");
const exporter = new InMemorySpanExporter();
const processor = new SimpleSpanProcessor(exporter);
const secret = "PRIVATE-PAYLOAD-42 Bearer sk-user-credential 12 Secret Street";
class TestModel extends BaseChatModel {
  constructor(origin, fail = false) { super({metadata: {origin, provider: origin === "local" ? "litert" : "google", model: "test-model"}}); this.fail = fail; }
  _llmType() { return "test-model"; }
  bindTools() { return this; }
  async _generate() {
    if (this.fail) throw Object.assign(new Error(secret), {code: "INFERENCE_UNAVAILABLE"});
    return {generations: [{text: this.reply || secret, message: new AIMessage({content: this.reply || secret, usage_metadata: {input_tokens: 3, output_tokens: 2, total_tokens: 5}})}]};
  }
}
beforeAll(() => expect(initializeLangfuse({spanProcessor: processor})).toEqual({enabled: true}));
afterAll(async () => {await shutdownLangfuse(); vi.unstubAllEnvs();});
const spansFor = (session) => {
  const all = exporter.getFinishedSpans();
  const ids = new Set(all.filter(s => s.attributes["session.id"] === session).map(s => s.spanContext().traceId));
  return all.filter(s => ids.has(s.spanContext().traceId));
};

describe("enabled workflow tracing", () => {
  it("exports nested generation, decision-tool and actual MCP execution spans under one root", async () => {
    const session = crypto.randomUUID();
    client.callTool.mockResolvedValue({structuredContent: {data: {private: secret}}});
    client.listTools.mockResolvedValue({tools: []});
    await traceOperation("cart.prepare", {sessionId: session, operation: "cart.prepare"}, async () => {
      const mcp = await connectSwiggyFood("device-private");
      await mcp.listTools();
      await new TestModel("local").invoke([new HumanMessage(secret)], {callbacks: [createLangfuseHandler()]});
      const decisionTool = tool(async () => traceOperation("agent.tool.search_menu", {tool: "search_menu"}, () => mcp.call("search_menu", {query: secret}), {type: "tool"}), {name: "search_menu", description: "test", schema: z.object({})});
      await decisionTool.invoke({}, {callbacks: [createLangfuseHandler()]});
      await mcp.call("get_food_cart", {addressId: secret});
    });
    await processor.forceFlush();
    const spans = spansFor(session);
    const root = spans.find(s => s.name === "cart.prepare");
    expect(root).toBeDefined();
    expect(spans.some(s => s.attributes["langfuse.observation.type"] === "generation")).toBe(true);
    expect(spans.filter(s => s.name === "swiggy.mcp.search_menu")).toHaveLength(1);
    expect(spans.some(s => s.name === "swiggy.mcp.get_food_cart")).toBe(true);
    expect(spans.every(s => s.spanContext().traceId === root.spanContext().traceId)).toBe(true);
    const execution = spans.find(s => s.name === "swiggy.mcp.search_menu");
    expect(execution.parentSpanContext?.spanId).not.toBe(root.spanContext().spanId);
    expect(JSON.stringify(spans.map(s => ({name: s.name, attributes: s.attributes, status: s.status, events: s.events})))).not.toContain("PRIVATE-PAYLOAD");
    expect(JSON.stringify(spans.map(s => s.resource.attributes))).not.toContain("process.command_args");
    const generation = spans.find(s => s.attributes["langfuse.observation.type"] === "generation");
    expect(generation.attributes["langfuse.observation.usage_details"]).toBeDefined();
  });
  it("records separate local and hosted attempts without exporting the failed model's exception", async () => {
    const session = crypto.randomUUID();
    await traceOperation("preferences.build", {sessionId: session}, async () => {
      const model = new ApprovalFallbackChatModel({localModel: new TestModel("local", true), hostedModel: new TestModel("hosted"), hostedFallback: "auto", localDescription: {provider: "litert", model: "test-model", hostedProvider: "google", hostedModel: "test-model"}});
      await model.invoke([new HumanMessage(secret)], {callbacks: [createLangfuseHandler()]});
    });
    const spans = spansFor(session);
    expect(spans.find(s => s.name === "inference.local").attributes["langfuse.observation.level"]).toBe("ERROR");
    expect(spans.some(s => s.name === "inference.hosted")).toBe(true);
    const generations = spans.filter(s => s.attributes["langfuse.observation.type"] === "generation");
    expect(generations).toHaveLength(2);
    expect(generations.map(s => s.attributes["langfuse.observation.metadata.origin"]).sort()).toEqual(["hosted", "local"]);
    expect(JSON.stringify(spans.map(s => ({attributes: s.attributes, status: s.status, events: s.events})))).not.toContain("PRIVATE-PAYLOAD");
  });
  it("traces preference and explanation calls outside the cart agent loop", async () => {
    const session = crypto.randomUUID();
    client.listTools.mockResolvedValue({tools: [{name: "get_food_orders"}, {name: "get_food_order_details", inputSchema: {properties: {orderId: {type: "string"}}}}]});
    client.callTool.mockImplementation(async ({name, arguments: args}) => ({structuredContent: {data: name === "get_food_orders" ? {orders: [{orderId: "1"}]} : {order: {orderId: args.orderId, items: [{name: secret}]}}}}));
    await traceOperation("cart.prepare", {sessionId: session}, async () => {
      const model = new TestModel("hosted");
      model.reply = JSON.stringify({preferences: "A tentative preference", notes: "Limited history"});
      await refinePreferences(secret, {mcp: await connectSwiggyFood("device"), chatModel: model, progress: async () => {}, addressId: "selected-address"});
      model.reply = JSON.stringify({points: ["Based on the verified cart"]});
      expect((await generateCartExplanation(model, {private: secret})).source).toBe("model");
    });
    const spans = spansFor(session);
    expect(spans.some(s => s.name === "preferences.generate")).toBe(true);
    expect(spans.some(s => s.name === "cart.explanation.generate")).toBe(true);
    expect(spans.filter(s => s.attributes["langfuse.observation.type"] === "generation")).toHaveLength(2);
    expect(JSON.stringify(spans.map(s => s.attributes))).not.toContain("PRIVATE-PAYLOAD");
  });
  it("traces approval denial and never invokes the hosted model without approval", async () => {
    const session = crypto.randomUUID();
    const hosted = new TestModel("hosted");
    const invoke = vi.spyOn(hosted, "invoke");
    const model = new ApprovalFallbackChatModel({localModel: new TestModel("local", true), hostedModel: hosted, hostedFallback: "ask", requestApproval: async () => ({}), waitForDecision: async () => "denied"});
    await expect(traceOperation("cart.prepare", {sessionId: session}, () => model.invoke([new HumanMessage(secret)], {callbacks: [createLangfuseHandler()]}))).rejects.toMatchObject({code: "INFERENCE_FALLBACK_DENIED"});
    expect(invoke).not.toHaveBeenCalled();
    expect(spansFor(session).some(s => s.name === "fallback.approval.wait")).toBe(true);
    expect(JSON.stringify(spansFor(session).map(s => ({attributes: s.attributes, status: s.status})))).not.toContain("PRIVATE-PAYLOAD");
  });
  it("isolates concurrent session metadata and preserves business failures", async () => {
    const sessions = [crypto.randomUUID(), crypto.randomUUID()];
    await Promise.all(sessions.map(sessionId => traceOperation("cart.concurrent", {sessionId}, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(traceContext().sessionId).toBe(sessionId);
      await traceOperation("cart.child", {}, async () => {});
    })));
    for (const session of sessions) expect(spansFor(session)).toHaveLength(2);
    const failure = new Error(secret);
    await expect(traceOperation("checkout.failure", {}, async () => {throw failure;})).rejects.toBe(failure);
  });
  it("does not retry business execution when the processor throws", async () => {
    const exportFailure = vi.spyOn(processor, "onEnd").mockImplementationOnce(() => {throw Error(secret);});
    const failing = new PrivacySpanProcessor({onStart() {throw Error(secret);}, onEnd() {throw Error(secret);}, forceFlush() {}, shutdown() {}});
    const operation = vi.fn(async () => "placed-once");
    await traceOperation("checkout.once", {}, async () => {
      failing.onStart({}, {});
      const result = await operation();
      failing.onEnd({attributes: {}, name: "checkout.once", status: {code: 0}, events: []});
      return result;
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(exportFailure).toHaveBeenCalled();
    exportFailure.mockRestore();
  });
  it("preserves one failed MCP execution without adding a retry", async () => {
    client.callTool.mockRejectedValueOnce(new Error(secret));
    const session = crypto.randomUUID();
    const before = client.callTool.mock.calls.length;
    await expect(traceOperation("checkout.place", {sessionId: session}, async () => (await connectSwiggyFood("device")).call("place_food_order", {private: secret}))).rejects.toThrow(secret);
    expect(client.callTool.mock.calls.length - before).toBe(1);
    expect(spansFor(session).filter(s => s.name === "swiggy.mcp.place_food_order")).toHaveLength(1);
  });
});
