import assert from "node:assert/strict";
import test from "node:test";
import { LITERT_TEXT_MODELS, LITERT_VLM_MODELS, getLiteRtTextModel, getLiteRtVlmModelByProvider } from "./litert-models.js";

test("lists the LiteRT web-compatible Gemma 4 models with fixed Hugging Face sources", () => {
  assert.deepEqual(LITERT_TEXT_MODELS.map((model) => model.id), [
    "gemma-4-E2B-it-web",
    "gemma-4-E4B-it-web",
    "gemma-4-12B-it-web",
    "gemma-4-26B-A4B-it-web",
    "gemma-4-31B-it-web",
  ]);
  for (const model of LITERT_TEXT_MODELS) assert.match(model.url, /^https:\/\/huggingface\.co\/litert-community\//);
  assert.equal(getLiteRtTextModel("unknown").id, "gemma-4-E2B-it-web");
});

test("lists browser-downloadable LiteRT VLM models with fixed Hugging Face sources", () => {
  assert.deepEqual(LITERT_VLM_MODELS.map((model) => model.id), ["gemma-3n-E2B-it-int4-Web"]);
  assert.equal(getLiteRtVlmModelByProvider("litert-gemma3n").file, "gemma-3n-E2B-it-int4-Web.litertlm");
  for (const model of LITERT_VLM_MODELS) assert.match(model.url, /^https:\/\/huggingface\.co\/google\/gemma-3n-E2B-it-litert-lm\//);
});
