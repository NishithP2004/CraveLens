import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { DEFAULT_LOCAL_CONTEXT_TOKENS } from "@cravelens/shared";
import { encode as encodeToon } from "@toon-format/toon";
import { inferenceBroker } from "./inference-broker.js";

export class RemoteBrowserChatModel extends BaseChatModel {
  constructor(fields = {}) {
    super(fields);
    this.deviceId = fields.deviceId;
    this.provider = fields.provider || "litert";
    this.model = fields.model || "gemma-4-E2B-it-web";
    this.temperature = fields.temperature ?? 0.2;
    this.maxTokens = fields.maxTokens ?? 2048;
    this.contextTokens = fields.contextTokens ?? DEFAULT_LOCAL_CONTEXT_TOKENS;
    this.thinkingEnabled = fields.thinkingEnabled === true;
    this.tools = fields.tools || [];
    this.toolChoice = fields.toolChoice;
  }

  _llmType() { return "remote-browser"; }
  get identifyingParams() { return { provider: this.provider, model: this.model, contextTokens: this.contextTokens, thinkingEnabled: this.thinkingEnabled, local: true }; }

  bindTools(tools, kwargs = {}) {
    return new RemoteBrowserChatModel({
      callbacks: this.callbacks, tags: this.tags, metadata: this.metadata,
      deviceId: this.deviceId, provider: this.provider, model: this.model,
      temperature: this.temperature, maxTokens: this.maxTokens, contextTokens: this.contextTokens, thinkingEnabled: this.thinkingEnabled,
      tools: tools.map(normalizeTool), toolChoice: kwargs.tool_choice,
    });
  }

  async _generate(messages, options) {
    const result = await this._invoke(messages, options);
    const message = toMessage(result);
    return { generations: [{ text: result.content, message, generationInfo: { finishReason: result.finishReason, metrics: result.metrics } }], llmOutput: { tokenUsage: result.usage, modelName: this.model, provider: this.provider, local: true } };
  }

  async *_streamResponseChunks(messages, options, runManager) {
    const queue = [];
    let wake;
    let finished = false;
    let failure;
    const resultPromise = this._invoke(messages, { ...options, stream: true }, (content) => { queue.push(content); wake?.(); wake = undefined; })
      .catch((error) => { failure = error; return undefined; })
      .finally(() => { finished = true; wake?.(); });
    while (!finished || queue.length) {
      if (!queue.length) await new Promise((resolve) => { wake = resolve; });
      while (queue.length) {
        const content = queue.shift();
        await runManager?.handleLLMNewToken(content);
        yield new ChatGenerationChunk({ text: content, message: new AIMessageChunk({ content }) });
      }
    }
    if (failure) throw failure;
    const result = await resultPromise;
    const terminalContent = result.metrics?.streamed ? "" : result.content;
    const chunk = new AIMessageChunk({ content: terminalContent, tool_calls: result.toolCalls, usage_metadata: normalizeUsage(result.usage), response_metadata: { finishReason: result.finishReason, metrics: result.metrics, provider: this.provider, model: this.model } });
    if (terminalContent) await runManager?.handleLLMNewToken(terminalContent);
    yield new ChatGenerationChunk({ text: terminalContent, message: chunk, generationInfo: { finishReason: result.finishReason } });
  }

  _invoke(messages, options, onChunk) {
    const tools = compactLocalTools(this.tools);
    const normalizedMessages = compactLocalMessages(messages.map(normalizeMessage), tools);
    return inferenceBroker.invoke(this.deviceId, {
      provider: this.provider,
      model: this.model,
      messages: normalizedMessages,
      tools,
      stream: Boolean(options?.stream),
      options: { temperature: options?.temperature ?? this.temperature, maxTokens: options?.maxTokens ?? this.maxTokens, contextTokens: this.contextTokens, thinkingEnabled: this.thinkingEnabled, toolChoice: options?.tool_choice ?? this.toolChoice },
    }, { signal: options?.signal, onChunk });
  }
}

function normalizeMessage(message) {
  const type = message.getType?.() || message.type;
  const role = type === "human" ? "user" : type === "ai" ? "assistant" : type === "system" ? "system" : "tool";
  return { role, content: message.content, ...(message.name ? { name: message.name } : {}), ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}), ...(message.tool_calls?.length ? { toolCalls: message.tool_calls } : {}) };
}

function normalizeTool(value) {
  if (value?.type === "function") return value;
  return { type: "function", function: { name: value.name, description: value.description || "", parameters: value.schema ? toJsonSchema(value.schema) : value.parameters || { type: "object", properties: {} } } };
}

function toMessage(result) {
  return new AIMessage({ content: result.content, tool_calls: result.toolCalls, usage_metadata: normalizeUsage(result.usage), response_metadata: { finishReason: result.finishReason, metrics: result.metrics } });
}

function normalizeUsage(usage) {
  if (!usage) return undefined;
  return { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0, total_tokens: usage.totalTokens ?? (usage.inputTokens || 0) + (usage.outputTokens || 0) };
}

const LOCAL_REQUEST_CHARACTER_BUDGET = 24_000;
const LOCAL_TOOL_RESULT_CHARACTER_LIMIT = 4_500;

export function compactLocalMessages(messages, tools = [], characterBudget = LOCAL_REQUEST_CHARACTER_BUDGET) {
  const prepared = messages.map((message) => ({
    ...message,
    content: message.role === "tool"
      ? compactToolResultContent(message.content, LOCAL_TOOL_RESULT_CHARACTER_LIMIT)
      : compactTextContent(message.content, message.role === "system" ? 8_000 : 3_000),
  }));
  if (prepared.some((message) => message.role === "tool" && String(message.content).startsWith("TOON\n"))) {
    const system = prepared.find((message) => message.role === "system");
    if (system && typeof system.content === "string") {
      system.content += "\nTool results prefixed TOON use compact indentation and tabular rows; read them as the equivalent JSON data.";
    }
  }
  if (prepared.length <= 2) return prepared;

  const toolCharacters = JSON.stringify(tools).length;
  let remaining = Math.max(5_000, characterBudget - toolCharacters);
  const selected = new Set();
  for (let index = 0; index < prepared.length; index += 1) {
    if (prepared[index].role !== "system") continue;
    selected.add(index);
    remaining -= messageCharacters(prepared[index]);
  }

  const firstUser = prepared.findIndex((message) => message.role === "user");
  if (firstUser >= 0 && !selected.has(firstUser)) {
    selected.add(firstUser);
    remaining -= messageCharacters(prepared[firstUser]);
  }

  let suffixStart = prepared.length;
  for (let index = prepared.length - 1; index >= 0; index -= 1) {
    if (selected.has(index)) continue;
    const size = messageCharacters(prepared[index]);
    if (suffixStart < prepared.length && remaining - size < 0) break;
    suffixStart = index;
    remaining -= size;
  }
  while (suffixStart > 0 && prepared[suffixStart]?.role === "tool") suffixStart -= 1;
  for (let index = suffixStart; index < prepared.length; index += 1) selected.add(index);
  return prepared.filter((_message, index) => selected.has(index));
}

export function compactLocalTools(tools = []) {
  return tools.map((tool) => {
    const fn = tool?.function || tool;
    const compact = {
      ...fn,
      ...(fn?.description ? { description: String(fn.description).slice(0, 240) } : {}),
      ...(fn?.parameters ? { parameters: compactSchema(fn.parameters) } : {}),
    };
    return tool?.function ? { ...tool, function: compact } : compact;
  });
}

export function compactToolResultContent(content, limit = LOCAL_TOOL_RESULT_CHARACTER_LIMIT) {
  if (typeof content !== "string") return compactTextContent(content, limit);
  try {
    const value = JSON.parse(content);
    for (const [arrayLimit, stringLimit] of [[8, 500], [4, 300], [2, 180], [1, 100]]) {
      const compacted = compactJsonValue(value, { arrayLimit, stringLimit });
      const serialized = JSON.stringify(compacted);
      if (serialized.length <= limit) {
        const toon = `TOON\n${encodeToon(compacted)}`;
        return toon.length < serialized.length * 0.92 ? toon : serialized;
      }
    }
    return JSON.stringify({ _cravelensTruncated: true, summary: content.slice(0, Math.max(0, limit - 55)) });
  } catch {
    return content.length <= limit ? content : `${content.slice(0, limit - 3)}...`;
  }
}

function compactJsonValue(value, { arrayLimit, stringLimit }, depth = 0) {
  if (typeof value === "string") return value.length <= stringLimit ? value : `${value.slice(0, stringLimit - 3)}...`;
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "[nested data omitted]";
  if (Array.isArray(value)) {
    const items = value.slice(0, arrayLimit).map((item) => compactJsonValue(item, { arrayLimit, stringLimit }, depth + 1));
    if (value.length > arrayLimit) items.push({ _cravelensOmittedItems: value.length - arrayLimit });
    return items;
  }
  const entries = Object.entries(value).slice(0, 48);
  const compact = Object.fromEntries(entries.map(([key, item]) => [key, compactJsonValue(item, { arrayLimit, stringLimit }, depth + 1)]));
  if (Object.keys(value).length > entries.length) compact._cravelensOmittedFields = Object.keys(value).length - entries.length;
  return compact;
}

function compactSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 8) return schema;
  if (Array.isArray(schema)) return schema.slice(0, 24).map((item) => compactSchema(item, depth + 1));
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => {
    if (key === "description" && typeof value === "string") return [key, value.slice(0, 160)];
    if (key === "enum" && Array.isArray(value)) return [key, value.slice(0, 24)];
    return [key, compactSchema(value, depth + 1)];
  }));
}

function compactTextContent(content, limit) {
  if (typeof content === "string") return content.length <= limit ? content : `${content.slice(0, limit - 3)}...`;
  const serialized = JSON.stringify(content);
  return serialized.length <= limit ? content : `${serialized.slice(0, limit - 3)}...`;
}

function messageCharacters(message) { return JSON.stringify(message).length; }
