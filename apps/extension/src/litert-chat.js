export const LITERT_MAX_OUTPUT_TOKENS = 1536;

export function liteRtToolPolicy(request) {
  const choice = request.options?.toolChoice;
  const tools = request.tools || [];
  const name = typeof choice === "object" ? choice?.function?.name || choice?.name : undefined;
  if (name && !tools.some((tool) => (tool.function?.name || tool.name) === name)) throw Object.assign(new Error(`Required tool ${name} is unavailable`), { code: "INFERENCE_INVALID_TOOL_CALL" });
  return {
    tools: choice === "none" ? [] : name ? tools.filter((tool) => (tool.function?.name || tool.name) === name) : tools,
    required: choice === "required" || Boolean(name),
    instruction: choice === "none" ? "CURRENT TURN: Return the final answer without calling tools." : name ? `CURRENT TURN: Invoke exactly the ${name} tool using its declared schema. Do not respond with prose.` : choice === "required" ? "CURRENT TURN: Invoke an appropriate provided tool using its declared schema. Do not respond with prose. Copy identifiers from returned menu evidence using their declared field names and types." : "",
  };
}

export async function liteRtUsage(conversation, response) {
  // Telemetry is optional: it must never discard a completed model response.
  const [benchmarkResult, tokenResult] = await Promise.allSettled([Promise.resolve().then(() => conversation.getBenchmarkInfo()), Promise.resolve().then(() => conversation.getTokenCount())]);
  const benchmark = benchmarkResult.status === "fulfilled" ? benchmarkResult.value || {} : {};
  const totalTokens = tokenResult.status === "fulfilled" ? tokenResult.value : undefined;
  const count = benchmark.lastDecodeTokenCount;
  const hasOutput = messageText(response).length > 0 || Boolean(response.tool_calls?.length);
  const available = Number.isFinite(count) && count >= 0 && !(count === 0 && hasOutput) && Number.isFinite(totalTokens) && totalTokens >= count;
  return {
    ...(available ? { usage: { inputTokens: Math.max(0, totalTokens - Math.round(count)), outputTokens: Math.round(count), totalTokens } } : {}),
    benchmark,
    usageAvailable: available,
  };
}

export function messageText(message) {
  return typeof message?.content === "string" ? message.content : (message?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("");
}

export function toLiteRtMessages(messages) {
  const names = new Map();
  return messages.map((message) => {
    for (const call of message.toolCalls || []) if (call.id) names.set(call.id, call.name);
    if (message.role === "tool") {
      const content = message.content;
      let response = content;
      if (typeof content === "string" && !content.startsWith("TOON\n")) {
        try { response = JSON.parse(content); } catch { response = { content }; }
      }
      const name = message.name || names.get(message.toolCallId);
      if (!name) throw Object.assign(new Error("Tool response is missing its function name"), { code: "INFERENCE_INVALID_HISTORY" });
      return { role: "tool", content: [{ type: "tool_response", name, response }] };
    }
    return { role: message.role === "assistant" ? "model" : message.role, content: message.content, ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({ type: "function", id: call.id, function: { name: call.name, arguments: call.args } })) } : {}) };
  });
}

// Preserve the initial task, system instructions, last exchange, and the latest
// menu/cart evidence. Remove whole older exchanges so tool responses stay paired.
export function trimOldestExchange(messages) {
  const protectedIndices = new Set();
  const firstUser = messages.findIndex((message) => message.role === "user");
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  messages.forEach((message, index) => { if (message.role === "system" || index === firstUser || index === lastUser) protectedIndices.add(index); });
  for (const names of [["search_menu", "get_restaurant_menu"], ["update_food_cart"]]) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "tool" && messages[i].content?.some?.((part) => names.includes(part.name))) {
        protectedIndices.add(i);
        if (i > 0) protectedIndices.add(i - 1);
        break;
      }
    }
  }
  protectedIndices.add(messages.length - 1);
  if (messages.at(-1)?.role === "tool") protectedIndices.add(messages.length - 2);
  for (let i = 0; i < messages.length; i++) {
    if (protectedIndices.has(i) || messages[i].role === "tool") continue;
    let end = i + 1;
    while (end < messages.length && messages[end].role === "tool") end++;
    if (Array.from({ length: end - i }, (_, offset) => i + offset).some((index) => protectedIndices.has(index))) continue;
    return [...messages.slice(0, i), ...messages.slice(end)];
  }
  return undefined;
}

function contextError() {
  return Object.assign(new Error("The local model context cannot fit the task, required menu/cart evidence, and output reserve"), { code: "INFERENCE_CONTEXT_OVERFLOW" });
}

export async function runLiteRtConversation(engine, request, { contextTokens, signal, setConversation, onChunk } = {}) {
  const maxOutputTokens = Math.max(64, Math.min(LITERT_MAX_OUTPUT_TOKENS, Number(request.options?.maxTokens) || LITERT_MAX_OUTPUT_TOKENS));
  const temperature = Number(request.options?.temperature);
  let messages = toLiteRtMessages(request.messages);
  const policy = liteRtToolPolicy(request);
  if (policy.instruction) {
    const index = messages.findIndex((message) => message.role === "system");
    if (index < 0) messages.unshift({ role: "system", content: policy.instruction });
    else messages[index] = { ...messages[index], content: `${messageText(messages[index])}\n\n${policy.instruction}` };
  }
  let conversation;
  let prefaceTokens;
  const checkCancelled = () => { if (signal?.aborted) throw signal.reason; };
  try {
    // SDK 0.15 has no tokenize-only API. Measure the actual prefilled preface,
    // then conservatively reserve one token per UTF-8 byte of the last message,
    // plus template overhead and the requested output allowance.
    for (;;) {
      checkCancelled();
      try {
        conversation = await engine.createConversation({
          preface: { messages: messages.slice(0, -1), tools: policy.tools, extra_context: { enable_thinking: request.options?.thinkingEnabled === true } },
          sessionConfig: { maxOutputTokens, samplerParams: { temperature: Math.max(0, Math.min(2, Number.isFinite(temperature) ? temperature : 0.2)) } },
          enableConstrainedDecoding: Boolean(policy.tools.length), prefillPrefaceOnInit: true,
        });
        setConversation?.(conversation);
        checkCancelled();
        prefaceTokens = await conversation.getTokenCount();
        const lastMessageReserve = new TextEncoder().encode(JSON.stringify(messages.at(-1))).length + 256;
        if (prefaceTokens + lastMessageReserve + maxOutputTokens <= contextTokens) break;
      } catch (error) {
        checkCancelled();
        if (!/too many tokens|context.*(?:full|length|limit)|token.*limit/i.test(error?.message || "")) throw error;
      }
      if (conversation) { await conversation.delete(); conversation = undefined; setConversation?.(undefined); }
      const trimmed = trimOldestExchange(messages);
      if (!trimmed) throw contextError();
      messages = trimmed;
    }
    checkCancelled();
    let response;
    if (request.stream) {
      let text = "";
      const toolCalls = new Map();
      const reader = conversation.sendMessageStreaming(messages.at(-1)).getReader();
      let complete = false;
      try {
        for (;;) {
          checkCancelled();
          const { value, done } = await reader.read();
          if (done) { complete = true; break; }
          const chunk = messageText(value);
          text += chunk;
          for (const call of value.tool_calls || []) toolCalls.set(call.id || `${call.function?.name}:${JSON.stringify(call.function?.arguments)}`, call);
          if (chunk) await onChunk?.(chunk);
        }
        // History contains the completed call, including arguments assembled
        // across stream chunks. Never dispatch partial streamed arguments.
        const history = await conversation.getHistory();
        response = history.findLast((message) => message.role === "model") || { content: text, tool_calls: [...toolCalls.values()] };
      } finally { if (!complete) await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } else response = await conversation.sendMessage(messages.at(-1));
    checkCancelled();
    const allowedNames = new Set(policy.tools.map((tool) => tool.function?.name || tool.name));
    if ((response.tool_calls || []).some((call) => !allowedNames.has(call.function?.name))) throw Object.assign(new Error("Local model called a tool outside the current allowed tool set"), { code: "INFERENCE_INVALID_TOOL_CALL" });
    const { benchmark, usage, usageAvailable } = await liteRtUsage(conversation, response);
    const toolChoiceSatisfied = !policy.required || Boolean(response.tool_calls?.length);
    return {
      content: messageText(response),
      toolCalls: (response.tool_calls || []).map((call) => ({ id: call.id || crypto.randomUUID(), name: call.function?.name || "", args: call.function?.arguments || {} })),
      finishReason: response.tool_calls?.length ? "tool_calls" : !toolChoiceSatisfied ? "missing_required_tool_call" : usage?.outputTokens >= maxOutputTokens ? "length" : "stop",
      ...(usage ? { usage } : {}),
      metrics: { ...(Number.isFinite(benchmark.lastDecodeTokensPerSecond) ? { decodeTokensPerSecond: benchmark.lastDecodeTokensPerSecond } : {}), ...(Number.isFinite(benchmark.timeToFirstTokenInSecond) ? { timeToFirstTokenMs: benchmark.timeToFirstTokenInSecond * 1000 } : {}), usageAvailable: usageAvailable ? 1 : 0, toolChoiceSatisfied: toolChoiceSatisfied ? 1 : 0, contextTokens, thinkingEnabled: request.options?.thinkingEnabled === true ? 1 : 0 },
    };
  } finally {
    setConversation?.(undefined);
    if (conversation) await conversation.delete().catch(() => {});
  }
}

export function createInferenceDeadline(deadline) {
  const controller = new AbortController();
  const cancel = (code = "INFERENCE_CANCELLED") => controller.abort(Object.assign(new Error(code === "INFERENCE_TIMEOUT" ? "Browser inference deadline expired" : "Browser inference was cancelled"), { code }));
  const remaining = deadline - Date.now();
  const timer = remaining > 0 ? setTimeout(() => cancel("INFERENCE_TIMEOUT"), remaining) : undefined;
  if (remaining <= 0) cancel("INFERENCE_TIMEOUT");
  return { signal: controller.signal, cancel, dispose: () => clearTimeout(timer) };
}
