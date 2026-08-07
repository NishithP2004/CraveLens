export const MIN_LOCAL_CONTEXT_TOKENS = 4_096;
export const DEFAULT_LOCAL_CONTEXT_TOKENS = 16_384;
export const MAX_LOCAL_CONTEXT_TOKENS = 32_768;

export function buildOllamaChatPayload(request) {
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const toolNamesByCallId = new Map();
  const messages = request.messages.map((message) => {
    for (const call of message.toolCalls || []) {
      if (call.id) toolNamesByCallId.set(call.id, call.name || call.function?.name || "");
    }
    const normalized = toOllamaMessage(message);
    if (message.role === "tool" && !normalized.tool_name && message.toolCallId) {
      const toolName = toolNamesByCallId.get(message.toolCallId);
      if (toolName) normalized.tool_name = toolName;
    }
    return normalized;
  });
  const requirement = toolChoiceInstruction(request.options?.toolChoice, tools);
  if (requirement) applySystemInstruction(messages, requirement);
  return {
    model: request.model,
    messages,
    tools,
    stream: false,
    // Ollama's native thinking mode is opt-in because it can consume the
    // output allowance before a compact structured tool call is emitted.
    think: request.options?.thinkingEnabled === true,
    options: {
      temperature: request.options?.temperature,
      num_predict: request.options?.maxTokens,
      num_ctx: normalizeContextTokens(request.options?.contextTokens),
    },
  };
}

export function normalizeContextTokens(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_LOCAL_CONTEXT_TOKENS;
  return Math.max(MIN_LOCAL_CONTEXT_TOKENS, Math.min(MAX_LOCAL_CONTEXT_TOKENS, Math.round(numeric)));
}

export function toOllamaMessage(message) {
  const normalized = {
    role: message.role,
    content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
  };
  if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length) {
    normalized.tool_calls = message.toolCalls.map((call) => ({
      ...(call.id ? { id: call.id } : {}),
      function: {
        name: call.name || call.function?.name || "",
        arguments: call.args ?? call.function?.arguments ?? {},
      },
    }));
  }
  if (message.role === "tool") {
    const toolName = message.name || message.toolName;
    if (toolName) normalized.tool_name = toolName;
  }
  return normalized;
}

function toolChoiceInstruction(toolChoice, tools) {
  if (toolChoice === "required") {
    return "CURRENT TURN REQUIREMENT: Respond by calling at least one appropriate provided tool. Inspect the latest tool result, continue the task, and do not answer with prose.";
  }
  const requiredName = typeof toolChoice === "object"
    ? toolChoice?.function?.name || toolChoice?.name
    : undefined;
  if (!requiredName || !tools.some((tool) => (tool?.function?.name || tool?.name) === requiredName)) return "";
  return `CURRENT TURN REQUIREMENT: Call the ${requiredName} tool now. Do not answer with prose.`;
}

function applySystemInstruction(messages, instruction) {
  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex < 0) {
    messages.unshift({ role: "system", content: instruction });
    return;
  }
  messages[systemIndex] = {
    ...messages[systemIndex],
    content: `${messages[systemIndex].content}\n\n${instruction}`,
  };
}
