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
  operation.then((result) => respond({ ok: true, ...result })).catch((error) => respond({ ok: false, error: error.message }));
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
        maxTokens: 768,
        topK: 1,
        temperature: 0.2,
        randomSeed: 7,
        maxNumImages: 1,
      }))
      .catch((error) => { vlmPromise = undefined; throw error; });
  }
  return vlmPromise;
}

async function runLocalVerification({ imageDataUrl, videoTitle, modelUrl }) {
  const bitmap = await createImageBitmap(await (await fetch(imageDataUrl)).blob());
  const startedAt = performance.now();
  try {
    const vlm = await getVlm(modelUrl);
    const prompt = [
      "<start_of_turn>user\n",
      "Inspect this video frame. Return only minified JSON with keys isFood (boolean), dish (string), cuisine (string), ingredients (string array), confidence (number 0 to 1), and context (ready_to_eat, recipe, or restaurant_experience). Be conservative and identify only the main visible dish. Video title: ",
      String(videoTitle || "YouTube video"),
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
  const contexts = new Set(["ready_to_eat", "recipe", "restaurant_experience"]);
  if (typeof value.isFood !== "boolean" || typeof value.dish !== "string" || !contexts.has(value.context)) throw new Error("Gemma 3n returned an invalid food result");
  return {
    isFood: value.isFood,
    dish: value.dish,
    cuisine: typeof value.cuisine === "string" ? value.cuisine : "unknown",
    ingredients: Array.isArray(value.ingredients) ? value.ingredients.filter((item) => typeof item === "string").slice(0, 20) : [],
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    context: value.context,
  };
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
