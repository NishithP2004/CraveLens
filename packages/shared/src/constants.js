export const DEFAULT_SENSITIVITY = 0.38;
export const DEFAULT_SCAN_INTERVAL_MS = 4000;
export const ANDROID_DEFAULT_SCAN_INTERVAL_MS = 1000;
export const MIN_SCAN_INTERVAL_MS = 1000;
export const MAX_SCAN_INTERVAL_MS = 30000;
export const DEDUPE_DISTANCE = 0.11;
export const STATIC_SCENE_DISTANCE = 0.03;
export const NMS_IOU = 0.45;
export const MAX_DETECTIONS = 25;
export const YOLO_INPUT_SIZE = 640;
export const LETTERBOX_FILL = 114;
export const FOOD_CONFIDENCE_GATE = 0.65;
export const VLM_CONTEXT_TOKENS = 4096;
export const VLM_MAX_OUTPUT_TOKENS = 384;
export const LITERT_MAX_OUTPUT_TOKENS = 1536;
export const MIN_LOCAL_CONTEXT_TOKENS = 4_096;
export const DEFAULT_LOCAL_CONTEXT_TOKENS = 16_384;
export const MAX_LOCAL_CONTEXT_TOKENS = 32_768;
export const COMPACT_PROMPT_CONTEXT_TOKENS = 8_192;
export const LOCAL_TOOL_RESULT_CHARACTER_LIMIT = 4_500;
export const CHARACTER_PER_TOKEN = 3.2;
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_HOSTED_FALLBACK = "ask";
export const DEFAULT_CART_EXPERIENCE = "screen";
export const NUDGE_MIN_INTERVAL_MIN = 10;
export const NUDGE_MAX_PER_HOUR = 4;
export const WATCH_IDLE_TIMEOUT_MIN = 60;
export const VLM_MAX_PER_MIN = 6;
export const VLM_COOLDOWN_AFTER_CART_S = 120;
export const AGENT_NANO_TOKEN_LIMIT = 4000;
export const CART_LIMIT_INR = 1000;
export const INFERENCE_CODES = [
  "INFERENCE_UNAVAILABLE",
  "INFERENCE_OVERLOADED",
  "INFERENCE_CONTEXT_OVERFLOW",
  "INFERENCE_DECODING_FAILED",
  "INFERENCE_INVALID_TOOL_CALL",
  "INFERENCE_INVALID_HISTORY",
  "INFERENCE_TIMEOUT",
  "INFERENCE_CANCELLED",
  "INFERENCE_OFFLINE",
  "INFERENCE_FAILED",
];
export const FINISH_REASONS = ["tool_calls", "missing_required_tool_call", "length", "stop"];
export const HOSTED_FALLBACK_VALUES = ["auto", "ask", "none"];
export const CART_EXPERIENCE_VALUES = ["screen", "nudge", "telegram"];
export const THEME_MODES = ["system", "light", "dark"];
export const SHORTCUT_BEHAVIORS = ["auto-supported", "lasso-always"];

export function localRequestCharacterBudget({ contextTokens = DEFAULT_LOCAL_CONTEXT_TOKENS, maxTokens = LITERT_MAX_OUTPUT_TOKENS } = {}) {
  const inputTokens = Math.max(1, Number(contextTokens) - Number(maxTokens));
  return Math.max(1_200, Math.round(inputTokens * CHARACTER_PER_TOKEN));
}
