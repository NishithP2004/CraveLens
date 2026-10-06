import { CallbackManager } from "@langchain/core/callbacks/manager";
import { traceOperation } from "./trace-context.js";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { requestFallbackApproval, waitForFallbackDecision } from "./fallback-approval.js";

export class ApprovalFallbackChatModel extends BaseChatModel {
  constructor(fields = {}) {
    super(fields);
    this.localModel = fields.localModel;
    this.hostedModel = fields.hostedModel;
    this.hostedFallback = ["auto", "ask", "none"].includes(fields.hostedFallback) ? fields.hostedFallback : "ask";
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
    return new ApprovalFallbackChatModel({ hostedFallback: this.hostedFallback, callbacks: this.callbacks, tags: this.tags, metadata: this.metadata, deviceId: this.deviceId, runId: this.runId, onApprovalRequired: this.onApprovalRequired, onFallbackActivated: this.onFallbackActivated, localDescription: this.localDescription, fallbackState: this.fallbackState, requestApproval: this.requestApproval, waitForDecision: this.waitForDecision, localModel: this.localModel.bindTools(tools, kwargs), hostedModel: this.hostedModel.bindTools(tools, kwargs) });
  }
  async _generate(messages, options, runManager) {
    if (this.fallbackState.mode === "hosted") return traceOperation("inference.hosted", {origin: "hosted", provider: this.localDescription?.hostedProvider, model: this.localDescription?.hostedModel}, () => generateWithModel(this.hostedModel, messages, options, runManager));
    const inferenceStartedAt = Date.now();
    try { return await traceOperation("inference.local", {origin: "local", provider: this.localDescription?.provider, model: this.localDescription?.model}, () => generateWithModel(this.localModel, messages, options, runManager)); }
    catch (error) {
      if (!/^INFERENCE_/.test(error?.code || "")) throw error;
      if (["INFERENCE_CANCELLED", "INFERENCE_CART_UNVERIFIED"].includes(error.code) || options?.signal?.aborted || this.hostedFallback === "none") throw error;
      const localFailure = { code: error.code, message: String(error.message || "Local inference failed").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500), durationMs: Date.now() - inferenceStartedAt };
      if (this.hostedFallback === "auto") {
        this.fallbackState.mode = "hosted";
        await this.onFallbackActivated?.({ runId: this.runId, status: "approved", automatic: true, reason: error.code, localFailure, ...this.localDescription });
        return traceOperation("inference.hosted", {origin: "hosted", provider: this.localDescription?.hostedProvider, model: this.localDescription?.hostedModel}, () => generateWithModel(this.hostedModel, messages, options, runManager));
      }
      const requested = await this.requestApproval(this.deviceId, this.runId, { ...this.localDescription, reason: error.code, localFailure });
      const fallback = { ...requested, reason: error.code, localFailure };
      await this.onApprovalRequired?.(fallback);
      const approvalStartedAt = Date.now();
      const decision = await traceOperation("fallback.approval.wait", {phase: "fallback_approval"}, () => this.waitForDecision(this.deviceId, this.runId, { signal: options?.signal }));
      if (decision !== "approved") throw Object.assign(new Error(`${decision === "denied" ? "Hosted model fallback was denied" : "Hosted model fallback approval expired"}; local inference failed with ${localFailure.code}: ${localFailure.message}`, { cause: error }), { code: "INFERENCE_FALLBACK_DENIED", fallbackRequested: true, localFailure, approvalDurationMs: Date.now() - approvalStartedAt });
      this.fallbackState.mode = "hosted";
      await this.onFallbackActivated?.({ ...fallback, status: "approved", ...this.localDescription });
      return traceOperation("inference.hosted", {origin: "hosted", provider: this.localDescription?.hostedProvider, model: this.localDescription?.hostedModel}, () => generateWithModel(this.hostedModel, messages, options, runManager));
    }
  }
  async *_streamResponseChunks(messages, options, runManager) {
    const result = await this._generate(messages, options, runManager);
    const generation = result.generations[0];
    yield new ChatGenerationChunk({ text: generation.text || "", message: new AIMessageChunk(generation.message), generationInfo: generation.generationInfo });
  }
}

async function generateWithModel(model, messages, options, runManager) {
  // LLM run managers have no getChild(); explicitly preserve inherited callbacks.
  const child = runManager?.getChild?.() || (runManager ? new CallbackManager(runManager.runId, {
    handlers: runManager.inheritableHandlers || runManager.handlers,
    inheritableHandlers: runManager.inheritableHandlers || runManager.handlers,
    tags: runManager.inheritableTags, inheritableTags: runManager.inheritableTags,
    metadata: runManager.inheritableMetadata, inheritableMetadata: runManager.inheritableMetadata,
  }) : undefined);
  // invoke() merges the provider's bound defaults (tools and tool_choice).
  // Calling _generate() directly silently drops ChatOpenAI.bindTools settings.
  if (typeof model?.invoke !== "function") {
    if (typeof model?._generate === "function") return model._generate(messages, options, child);
    throw new TypeError("Fallback model is not invokable");
  }
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
