import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ANDROID_DEFAULT_SCAN_INTERVAL_MS,
  AGENT_NANO_TOKEN_LIMIT,
  AGENT_TOOL_LABELS,
  ANDROID_DISH_SUFFIX,
  CART_AGENT_RULE_MARKERS,
  CART_LIMIT_INR,
  CHARACTER_PER_TOKEN,
  COMPACT_PROMPT_CONTEXT_TOKENS,
  DEFAULT_CART_EXPERIENCE,
  DEFAULT_HOSTED_FALLBACK,
  DEFAULT_LOCAL_CONTEXT_TOKENS,
  DEFAULT_SCAN_INTERVAL_MS,
  DEFAULT_SENSITIVITY,
  DEDUPE_DISTANCE,
  FINISH_REASONS,
  FOOD_CONFIDENCE_GATE,
  HOSTED_FALLBACK_CONFIRM,
  HOSTED_FALLBACK_VALUES,
  INFERENCE_CODES,
  LITERT_MAX_OUTPUT_TOKENS,
  MAX_DETECTIONS,
  MAX_LOCAL_CONTEXT_TOKENS,
  MAX_SCAN_INTERVAL_MS,
  MIN_LOCAL_CONTEXT_TOKENS,
  MIN_SCAN_INTERVAL_MS,
  NMS_IOU,
  NUDGE_MAX_PER_HOUR,
  NUDGE_MIN_INTERVAL_MIN,
  STATIC_SCENE_DISTANCE,
  VLM_COOLDOWN_AFTER_CART_S,
  VLM_CONTEXT_TOKENS,
  VLM_MAX_OUTPUT_TOKENS,
  VLM_MAX_PER_MIN,
  WATCH_IDLE_TIMEOUT_MIN,
  YOLO_INPUT_SIZE,
  AgentFollowUpSchema,
  CartCustomizationSchema,
  CartMutationSchema,
  CouponSelectionSchema,
  DetectionSchema,
  FoodVerificationSchema,
  InferenceRequestSchema,
  InferenceResultSchema,
  ModelSettingsSchema,
  OrchestrateRequestSchema,
  PreferenceRequestSchema,
  agentEventMessage,
  androidFoodVerificationInstruction,
  cartAgentSystemPrompt,
  foodCravingIdentity,
  foodVerificationInstruction,
  toolPolicyInstruction,
} from "../packages/shared/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sharedDir = resolve(root, "apps/android/core/src/main/assets/shared");
const fixtureDir = resolve(root, "apps/android/tests/fixtures");
const xmlPath = resolve(root, "apps/android/app/src/main/res/xml/remote_config_defaults.xml");
const templatePath = resolve(root, "apps/android/firebase/remoteconfig.template.json");

const schemas = {
  FoodVerification: FoodVerificationSchema,
  OrchestrateRequest: OrchestrateRequestSchema,
  ModelSettings: ModelSettingsSchema,
  InferenceRequest: InferenceRequestSchema,
  InferenceResult: InferenceResultSchema,
  CartMutation: CartMutationSchema,
  CartCustomization: CartCustomizationSchema,
  AgentFollowUp: AgentFollowUpSchema,
  CouponSelection: CouponSelectionSchema,
  PreferenceRequest: PreferenceRequestSchema,
  Detection: DetectionSchema,
};

const sharedSchemas = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, zodToJsonSchema(schema, { name, $refStrategy: "none" })]));

const prompts = {
  foodVerificationInstruction: foodVerificationInstruction("Android screen", "No transcript context was available."),
  androidFoodVerificationInstruction: androidFoodVerificationInstruction(),
  androidDishSuffix: ANDROID_DISH_SUFFIX,
  cartAgentSystemPrompt: cartAgentSystemPrompt({ addressId: "{addressId}", addressSummary: "{addressSummary}" }),
  cartAgentSystemPromptCompact: cartAgentSystemPrompt({ addressId: "{addressId}", addressSummary: "{addressSummary}", compact: true }),
  cartAgentRuleMarkers: CART_AGENT_RULE_MARKERS,
  toolPolicy: {
    none: toolPolicyInstruction("none"),
    required: toolPolicyInstruction("required"),
    named: toolPolicyInstruction("required", "{name}").replace("required", "{name}").includes("{name}") ? `CURRENT TURN: Invoke exactly the {name} tool using its declared schema. Do not respond with prose.` : toolPolicyInstruction({ name: "example" }, "example"),
  },
  hostedFallbackConfirm: HOSTED_FALLBACK_CONFIRM,
};

prompts.toolPolicy = {
  none: toolPolicyInstruction("none"),
  required: toolPolicyInstruction("required"),
  named: "CURRENT TURN: Invoke exactly the {name} tool using its declared schema. Do not respond with prose.",
};

const constants = {
  DEFAULT_SENSITIVITY,
  DEFAULT_SCAN_INTERVAL_MS,
  ANDROID_DEFAULT_SCAN_INTERVAL_MS,
  MIN_SCAN_INTERVAL_MS,
  MAX_SCAN_INTERVAL_MS,
  DEDUPE_DISTANCE,
  STATIC_SCENE_DISTANCE,
  NMS_IOU,
  MAX_DETECTIONS,
  YOLO_INPUT_SIZE,
  FOOD_CONFIDENCE_GATE,
  VLM_CONTEXT_TOKENS,
  VLM_MAX_OUTPUT_TOKENS,
  LITERT_MAX_OUTPUT_TOKENS,
  MIN_LOCAL_CONTEXT_TOKENS,
  DEFAULT_LOCAL_CONTEXT_TOKENS,
  MAX_LOCAL_CONTEXT_TOKENS,
  COMPACT_PROMPT_CONTEXT_TOKENS,
  CHARACTER_PER_TOKEN,
  DEFAULT_HOSTED_FALLBACK,
  DEFAULT_CART_EXPERIENCE,
  NUDGE_MIN_INTERVAL_MIN,
  NUDGE_MAX_PER_HOUR,
  WATCH_IDLE_TIMEOUT_MIN,
  VLM_MAX_PER_MIN,
  VLM_COOLDOWN_AFTER_CART_S,
  AGENT_NANO_TOKEN_LIMIT,
  CART_LIMIT_INR,
  INFERENCE_CODES,
  FINISH_REASONS,
  HOSTED_FALLBACK_VALUES,
};

const eventFixtures = [
  { event: "orchestration_started", details: { dish: "biryani" } },
  { event: "started", details: {} },
  { event: "tools_ready", details: { count: 11 } },
  { event: "reasoning_started", details: {} },
  { event: "tool_call", details: { tool: "get_food_orders" } },
  { event: "tool_call", details: { tool: "get_food_order_details" } },
  { event: "tool_call", details: { tool: "search_restaurants" } },
  { event: "tool_call", details: { tool: "search_menu" } },
  { event: "tool_call", details: { tool: "get_restaurant_menu" } },
  { event: "tool_call", details: { tool: "flush_food_cart" } },
  { event: "tool_call", details: { tool: "update_food_cart" } },
  { event: "tool_call", details: { tool: "get_food_cart" } },
  { event: "tool_call", details: { tool: "fetch_food_coupons" } },
  { event: "tool_call", details: { tool: "apply_food_coupon" } },
  { event: "tool_complete", details: { tool: "get_food_cart" } },
  { event: "tool_skipped", details: {} },
  { event: "metadata_retry", details: {} },
  { event: "customization_started", details: {} },
  { event: "model:fallback-required", details: {} },
  { event: "model:fallback-approved", details: { automatic: false, hostedProvider: "Google Gemini" } },
  { event: "model:fallback-approved", details: { automatic: true, hostedProvider: "Google Gemini" } },
  { event: "orchestration_joined", details: { dish: "dosa" } },
  { event: "orchestration_paused", details: {} },
  { event: "completed", details: {} },
  { event: "cart_ready", details: { restaurant: "Meghana Foods" } },
  { event: "failed", details: { error: "The cart agent hit an error" } },
].map((fixture) => ({ ...fixture, message: agentEventMessage(fixture) }));

const identityFixtures = [
  { dish: "Masala Dosa", cuisine: "South Indian", ingredients: ["potato", "dosa"], confidence: 0.91, dishes: [{ dish: "Masala Dosa", cuisine: "South Indian", ingredients: ["dosa", "potato"], confidence: 0.8 }, { dish: "Filter Coffee", cuisine: "South Indian", ingredients: ["coffee"], confidence: 0.4 }] },
  { dish: "Masala   Dosa!", cuisine: "south-indian", ingredients: ["Potato", "dosa"], confidence: 0.2, dishes: [{ dish: "filter coffee", cuisine: "South Indian", ingredients: ["coffee"], confidence: 0.1 }, { dish: "Masala Dosa", cuisine: "South Indian", ingredients: ["potato", "dosa"], confidence: 0.7 }] },
  { dish: "Biryani", cuisine: "Hyderabadi", ingredients: ["rice", "saffron"], confidence: 0.95, dishes: [] },
].map((input) => ({ input, identity: foodCravingIdentity(input) }));

const remoteConfig = {
  vision_cloud_model: "gemini-3.5-flash-lite",
  ondevice_model_option: "STABLE",
  vlm_prompt_android: prompts.androidFoodVerificationInstruction,
  yolo_threshold: DEFAULT_SENSITIVITY,
  yolo_nms_iou: NMS_IOU,
  food_confidence_gate: FOOD_CONFIDENCE_GATE,
  dedupe_hist_distance: DEDUPE_DISTANCE,
  scan_fps_base: 1,
  scan_fps_max: 2,
  scan_fps_min: 0.5,
  vlm_max_per_min: VLM_MAX_PER_MIN,
  vlm_cooldown_after_cart_s: VLM_COOLDOWN_AFTER_CART_S,
  nudge_min_interval_min: NUDGE_MIN_INTERVAL_MIN,
  nudge_max_per_hour: NUDGE_MAX_PER_HOUR,
  watch_idle_timeout_min: WATCH_IDLE_TIMEOUT_MIN,
  routing_low_conf_cloud_retry: true,
  agent_nano_preference: "FAST",
  agent_nano_token_limit: AGENT_NANO_TOKEN_LIMIT,
  agent_cloud_model: "gemini-3.5-flash",
  agent_litert_model_url_e2b: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm",
  agent_litert_model_url_e4b: "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it.litertlm",
};

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function remoteConfigXml(values) {
  const entries = Object.entries(values).map(([key, value]) => `    <entry>\n        <key>${key}</key>\n        <value>${xmlEscape(value)}</value>\n    </entry>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>\n<defaultsMap>\n${entries}\n</defaultsMap>\n`;
}

writeJson(resolve(sharedDir, "prompts.json"), prompts);
writeJson(resolve(sharedDir, "constants.json"), constants);
writeJson(resolve(sharedDir, "labels.json"), { tools: AGENT_TOOL_LABELS, events: eventFixtures, hostedFallbackConfirm: HOSTED_FALLBACK_CONFIRM });
writeJson(resolve(sharedDir, "shared-schemas.json"), sharedSchemas);
writeJson(resolve(fixtureDir, "identity-golden.json"), identityFixtures);
writeJson(resolve(fixtureDir, "agent-events.json"), eventFixtures);
mkdirSync(dirname(xmlPath), { recursive: true });
writeFileSync(xmlPath, remoteConfigXml(remoteConfig));
writeJson(templatePath, { parameters: remoteConfig });
console.log(`Exported shared Android assets to ${sharedDir}`);
