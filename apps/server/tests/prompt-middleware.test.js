import { expect, it } from "vitest";
import { createAgent, createMiddleware } from "langchain";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { appendSystemInstruction, preserveInferenceError, replaceSystemInstruction } from "../src/swiggy-agent.js";

// Exercise the real LangChain middleware validator with a model boundary
// double. No provider or Swiggy network requests are made by these tests.
class PromptCaptureModel extends BaseChatModel {
  constructor() { super({}); this.prompts = []; }
  _llmType() { return "prompt-capture-test"; }
  bindTools() { return this; }
  async _generate(messages) {
    this.prompts.push(messages);
    return { generations: [{ text: "Captured", message: new AIMessage("Captured") }] };
  }
}

it("keeps menu grounding through repeated calls to the real middleware handler", async () => {
  const model = new PromptCaptureModel();
  const agent = createAgent({ model, tools: [], systemPrompt: "Base cart instructions", middleware: [createMiddleware({
    name: "GroundedPromptRegression",
    wrapModelCall: async (request, handler) => {
      const grounded = appendSystemInstruction(request, "VERIFIED MENU IDENTIFIERS: restaurantId must be a string.");
      await handler(grounded);
      return handler(grounded);
    },
  })] });
  await agent.invoke({ messages: [{ role: "user", content: "Prepare the selected dish" }] });
  expect(model.prompts).toHaveLength(2);
  for (const messages of model.prompts) {
    expect(messages[0].text).toBe("Base cart instructions");
    expect(messages[1].text).toContain("VERIFIED MENU IDENTIFIERS");
    expect(messages.at(-1).text).toBe("Prepare the selected dish");
  }
});

it("replaces a prompt through the real middleware validator", async () => {
  const model = new PromptCaptureModel();
  const agent = createAgent({ model, tools: [], systemPrompt: "Original", middleware: [createMiddleware({
    name: "ReplacementPromptRegression",
    wrapModelCall: (request, handler) => handler(replaceSystemInstruction(request, "Replacement")),
  })] });
  await agent.invoke({ messages: [{ role: "user", content: "Finish" }] });
  expect(model.prompts[0][0].text).toBe("Replacement");
});

it("preserves inference classification after LangChain wraps a middleware failure", async () => {
  const agent = createAgent({ model: new PromptCaptureModel(), tools: [], middleware: [createMiddleware({
    name: "ErrorClassificationRegression",
    wrapModelCall: () => { throw Object.assign(new Error("Repair exhausted"), { code: "INFERENCE_REPAIR_EXHAUSTED", statusCode: 502, fallbackRequested: true }); },
  })] });
  let wrapped;
  try { await agent.invoke({ messages: [{ role: "user", content: "Finish" }] }); } catch (error) { wrapped = error; }
  expect(wrapped.cause.code).toBe("INFERENCE_REPAIR_EXHAUSTED");
  expect(preserveInferenceError(wrapped)).toMatchObject({ code: "INFERENCE_REPAIR_EXHAUSTED", statusCode: 502, fallbackRequested: true });
});
