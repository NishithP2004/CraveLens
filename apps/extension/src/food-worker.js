import * as ort from "onnxruntime-web";

const INPUT_SIZE = 640;
const MODEL_URL = new URL("models/food-detector/best_dynamic.onnx", self.location.href).href;
let sessionPromise;

function getSession() {
  if (!sessionPromise) {
    self.postMessage({ type: "status", status: "loading" });
    ort.env.wasm.numThreads = 1;
    sessionPromise = ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"], graphOptimizationLevel: "all" })
      .then((session) => { self.postMessage({ type: "status", status: "ready" }); return session; })
      .catch((error) => { sessionPromise = undefined; throw error; });
  }
  return sessionPromise;
}

self.onmessage = async ({ data }) => {
  if (data.type !== "detect") return;
  const startedAt = performance.now();
  try {
    const session = await getSession();
    const input = new ort.Tensor("float32", new Float32Array(data.pixels), [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const outputs = await session.run({ [session.inputNames[0]]: input });
    const detections = decodeOutput(outputs[session.outputNames[0]], Number(data.threshold) || .5);
    self.postMessage({ id: data.id, ok: true, detections, allDetections: detections.slice(0, 10), inferenceMs: Math.round(performance.now() - startedAt), foodScore: detections[0]?.score || 0 });
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

function decodeOutput(output, threshold) {
  const [batch, first, second] = output.dims;
  if (batch !== 1 || !first || !second) throw new Error(`Unexpected detector output shape: ${output.dims.join("×")}`);
  const channelFirst = first < second;
  const channels = channelFirst ? first : second;
  const count = channelFirst ? second : first;
  if (channels < 5) throw new Error(`Detector output has only ${channels} channels`);
  const get = (channel, index) => channelFirst ? output.data[channel * count + index] : output.data[index * channels + channel];
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    let classIndex = 0;
    let score = get(4, index);
    for (let channel = 5; channel < channels; channel += 1) {
      if (get(channel, index) > score) { score = get(channel, index); classIndex = channel - 4; }
    }
    if (score < threshold) continue;
    const cx = get(0, index); const cy = get(1, index); const width = get(2, index); const height = get(3, index);
    candidates.push({ label: classIndex ? `food_${classIndex + 1}` : "food", score, x1: cx - width / 2, y1: cy - height / 2, x2: cx + width / 2, y2: cy + height / 2 });
  }
  candidates.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const candidate of candidates) {
    if (kept.every((other) => intersectionOverUnion(candidate, other) < .45)) kept.push(candidate);
    if (kept.length >= 25) break;
  }
  return kept;
}

function intersectionOverUnion(a, b) {
  const intersection = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  return intersection / Math.max(areaA + areaB - intersection, Number.EPSILON);
}
