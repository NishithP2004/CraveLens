import { tracedOperation } from "./trace-context.js";
import { ChatGoogle } from "@langchain/google";
import { ChatOpenAI } from "@langchain/openai";
import { COMPACT_PROMPT_CONTEXT_TOKENS, DEFAULT_LOCAL_CONTEXT_TOKENS } from "@cravelens/shared";
import { config } from "./config.js";
import { inferenceBroker } from "./inference-broker.js";
import { RemoteBrowserChatModel } from "./remote-browser-chat-model.js";
import { getModelSettings, resolveModelCredential, safeHostedFetch } from "./model-settings.js";
import { ApprovalFallbackChatModel } from "./approval-fallback-chat-model.js";

const LOCAL_ORCHESTRATION_MAX_OUTPUT_TOKENS = 1_536;
const LOCAL_PROVIDERS = new Set(["aicore", "litert", "ollama"]);
const LOCAL_DEFAULT_MODELS = {
  aicore: "gemini-nano-4-fast",
  litert: "gemma-4-E2B-it-web",
  ollama: "gemma3:4b",
};
const HOSTED_GEMINI_DEFAULT = "gemini-3.5-flash";

export function selectAutoProvider(requested, providers = []) {
  if (requested !== "auto") return requested;
  const first = providers.find((item) => item && item.ready !== false && LOCAL_PROVIDERS.has(item.provider));
  return first?.provider || "litert";
}

export function effectiveContextTokens(settingsTokens, registeredTokens) {
  const settings = Number(settingsTokens) || DEFAULT_LOCAL_CONTEXT_TOKENS;
  const registered = Number(registeredTokens);
  if (!Number.isFinite(registered) || registered <= 0) return settings;
  return Math.min(settings, registered);
}

async function resolveAgentModelImpl(deviceId, { runId, onApprovalRequired, onFallbackActivated } = {}) {
  const settings = await getModelSettings(deviceId);
  const requested = settings.orchestration.provider;
  const provider = selectAutoProvider(requested, inferenceBroker.getCapabilities(deviceId));
  const model = settings.orchestration.model;
  const contextTokens = effectiveContextTokens(settings.orchestration.contextTokens || DEFAULT_LOCAL_CONTEXT_TOKENS, inferenceBroker.getRegisteredContextTokens(deviceId, provider));
  const thinkingEnabled = settings.orchestration.thinkingEnabled === true;
  if (LOCAL_PROVIDERS.has(provider)) {
    const resolvedModelName = model || LOCAL_DEFAULT_MODELS[provider];
    const localModel = new RemoteBrowserChatModel({ deviceId, provider, model: resolvedModelName, temperature: 0.2, maxTokens: LOCAL_ORCHESTRATION_MAX_OUTPUT_TOKENS, contextTokens, thinkingEnabled });
    const hosted = await resolveHostedFallbackModel(deviceId, settings);
    return {
      provider,
      model: resolvedModelName,
      chatModel: hosted && runId ? new ApprovalFallbackChatModel({ hostedFallback: settings.hostedFallback, localModel, hostedModel: hosted.chatModel, deviceId, runId, onApprovalRequired, onFallbackActivated, localDescription: { provider, model: resolvedModelName, hostedProvider: hosted.provider, hostedModel: hosted.model } }) : localModel,
      local: true,
      contextTokens,
      compactPrompt: contextTokens <= COMPACT_PROMPT_CONTEXT_TOKENS,
      thinkingEnabled,
      fallbackAvailable: Boolean(hosted) && settings.hostedFallback !== "none",
      hostedFallback: settings.hostedFallback,
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
    const resolvedModel = model || (config.agentModelProvider === "gemini" ? config.agentModelName : HOSTED_GEMINI_DEFAULT);
    return { provider, model: resolvedModel, local: false, thinkingEnabled, fallbackAvailable: false, chatModel: createGoogleModel(resolvedModel, credential.value, thinkingEnabled) };
  }
  throw new Error(`Unsupported orchestration provider: ${provider}`);
}

async function resolveHostedFallbackModel(deviceId, settings) {
  const google = await resolveModelCredential(deviceId, "google");
  if (google.value) {
    const model = config.agentModelProvider === "gemini" ? config.agentModelName : HOSTED_GEMINI_DEFAULT;
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
  return new ChatGoogle(model, { apiKey, metadata: {origin: "hosted", provider: "google", model}, temperature: 0.7, maxOutputTokens: 2048, thinkingBudget: thinkingEnabled ? 8192 : 0 });
}

function createOpenAIModel({ model, apiKey, baseUrl, thinkingEnabled }) {
  // LangChain forwards this only for OpenAI reasoning-capable models. Other
  // OpenAI-compatible endpoints retain normal tool-call compatibility.
  return new ChatOpenAI({
    model,
    metadata: {origin: "hosted", provider: "openai-compatible", model},
    apiKey,
    temperature: 1,
    maxTokens: 2048,
    maxRetries: 0,
    ...(thinkingEnabled ? { reasoning: { effort: "medium" } } : {}),
    configuration: { baseURL: baseUrl, fetch: safeHostedFetch },
  });
}

export const resolveAgentModel = tracedOperation("model.select", resolveAgentModelImpl, (_device, options = {}) => ({runId: options.runId, phase: "model_selection"}));
