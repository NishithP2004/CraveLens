export const LITERT_TEXT_MODELS = [
  { id: "gemma-4-E2B-it-web", name: "Gemma 4 E2B", size: "1.9 GB", url: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm" },
  { id: "gemma-4-E4B-it-web", name: "Gemma 4 E4B", size: "2.8 GB", url: "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm" },
  { id: "gemma-4-12B-it-web", name: "Gemma 4 12B", size: "5.6 GB", url: "https://huggingface.co/litert-community/gemma-4-12B-it-litert-lm/resolve/main/gemma-4-12B-it-web.litertlm" },
  { id: "gemma-4-26B-A4B-it-web", name: "Gemma 4 26B A4B", size: "14.7 GB", url: "https://huggingface.co/litert-community/gemma-4-26B-A4B-it-litert-lm/resolve/main/gemma-4-26B-A4B-it-web.litertlm" },
  { id: "gemma-4-31B-it-web", name: "Gemma 4 31B", size: "17.9 GB", url: "https://huggingface.co/litert-community/gemma-4-31B-it-litert-lm/resolve/main/gemma-4-31B-it-web.litertlm" },
];

export const LITERT_VLM_MODELS = [
  {
    id: "gemma-3n-E2B-it-int4-Web",
    provider: "litert-gemma3n",
    name: "Gemma 3n E2B",
    size: "3.04 GB",
    file: "gemma-3n-E2B-it-int4-Web.litertlm",
    url: "https://huggingface.co/google/gemma-3n-E2B-it-litert-lm/resolve/main/gemma-3n-E2B-it-int4-Web.litertlm",
  },
];

export const LITERT_MODELS = [...LITERT_TEXT_MODELS, ...LITERT_VLM_MODELS];

export function getLiteRtTextModel(modelId) {
  return LITERT_TEXT_MODELS.find((model) => model.id === modelId) || LITERT_TEXT_MODELS[0];
}

export function getLiteRtTextModelByUrl(url) {
  return LITERT_TEXT_MODELS.find((model) => model.url === url) || LITERT_TEXT_MODELS[0];
}

export function getLiteRtVlmModelByProvider(provider) {
  return LITERT_VLM_MODELS.find((model) => model.provider === provider);
}

export function getLiteRtModel(modelId) {
  return LITERT_MODELS.find((model) => model.id === modelId) || getLiteRtTextModel(modelId);
}

export function getLiteRtModelByUrl(url) {
  return LITERT_MODELS.find((model) => model.url === url) || { id: String(url || "model"), name: "LiteRT model", size: "", url };
}
