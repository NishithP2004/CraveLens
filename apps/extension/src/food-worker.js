import { loadAndCompile, loadLiteRt, Tensor } from "@litertjs/core";

const LABELS = ["healthy_food", "not_food", "unhealthy_food"];
const INPUT_SHAPE = [1, 224, 224, 3];
let modelPromise;
let runtimePromise;

function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = loadLiteRt(new URL("litert-wasm/", self.location.href).href).catch((error) => {
      runtimePromise = undefined;
      throw error;
    });
  }
  return runtimePromise;
}

function getModel() {
  if (!modelPromise) {
    self.postMessage({ type: "status", status: "loading" });
    modelPromise = getRuntime()
      .then(loadFixedBatchModel)
      .then((model) => { self.postMessage({ type: "status", status: "ready" }); return model; });
  }
  return modelPromise;
}

async function loadFixedBatchModel() {
  const response = await fetch(new URL("models/food-classifier/model.tflite", self.location.href));
  if (!response.ok) throw new Error(`Unable to load food model (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let patchedSignatures = 0;

  // This model exports a dynamic batch signature (-1, 224, 224, 3), while
  // LiteRT.js currently compares input shapes literally instead of treating
  // -1 as a wildcard. CraveLens always performs single-frame inference, so
  // specialize only that exact signature to batch size 1 in the loaded copy.
  for (let offset = 0; offset <= bytes.byteLength - 16; offset += 4) {
    if (view.getInt32(offset, true) === -1
      && view.getInt32(offset + 4, true) === 224
      && view.getInt32(offset + 8, true) === 224
      && view.getInt32(offset + 12, true) === 3) {
      view.setInt32(offset, 1, true);
      patchedSignatures += 1;
    }
  }
  if (!patchedSignatures) throw new Error("Food model input signature was not found");
  return loadAndCompile(bytes, { accelerator: "wasm" });
}

self.onmessage = async ({ data }) => {
  if (data.type !== "detect") return;
  const startedAt = performance.now();
  let input;
  let results;
  try {
    const model = await getModel();
    input = new Tensor(new Float32Array(data.pixels), INPUT_SHAPE);
    results = await model.run(input);
    const probabilities = normalizeProbabilities([...results[0].toTypedArray()]);
    const classes = probabilities.map((score, index) => ({ label: LABELS[index], score })).sort((a, b) => b.score - a.score);
    const foodScore = probabilities[0] + probabilities[2];
    const topFood = probabilities[0] >= probabilities[2] ? classes.find((item) => item.label === "healthy_food") : classes.find((item) => item.label === "unhealthy_food");
    const detections = foodScore >= data.threshold ? [{ label: topFood.label, score: foodScore }] : [];
    self.postMessage({ id: data.id, ok: true, detections, allDetections: classes, inferenceMs: Math.round(performance.now() - startedAt), foodScore });
  } catch (error) {
    modelPromise = undefined;
    self.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    input?.delete();
    if (results) for (const tensor of results) tensor.delete();
  }
};

function normalizeProbabilities(values) {
  const sum = values.reduce((total, value) => total + value, 0);
  if (values.every((value) => value >= 0 && value <= 1) && Math.abs(sum - 1) < .05) return values;
  const max = Math.max(...values); const exponents = values.map((value) => Math.exp(value - max)); const denominator = exponents.reduce((a, b) => a + b, 0);
  return exponents.map((value) => value / denominator);
}
