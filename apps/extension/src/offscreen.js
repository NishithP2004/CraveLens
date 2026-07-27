import { FilesetResolver, LlmInference } from "@mediapipe/tasks-genai";

let worker;
const pending = new Map();
let nextId = 0;
let vlmPromise;

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const operation = message.type === "CRAVELENS_OFFSCREEN_DETECT"
    ? runDetection(message)
    : message.type === "CRAVELENS_OFFSCREEN_VERIFY"
      ? runLocalVerification(message)
      : undefined;
  if (!operation) return;
  operation.then((result) => respond({ ok: true, ...result })).catch((error) => {
    console.error("[CraveLens] Offscreen model operation failed:", error);
    respond({ ok: false, error: error.message });
  });
  return true;
});

async function getVlm(modelUrl) {
  if (!navigator.gpu) throw new Error("Gemma 3n requires WebGPU. Enable WebGPU in Chrome and restart the browser.");
  if (!vlmPromise) {
    vlmPromise = FilesetResolver.forGenAiTasks(chrome.runtime.getURL("genai-wasm"))
      .then((fileset) => LlmInference.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelUrl },
        // Gemma 3n encodes one image as roughly 256 tokens. Leave enough room
        // for the instruction and structured JSON response as maxTokens covers
        // both prompt and generated tokens.
        maxTokens: 1_536,
        topK: 1,
        temperature: 0.2,
        randomSeed: 7,
        maxNumImages: 1,
      }))
      .catch((error) => { vlmPromise = undefined; throw error; });
  }
  return vlmPromise;
}

async function runLocalVerification({ imageDataUrl, videoTitle, frameTimestamp, transcriptContext, modelUrl }) {
  const bitmap = await createImageBitmap(await (await fetch(imageDataUrl)).blob());
  const startedAt = performance.now();
  try {
    console.info("[CraveLens] Gemma 3n inference requested", { videoTitle: String(videoTitle || "YouTube video") });
    const vlm = await getVlm(modelUrl);
    console.info("[CraveLens] Gemma 3n model ready; generating response");
    const prompt = [
      "<start_of_turn>user\n",
      "Inspect this video frame. Base the food identification primarily on the actual pixels in the supplied frame. Do not assume, copy, or infer a dish merely because it appears in the video title. Treat the title and transcript only as weak supporting context, and ignore them whenever they are unsupported by or conflict with the visible frame. If the frame is ambiguous, lower confidence or return isFood=false instead of guessing from the title. Return only minified JSON with keys isFood (boolean), dish (specific dish name), description (string), cuisine (string), ingredients (string array), confidence (number 0 to 1), and context (ready_to_eat, recipe, or restaurant_experience). Make description a precise, detailed visual account of the main detected food item in 2 to 4 concise sentences: cover the visible base, protein or filling, sauce or broth, toppings and garnishes, cooking style or texture, presentation, and distinguishing characteristics when observable. Clearly separate what is visibly supported from what is only likely, and never invent hidden ingredients. Use a generic dish name only when the pixels do not support a more specific identification. Be conservative and identify only the main visible dish. Video title (weak context only): ",
      String(videoTitle || "YouTube video"),
      "\nThe following YouTube transcript excerpts surround the exact frame timestamp. Use them only as weak supporting context; the visible frame is authoritative.\n",
      formatTranscriptContext(transcriptContext || (Number.isFinite(frameTimestamp)
        ? { timestamp: frameTimestamp, before: [], at: [], after: [] }
        : undefined)),
      "\nFrame: ",
      { imageSource: bitmap },
      "<end_of_turn>\n<start_of_turn>model\n",
    ];
    const response = await vlm.generateResponse(prompt);
    return { verification: parseVerification(response), vlmInferenceMs: Math.round(performance.now() - startedAt), rawResponse: response };
  } finally {
    bitmap.close();
  }
}

function parseVerification(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Gemma 3n did not return a JSON object");
  const value = JSON.parse(match[0]);
  console.info("[CraveLens] Gemma 3n JSON output:", JSON.stringify(value));
  const contexts = new Set(["ready_to_eat", "recipe", "restaurant_experience"]);
  if (typeof value.isFood !== "boolean" || typeof value.dish !== "string" || !contexts.has(value.context)) throw new Error("Gemma 3n returned an invalid food result");
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

async function runDetection({ imageDataUrl, threshold }) {
  const yolo = getWorker();
  const bitmap = await createImageBitmap(await (await fetch(imageDataUrl)).blob());
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
