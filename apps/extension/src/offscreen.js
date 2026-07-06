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
  const canvas = new OffscreenCanvas(224, 224);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, 224, 224); bitmap.close();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = new Float32Array(224 * 224 * 3);
  for (let source = 0, target = 0; source < image.data.length; source += 4) {
    pixels[target++] = image.data[source]; pixels[target++] = image.data[source + 1]; pixels[target++] = image.data[source + 2];
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    yolo.postMessage({ type: "detect", id, pixels: pixels.buffer, threshold }, [pixels.buffer]);
  });
}

function getWorker() {
  if (worker) return worker;
  // LiteRT's generated WASM bootstrap loads its companion script with
  // importScripts(), which is only available to classic workers.
  worker = new Worker(chrome.runtime.getURL("food-worker.js"));
  worker.onmessage = ({ data }) => {
    if (data.type === "status") return;
    const request = pending.get(data.id); if (!request) return;
    pending.delete(data.id); data.ok ? request.resolve(data) : request.reject(new Error(data.error));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "YOLO worker failed");
    for (const request of pending.values()) request.reject(error);
    pending.clear(); worker = undefined;
  };
  return worker;
}
