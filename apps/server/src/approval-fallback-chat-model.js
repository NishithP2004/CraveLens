import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { requestFallbackApproval, waitForFallbackDecision } from "./fallback-approval.js";

export class ApprovalFallbackChatModel extends BaseChatModel {
  constructor(fields = {}) {
    super(fields);
    this.localModel = fields.localModel;
    this.hostedModel = fields.hostedModel;
    this.deviceId = fields.deviceId;
    this.runId = fields.runId;
    this.onApprovalRequired = fields.onApprovalRequired;
    this.onFallbackActivated = fields.onFallbackActivated;
    this.localDescription = fields.localDescription;
    this.fallbackState = fields.fallbackState || { mode: "local" };
    this.requestApproval = fields.requestApproval || requestFallbackApproval;
    this.waitForDecision = fields.waitForDecision || waitForFallbackDecision;
  }
  _llmType() { return "approval-fallback"; }
  isUsingLocal() { return this.fallbackState.mode !== "hosted"; }
  bindTools(tools, kwargs = {}) {
    return new ApprovalFallbackChatModel({ callbacks: this.callbacks, tags: this.tags, metadata: this.metadata, deviceId: this.deviceId, runId: this.runId, onApprovalRequired: this.onApprovalRequired, onFallbackActivated: this.onFallbackActivated, localDescription: this.localDescription, fallbackState: this.fallbackState, requestApproval: this.requestApproval, waitForDecision: this.waitForDecision, localModel: this.localModel.bindTools(tools, kwargs), hostedModel: this.hostedModel.bindTools(tools, kwargs) });
  }
  async _generate(messages, options, runManager) {
    if (this.fallbackState.mode === "hosted") return generateWithModel(this.hostedModel, messages, options, runManager);
    try { return await generateWithModel(this.localModel, messages, options, runManager); }
    catch (error) {
      if (!/^INFERENCE_/.test(error?.code || "")) throw error;
      const fallback = await this.requestApproval(this.deviceId, this.runId, { ...this.localDescription, reason: error.code });
      await this.onApprovalRequired?.(fallback);
      const decision = await this.waitForDecision(this.deviceId, this.runId, { signal: options?.signal });
      if (decision !== "approved") throw Object.assign(new Error(decision === "denied" ? "Hosted model fallback was denied" : "Hosted model fallback approval expired"), { code: "INFERENCE_FALLBACK_DENIED", fallbackRequested: true });
      this.fallbackState.mode = "hosted";
      await this.onFallbackActivated?.({ ...fallback, status: "approved", ...this.localDescription });
      return generateWithModel(this.hostedModel, messages, options, runManager);
    }
  }
  async *_streamResponseChunks(messages, options, runManager) {
    const result = await this._generate(messages, options, runManager);
    const generation = result.generations[0];
    yield new ChatGenerationChunk({ text: generation.text || "", message: new AIMessageChunk(generation.message), generationInfo: generation.generationInfo });
  }
}

async function generateWithModel(model, messages, options, runManager) {
  const child = runManager?.getChild?.();
  if (typeof model?._generate === "function") return model._generate(messages, options, child);
  if (typeof model?.invoke !== "function") throw new TypeError("Fallback model is not invokable");
  const message = await model.invoke(messages, { ...options, ...(child ? { callbacks: child } : {}) });
  const text = messageText(message?.content);
  return {
    generations: [{ text, message, generationInfo: message?.response_metadata }],
    llmOutput: { tokenUsage: message?.usage_metadata },
  };
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((part) => typeof part === "string" ? part : part?.text || "").join("");
}
