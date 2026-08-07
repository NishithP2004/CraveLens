import { ChatGoogle } from "@langchain/google";
import { ChatOpenAI } from "@langchain/openai";
import { DEFAULT_LOCAL_CONTEXT_TOKENS } from "@cravelens/shared";
import { config } from "./config.js";
import { RemoteBrowserChatModel } from "./remote-browser-chat-model.js";
import { getModelSettings, resolveModelCredential, safeHostedFetch } from "./model-settings.js";
import { ApprovalFallbackChatModel } from "./approval-fallback-chat-model.js";

const LOCAL_ORCHESTRATION_MAX_OUTPUT_TOKENS = 1_536;

export async function resolveAgentModel(deviceId, { runId, onApprovalRequired, onFallbackActivated } = {}) {
  const settings = await getModelSettings(deviceId);
  const requested = settings.orchestration.provider;
  const provider = requested === "auto" ? "litert" : requested;
  const model = settings.orchestration.model;
  const contextTokens = settings.orchestration.contextTokens || DEFAULT_LOCAL_CONTEXT_TOKENS;
  const thinkingEnabled = settings.orchestration.thinkingEnabled === true;
  if (provider === "litert" || provider === "ollama") {
    const localModel = new RemoteBrowserChatModel({ deviceId, provider, model: model || (provider === "litert" ? "gemma-4-E2B-it-web" : "gemma3:4b"), temperature: 0.2, maxTokens: LOCAL_ORCHESTRATION_MAX_OUTPUT_TOKENS, contextTokens, thinkingEnabled });
    const hosted = await resolveHostedFallbackModel(deviceId, settings);
    return {
      provider,
      model: model || (provider === "litert" ? "gemma-4-E2B-it-web" : "gemma3:4b"),
      chatModel: hosted && runId ? new ApprovalFallbackChatModel({ localModel, hostedModel: hosted.chatModel, deviceId, runId, onApprovalRequired, onFallbackActivated, localDescription: { provider, model: model || (provider === "litert" ? "gemma-4-E2B-it-web" : "gemma3:4b"), hostedProvider: hosted.provider, hostedModel: hosted.model } }) : localModel,
      local: true,
      contextTokens,
      thinkingEnabled,
      fallbackAvailable: Boolean(hosted),
    };
  }
  if (provider === "openai-compatible") {
    const credential = await resolveModelCredential(deviceId, "openai");
    if (!credential.value) throw new Error("Configure an OpenAI-compatible API key before using this orchestration provider.");
    const resolvedModel = model || (config.agentModelProvider === "openai" ? config.agentModelName : "gpt-4o-mini");
    return { provider, model: resolvedModel, local: false, thinkingEnabled, fallbackAvailable: false, chatModel: createOpenAIModel({ model: resolvedModel, apiKey: credential.value, baseUrl: settings.orchestration.baseUrl || config.agentModelBaseUrl, thinkingEnabled }) };
  }
  if (provider === "google") {
    const credential = await resolveModelCredential(deviceId, "google");
    if (!credential.value) throw new Error("Configure a Google API key before using this orchestration provider.");
    const resolvedModel = model || (config.agentModelProvider === "gemini" ? config.agentModelName : "gemini-2.5-flash");
    return { provider, model: resolvedModel, local: false, thinkingEnabled, fallbackAvailable: false, chatModel: createGoogleModel(resolvedModel, credential.value, thinkingEnabled) };
  }
  throw new Error(`Unsupported orchestration provider: ${provider}`);
}

async function resolveHostedFallbackModel(deviceId, settings) {
  const google = await resolveModelCredential(deviceId, "google");
  if (google.value) {
    const model = config.agentModelProvider === "gemini" ? config.agentModelName : "gemini-2.5-flash";
    return { provider: "google", model, chatModel: createGoogleModel(model, google.value, settings.orchestration.thinkingEnabled === true) };
  }
  const openai = await resolveModelCredential(deviceId, "openai");
  if (openai.value) {
    const model = config.agentModelProvider === "openai" ? config.agentModelName : "gpt-4o-mini";
    return { provider: "openai-compatible", model, chatModel: createOpenAIModel({ model, apiKey: openai.value, baseUrl: settings.orchestration.baseUrl || config.agentModelBaseUrl, thinkingEnabled: settings.orchestration.thinkingEnabled === true }) };
  }
  return undefined;
}

function createGoogleModel(model, apiKey, thinkingEnabled) {
  // Gemini accepts an explicit zero budget to disable its thinking blocks.
  return new ChatGoogle(model, { apiKey, temperature: 0.7, maxOutputTokens: 2048, thinkingBudget: thinkingEnabled ? 8192 : 0 });
}

function createOpenAIModel({ model, apiKey, baseUrl, thinkingEnabled }) {
  // LangChain forwards this only for OpenAI reasoning-capable models. Other
  // OpenAI-compatible endpoints retain normal tool-call compatibility.
  return new ChatOpenAI({
    model,
    apiKey,
    temperature: 1,
    maxTokens: 2048,
    maxRetries: 0,
    ...(thinkingEnabled ? { reasoning: { effort: "medium" } } : {}),
    configuration: { baseURL: baseUrl, fetch: safeHostedFetch },
  });
}
