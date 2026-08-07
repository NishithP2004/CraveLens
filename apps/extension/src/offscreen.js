import { FilesetResolver, LlmInference } from "@mediapipe/tasks-genai";
import { Engine, loadLiteRtLm } from "@litert-lm/core";
import { buildOllamaChatPayload, DEFAULT_LOCAL_CONTEXT_TOKENS, normalizeContextTokens } from "./ollama-chat.js";
import { getLiteRtModel, getLiteRtModelByUrl, getLiteRtTextModel } from "./litert-models.js";

let worker;
const pending = new Map();
let nextId = 0;
const vlmPromises = new Map();
const textEngines = new Map();
const activeConversations = new Map();
const activeLiteRtDownloads = new Map();
let liteRtLmRuntime;
const VLM_CONTEXT_TOKENS = 2_048;
const VLM_OUTPUT_RESERVE_TOKENS = 384;
const LITERT_MAX_OUTPUT_TOKENS = 1_536;

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "CRAVELENS_OFFSCREEN_CANCEL") {
    const active = activeConversations.get(message.requestId);
    (active?.conversation || active)?.cancel?.();
    return;
  }
  if (message.type === "CRAVELENS_OFFSCREEN_CANCEL_LITERT_DOWNLOAD") {
    for (const [modelUrl, controller] of activeLiteRtDownloads) {
      if (getLiteRtModelByUrl(modelUrl).id !== message.modelId) continue;
      controller.abort();
    }
    return;
  }
  if (message.type === "CRAVELENS_OFFSCREEN_REMOVE_LITERT_MODEL") {
    removeCachedLiteRtModel(message.modelId).then((result) => respond({ ok: true, ...result })).catch((error) => {
      respond({ ok: false, error: error?.message || String(error) });
    });
    return true;
  }
  let operation;
  if (message.type === "CRAVELENS_OFFSCREEN_DETECT") operation = runDetection(message);
  else if (message.type === "CRAVELENS_OFFSCREEN_VERIFY") operation = runLocalVerification(message);
  else if (message.type === "CRAVELENS_OFFSCREEN_CHAT") operation = runChatInference(message.request);
  else if (message.type === "CRAVELENS_OFFSCREEN_PRELOAD_LITERT") operation = preloadLiteRtModel(message);
  else if (message.type === "CRAVELENS_OFFSCREEN_VERIFY_PRELOAD") operation = preloadLiteRtVlm(message);
  if (!operation) return;
  operation.then((result) => respond({ ok: true, ...result })).catch((error) => {
    console.error("[CraveLens] Offscreen model operation failed:", error);
    const normalized = normalizeInferenceError(error);
    respond({ ok: false, error: normalized.message, code: normalized.code });
  });
  return true;
});

async function getVlm(modelUrl, modelId) {
  if (!navigator.gpu) throw new Error("Local Gemma vision requires WebGPU. Enable WebGPU in Chrome and restart the browser.");
  if (!vlmPromises.has(modelUrl)) {
    const promise = Promise.all([
      FilesetResolver.forGenAiTasks(chrome.runtime.getURL("genai-wasm")),
      loadCachedLiteRtModel(modelUrl, modelId).then((stream) => stream.getReader()),
    ])
      .then(([fileset, modelAssetBuffer]) => LlmInference.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer },
        // Gemma 3n encodes one image as roughly 256 tokens. Leave enough room
        // for the instruction and structured JSON response as maxTokens covers
        // both prompt and generated tokens.
        maxTokens: VLM_CONTEXT_TOKENS,
        topK: 1,
        temperature: 0.2,
        randomSeed: 7,
        maxNumImages: 1,
      }))
      .catch((error) => { vlmPromises.delete(modelUrl); throw error; });
    vlmPromises.set(modelUrl, promise);
  }
  return vlmPromises.get(modelUrl);
}

async function runLocalVerification({ imageDataUrl, videoTitle, frameTimestamp, transcriptContext, modelUrl, provider = "litert-gemma3n", model, ollamaBaseUrl }) {
  if (provider === "ollama") return runOllamaVerification({ imageDataUrl, videoTitle, transcriptContext, model, ollamaBaseUrl });
  if (provider === "gemini-nano") return runGeminiNanoVerification({ imageDataUrl, videoTitle, transcriptContext });
  const bitmap = await createImageBitmap(dataUrlToBlob(imageDataUrl));
  const startedAt = performance.now();
  try {
    console.info("[CraveLens] Local VLM inference requested", { videoTitle: String(videoTitle || "YouTube video") });
    const vlm = await getVlm(modelUrl, model);
    console.info("[CraveLens] Local VLM ready; generating response");
    let prompt = visionPrompt({ bitmap, videoTitle, frameTimestamp, transcriptContext });
    let inputTokens = vlm.sizeInTokens(prompt);
    if (Number.isFinite(inputTokens) && inputTokens > VLM_CONTEXT_TOKENS - VLM_OUTPUT_RESERVE_TOKENS) {
      console.warn("[CraveLens] VLM context was compacted before inference", { inputTokens, contextTokens: VLM_CONTEXT_TOKENS });
      prompt = visionPrompt({ bitmap, videoTitle, frameTimestamp });
      inputTokens = vlm.sizeInTokens(prompt);
    }
    console.info("[CraveLens] Local VLM prompt prepared", { inputTokens, contextTokens: VLM_CONTEXT_TOKENS });
    const response = await vlm.generateResponse(prompt);
    return { verification: parseVerification(response), vlmInferenceMs: Math.round(performance.now() - startedAt), rawResponse: response };
  } finally {
    bitmap.close();
  }
}

async function runChatInference(request) {
  const startedAt = performance.now();
  if (request.provider === "ollama") return runOllamaChat(request, startedAt);
  if (!navigator.gpu) throw Object.assign(new Error("LiteRT Gemma 4 requires WebGPU"), { code: "INFERENCE_UNAVAILABLE" });
  liteRtLmRuntime ||= loadLiteRtLm(chrome.runtime.getURL("litertlm-wasm"));
  await liteRtLmRuntime;
  const modelUrl = request.modelUrl;
  if (!modelUrl) throw Object.assign(new Error("LiteRT Gemma 4 model URL was not supplied by the extension service worker"), { code: "INFERENCE_UNAVAILABLE" });
  const contextTokens = normalizeContextTokens(request.options?.contextTokens || DEFAULT_LOCAL_CONTEXT_TOKENS);
  const engine = await getLiteRtEngine(modelUrl, contextTokens, request.model);
  const messages = request.messages.map(toLiteRtMessage);
  const last = messages.at(-1);
  const tools = request.tools || [];
  const maxOutputTokens = Math.max(64, Math.min(LITERT_MAX_OUTPUT_TOKENS, Number(request.options?.maxTokens) || LITERT_MAX_OUTPUT_TOKENS));
  const requestedTemperature = Number(request.options?.temperature);
  const conversation = await engine.createConversation({
    preface: {
      messages: messages.slice(0, -1),
      tools,
      ...(request.options?.thinkingEnabled === true ? { extra_context: { enable_thinking: true } } : {}),
    },
    sessionConfig: {
      maxOutputTokens,
      samplerParams: { temperature: Math.max(0, Math.min(2, Number.isFinite(requestedTemperature) ? requestedTemperature : 0.2)) },
    },
    enableConstrainedDecoding: tools.length > 0,
    prefillPrefaceOnInit: true,
  });
  activeConversations.set(request.requestId, { conversation, modelUrl });
  try {
    const inputTokens = await conversation.getTokenCount().catch(() => 0);
    let response;
    let streamedContent = "";
    if (request.stream) {
      const reader = conversation.sendMessageStreaming(last).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        response = value;
        const content = messageText(value);
        if (content) {
          streamedContent += content;
          await chrome.runtime.sendMessage({ type: "CRAVELENS_INFERENCE_CHUNK", requestId: request.requestId, content });
        }
      }
      response ||= { role: "model", content: streamedContent };
    } else response = await conversation.sendMessage(last);
    const outputTokens = Math.max(0, (await conversation.getTokenCount().catch(() => inputTokens)) - inputTokens);
    return {
      result: {
        version: 1, requestId: request.requestId, content: messageText(response), toolCalls: normalizeLiteRtToolCalls(response.tool_calls), finishReason: response.tool_calls?.length ? "tool_calls" : "stop",
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        metrics: { totalMs: Math.round(performance.now() - startedAt), streamed: request.stream ? 1 : 0, contextTokens, thinkingEnabled: request.options?.thinkingEnabled === true ? 1 : 0 },
      },
    };
  } finally { activeConversations.delete(request.requestId); await conversation.delete().catch(() => {}); }
}

async function preloadLiteRtModel({ modelId, modelUrl, contextTokens }) {
  if (!navigator.gpu) throw Object.assign(new Error("LiteRT Gemma 4 requires WebGPU"), { code: "INFERENCE_UNAVAILABLE" });
  liteRtLmRuntime ||= loadLiteRtLm(chrome.runtime.getURL("litertlm-wasm"));
  await liteRtLmRuntime;
  await getLiteRtEngine(modelUrl, normalizeContextTokens(contextTokens || DEFAULT_LOCAL_CONTEXT_TOKENS), modelId);
  return { preloaded: true };
}

async function preloadLiteRtVlm({ modelId, modelUrl }) {
  await getVlm(modelUrl, modelId);
  return { preloaded: true };
}

async function getLiteRtEngine(modelUrl, contextTokens, modelId) {
  const engineKey = `${modelUrl}#ctx=${contextTokens}`;
  let enginePromise = textEngines.get(engineKey);
  if (!enginePromise) {
    enginePromise = loadCachedLiteRtModel(modelUrl, modelId)
      .then((model) => Engine.create({ model, mainExecutorSettings: { maxNumTokens: contextTokens } }))
      .then((engine) => {
        publishLiteRtDownloadStatus(modelUrl, { state: "ready", downloadedBytes: 0, totalBytes: 0 });
        return engine;
      })
      .catch((error) => {
        textEngines.delete(engineKey);
        publishLiteRtDownloadStatus(modelUrl, { state: error?.name === "AbortError" ? "cancelled" : "error", error: error?.message || String(error) });
        throw error;
      });
    textEngines.set(engineKey, enginePromise);
  }
  return enginePromise;
}

async function loadCachedLiteRtModel(modelUrl, modelId) {
  const cache = await caches.open("cravelens-litert-models-v1");
  const cached = await cache.match(modelUrl);
  if (cached?.body) {
    publishLiteRtDownloadStatus(modelUrl, { modelId, state: "cached", downloadedBytes: Number(cached.headers.get("content-length")) || 0, totalBytes: Number(cached.headers.get("content-length")) || 0 });
    return cached.body;
  }
  const controller = new AbortController();
  activeLiteRtDownloads.set(modelUrl, controller);
  const startedAt = Date.now();
  publishLiteRtDownloadStatus(modelUrl, { modelId, state: "downloading", downloadedBytes: 0, totalBytes: 0, startedAt });
  let response;
  try { response = await fetch(modelUrl, { signal: controller.signal }); }
  catch (error) { activeLiteRtDownloads.delete(modelUrl); throw error; }
  if (!response.ok || !response.body) {
    activeLiteRtDownloads.delete(modelUrl);
    throw Object.assign(new Error(`Unable to download LiteRT model (${response.status})`), { code: "INFERENCE_UNAVAILABLE" });
  }
  const totalBytes = Number(response.headers.get("content-length")) || 0;
  let downloadedBytes = 0;
  const stream = withDownloadProgress(response.body, (chunkLength) => {
    downloadedBytes += chunkLength;
    publishLiteRtDownloadStatus(modelUrl, { modelId, state: "downloading", downloadedBytes, totalBytes, startedAt });
  }, () => activeLiteRtDownloads.delete(modelUrl));
  const [modelStream, cacheStream] = stream.tee();
  const headers = new Headers();
  const contentLength = response.headers.get("content-length");
  if (contentLength) headers.set("content-length", contentLength);
  headers.set("content-type", "application/octet-stream");
  void cache.put(modelUrl, new Response(cacheStream, { headers })).catch((error) => console.warn("[CraveLens] LiteRT model cache write failed", error));
  return modelStream;
}

async function removeCachedLiteRtModel(modelId) {
  const target = getLiteRtModel(modelId);
  if (target.id !== modelId) throw new Error("Unknown LiteRT model");
  if ([...activeLiteRtDownloads].some(([url]) => getLiteRtModelByUrl(url).id === target.id)) {
    throw new Error("This model is still downloading. Cancel the download before removing it.");
  }
  if ([...activeConversations.values()].some((conversation) => conversation.modelUrl === target.url)) {
    throw new Error("This model is currently generating. Try again when the cart run finishes.");
  }
  const engineEntries = [...textEngines.entries()].filter(([key]) => key.startsWith(`${target.url}#`));
  for (const [key, enginePromise] of engineEntries) {
    const engine = await enginePromise.catch(() => undefined);
    await engine?.delete?.().catch(() => {});
    textEngines.delete(key);
  }
  const vlm = await vlmPromises.get(target.url)?.catch(() => undefined);
  vlm?.close?.();
  vlmPromises.delete(target.url);
  const cache = await caches.open("cravelens-litert-models-v1");
  const removed = await cache.delete(target.url);
  publishLiteRtDownloadStatus(target.url, { state: "removed", downloadedBytes: 0, totalBytes: 0 });
  return { removed, modelId: target.id, modelName: target.name, modelSize: target.size };
}

function withDownloadProgress(stream, onChunk, onComplete) {
  const reader = stream.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          onComplete();
          controller.close();
          return;
        }
        onChunk(value.byteLength);
        controller.enqueue(value);
      } catch (error) {
        onComplete();
        controller.error(error);
      }
    },
    cancel(reason) {
      onComplete();
      return reader.cancel(reason);
    },
  });
}

function publishLiteRtDownloadStatus(modelUrl, update) {
  const model = getLiteRtModelByUrl(modelUrl);
  chrome.runtime.sendMessage({
    type: "CRAVELENS_LITERT_DOWNLOAD_STATUS",
    state: { modelId: model.id, modelName: model.name, modelSize: model.size, updatedAt: Date.now(), ...update },
  }).catch(() => {});
}

async function runOllamaChat(request, startedAt = performance.now()) {
  const controller = new AbortController();
  activeConversations.set(request.requestId, { cancel: () => controller.abort() });
  try {
    const response = await fetch(ollamaApiUrl(request.ollamaBaseUrl, "/api/chat"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildOllamaChatPayload(request)), signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim().slice(0, 500);
      throw Object.assign(new Error(`Ollama request failed (${response.status})${detail ? `: ${detail}` : ""}`), { code: "INFERENCE_FAILED" });
    }
    const value = await response.json();
    if (value.done_reason === "length" && !value.message?.tool_calls?.length) {
      throw Object.assign(new Error("Ollama exhausted its generation allowance before producing a tool call"), { code: "INFERENCE_CONTEXT_OVERFLOW" });
    }
    return { result: { version: 1, requestId: request.requestId, content: value.message?.content || "", toolCalls: (value.message?.tool_calls || []).map((call) => ({ id: call.id || crypto.randomUUID(), name: call.function?.name || "", args: call.function?.arguments || {} })), finishReason: value.done_reason || "stop", usage: { inputTokens: value.prompt_eval_count || 0, outputTokens: value.eval_count || 0, totalTokens: (value.prompt_eval_count || 0) + (value.eval_count || 0) }, metrics: { totalMs: Math.round(performance.now() - startedAt), loadMs: Math.round((value.load_duration || 0) / 1e6), decodeTokensPerSecond: value.eval_duration ? value.eval_count / (value.eval_duration / 1e9) : 0, contextTokens: normalizeContextTokens(request.options?.contextTokens), thinkingEnabled: request.options?.thinkingEnabled === true ? 1 : 0 } } };
  } catch (error) {
    if (error instanceof TypeError && /fetch/i.test(error.message)) {
      throw Object.assign(new Error("Ollama could not be reached from the extension. Check the host and its OLLAMA_ORIGINS entry."), { code: "INFERENCE_UNAVAILABLE", cause: error });
    }
    throw error;
  } finally { activeConversations.delete(request.requestId); }
}

async function runOllamaVerification({ imageDataUrl, videoTitle, transcriptContext, model = "gemma3:4b", ollamaBaseUrl }) {
  const base64 = String(imageDataUrl).replace(/^data:[^;]+;base64,/, "");
  const prompt = verificationInstruction(videoTitle, transcriptContext);
  const response = await fetch(ollamaApiUrl(ollamaBaseUrl, "/api/chat"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: false, format: "json", messages: [{ role: "user", content: prompt, images: [base64] }] }) });
  if (!response.ok) throw new Error(`Ollama vision request failed (${response.status})`);
  const value = await response.json();
  return { verification: parseVerification(value.message?.content || ""), vlmInferenceMs: Math.round((value.total_duration || 0) / 1e6), rawResponse: value.message?.content || "" };
}

function ollamaApiUrl(value, path) {
  const url = new URL(String(value || "http://localhost:11434"));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid Ollama host configuration");
  return new URL(path, `${url.origin}/`).toString();
}

async function runGeminiNanoVerification({ imageDataUrl, videoTitle, transcriptContext }) {
  if (!globalThis.LanguageModel?.create) throw new Error("Gemini Nano with image input is not available in this Chrome installation.");
  const sessionOptions = {
    expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
  };
  const availability = await globalThis.LanguageModel.availability?.(sessionOptions);
  if (availability === "unavailable") throw new Error("Gemini Nano is enabled but does not expose the required image modality.");
  const session = await globalThis.LanguageModel.create(sessionOptions);
  const blob = dataUrlToBlob(imageDataUrl);
  const startedAt = performance.now();
  try {
    const response = await session.prompt([{ role: "user", content: [{ type: "text", value: verificationInstruction(videoTitle, transcriptContext) }, { type: "image", value: blob }] }]);
    return { verification: parseVerification(response), vlmInferenceMs: Math.round(performance.now() - startedAt), rawResponse: response };
  } finally { session.destroy?.(); }
}

function verificationInstruction(videoTitle, transcriptContext) {
  return `Inspect the image. Pixels are authoritative; title and transcript are weak hints. Return only minified JSON: {"isFood":boolean,"dish":string,"description":string,"cuisine":string,"ingredients":string[],"confidence":number,"context":"ready_to_eat"|"recipe"|"restaurant_experience"}. Be conservative; never invent hidden ingredients. Title: ${String(videoTitle || "YouTube video").slice(0, 240)}\n${compactTranscriptText(transcriptContext)}`;
}

function visionPrompt({ bitmap, videoTitle, frameTimestamp, transcriptContext }) {
  const context = transcriptContext || (Number.isFinite(frameTimestamp)
    ? { timestamp: frameTimestamp, before: [], at: [], after: [] }
    : undefined);
  return [
    "<start_of_turn>user\n",
    verificationInstruction(videoTitle, context),
    "\nDescribe only visually supported details. Frame: ",
    { imageSource: bitmap },
    "<end_of_turn>\n<start_of_turn>model\n",
  ];
}

function compactTranscriptText(context) {
  const formatted = formatTranscriptContext(context);
  return formatted.length <= 700 ? formatted : `${formatted.slice(0, 697)}...`;
}

function normalizeInferenceError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/too many tokens|context.*(?:full|length|limit)|token.*limit/i.test(message)) {
    return { message: "The local model context exceeded its token budget", code: "INFERENCE_CONTEXT_OVERFLOW" };
  }
  if (/invalid token at state/i.test(message)) {
    return { message: "LiteRT constrained decoding could not produce a valid next token", code: "INFERENCE_DECODING_FAILED" };
  }
  return { message, code: error?.code || "INFERENCE_FAILED" };
}

function toLiteRtMessage(message) {
  if (message.role === "tool") {
    const toon = typeof message.content === "string" && message.content.startsWith("TOON\n");
    return { role: "tool", content: [{ type: "tool_response", name: message.name || message.toolCallId, response: toon ? message.content : typeof message.content === "string" ? safeJson(message.content) : message.content }] };
  }
  return { role: message.role === "assistant" ? "model" : message.role, content: message.content, ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({ type: "function", id: call.id, function: { name: call.name, arguments: call.args } })) } : {}) };
}

function messageText(message) { return typeof message?.content === "string" ? message.content : (message?.content || []).filter((part) => part.type === "text").map((part) => part.text).join(""); }
function normalizeLiteRtToolCalls(calls = []) { return calls.map((call) => ({ id: call.id || crypto.randomUUID(), name: call.function?.name || "", args: call.function?.arguments || {} })); }
function safeJson(value) { try { return JSON.parse(value); } catch { return { content: value }; } }

function parseVerification(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) throw new Error("The configured VLM did not return a JSON object");
  const value = JSON.parse(match[0]);
  console.info("[CraveLens] VLM JSON output:", JSON.stringify(value));
  const contexts = new Set(["ready_to_eat", "recipe", "restaurant_experience"]);
  if (typeof value.isFood !== "boolean" || typeof value.dish !== "string" || !contexts.has(value.context)) throw new Error("The configured VLM returned an invalid food result");
  return {
    isFood: value.isFood,
    dish: value.dish,
    description: typeof value.description === "string" ? value.description.trim().slice(0, 1200) : "",
    cuisine: typeof value.cuisine === "string" ? value.cuisine : "unknown",
    ingredients: Array.isArray(value.ingredients) ? value.ingredients.filter((item) => typeof item === "string").slice(0, 20) : [],
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    context: value.context,
  };
}

function formatTranscriptContext(context) {
  if (!context) return "No transcript context was available.";
  const render = (label, cues) => `${label}: ${cues.length
    ? cues.map((cue) => `[${formatTime(cue.start)}] ${cue.text}`).join(" ")
    : "(none)"}`;
  return [
    `Target timestamp: ${formatTime(context.timestamp)}`,
    render("Before", context.before || []),
    render("At", context.at || []),
    render("After", context.after || []),
  ].join("\n");
}

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function dataUrlToBlob(value) {
  const match = /^data:([^;,]+)?(?:;base64)?,([\s\S]*)$/.exec(String(value || ""));
  if (!match) throw new Error("The captured frame is not a valid image data URL");
  const [, mimeType = "application/octet-stream", encoded] = match;
  if (!String(value).slice(0, String(value).indexOf(",")).includes(";base64")) {
    return new Blob([decodeURIComponent(encoded)], { type: mimeType });
  }
  const decoded = atob(encoded);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function runDetection({ imageDataUrl, threshold }) {
  const yolo = getWorker();
  const bitmap = await createImageBitmap(dataUrlToBlob(imageDataUrl));
  const sourceWidth = bitmap.width; const sourceHeight = bitmap.height;
  const inputSize = 640;
  const canvas = new OffscreenCanvas(inputSize, inputSize);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const scale = Math.min(inputSize / bitmap.width, inputSize / bitmap.height);
  const width = Math.round(bitmap.width * scale); const height = Math.round(bitmap.height * scale);
  const x = Math.floor((inputSize - width) / 2); const y = Math.floor((inputSize - height) / 2);
  context.fillStyle = "rgb(114,114,114)"; context.fillRect(0, 0, inputSize, inputSize);
  context.drawImage(bitmap, x, y, width, height); bitmap.close();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const plane = inputSize * inputSize; const pixels = new Float32Array(plane * 3);
  for (let pixel = 0; pixel < plane; pixel += 1) {
    pixels[pixel] = image.data[pixel * 4] / 255;
    pixels[plane + pixel] = image.data[pixel * 4 + 1] / 255;
    pixels[plane * 2 + pixel] = image.data[pixel * 4 + 2] / 255;
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, transform: { scale, x, y, sourceWidth, sourceHeight } });
    yolo.postMessage({ type: "detect", id, pixels: pixels.buffer, threshold }, [pixels.buffer]);
  });
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(chrome.runtime.getURL("food-worker.js"), { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "status") return;
    const request = pending.get(data.id); if (!request) return;
    pending.delete(data.id);
    if (!data.ok) { request.reject(new Error(data.error)); return; }
    const { scale, x, y, sourceWidth, sourceHeight } = request.transform;
    const clamp = (value, maximum) => Math.max(0, Math.min(maximum, value));
    const normalize = (box) => ({
      ...box,
      x1: clamp((box.x1 - x) / scale, sourceWidth) / sourceWidth,
      y1: clamp((box.y1 - y) / scale, sourceHeight) / sourceHeight,
      x2: clamp((box.x2 - x) / scale, sourceWidth) / sourceWidth,
      y2: clamp((box.y2 - y) / scale, sourceHeight) / sourceHeight,
    });
    request.resolve({ ...data, detections: data.detections.map(normalize), allDetections: data.allDetections.map(normalize) });
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "YOLO worker failed");
    for (const request of pending.values()) request.reject(error);
    pending.clear(); worker = undefined;
  };
  return worker;
}
