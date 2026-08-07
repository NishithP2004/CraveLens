# Local Gemma models

This directory is intentionally optional for the current local-AI flow. The
extension downloads the active browser models itself unless a server-installed
VLM path is explicitly re-enabled later.

- LiteRT-LM text and tool orchestration models are downloaded directly to the
  extension's browser cache after the user selects and saves one in Settings:
  Gemma 4 E2B (1.9 GB), E4B (2.8 GB), 12B (5.6 GB), 26B A4B (14.7 GB), and
  31B (17.9 GB). The extension uses a fixed allowlist of Hugging Face URLs;
  the model bytes are not proxied through CraveLens.
- `gemma-4-E2B-it-web.task` — MediaPipe vision verification, temporarily hidden
  from Settings while browser-downloadable VLMs are preferred.
- `gemma-4-E4B-it-web.task` — optional, larger MediaPipe vision artifact for
  the Gemma 4 E4B VLM setting, temporarily hidden from Settings.
- Gemma 3n VLM does not need a file in this directory. The extension downloads
  `gemma-3n-E2B-it-int4-Web.litertlm` directly from
  `google/gemma-3n-E2B-it-litert-lm` into browser Cache Storage when selected.

Download source:
https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm

The E4B text model is available from:
https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm

E4B VLM support requires a MediaPipe-compatible `.task` artifact; LiteRT-LM's
web text runtime alone cannot accept image input.

When re-enabled, Gemma 4 vision artifacts are served only from the local
CraveLens Node server and inference runs inside the Chrome extension through
MediaPipe WebGPU.
