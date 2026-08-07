import { z } from "zod";

export const DetectionSchema = z.object({
  itemLabel: z.string().min(1),
  startTime: z.number().int().nonnegative(),
  endTime: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
});

export const FoodVerificationSchema = z.object({
  isFood: z.boolean(),
  dish: z.string(),
  description: z.string().trim().max(1200).default(""),
  cuisine: z.string(),
  ingredients: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  context: z.enum(["ready_to_eat", "recipe", "restaurant_experience"]),
});

export const VlmProviderSchema = z.enum(["auto", "gemini-nano", "litert-gemma4", "litert-gemma4-e4b", "litert-gemma3n", "ollama"]);
export const OrchestrationProviderSchema = z.enum(["auto", "litert", "ollama", "openai-compatible", "google"]);
export const MIN_LOCAL_CONTEXT_TOKENS = 4_096;
export const DEFAULT_LOCAL_CONTEXT_TOKENS = 16_384;
export const MAX_LOCAL_CONTEXT_TOKENS = 32_768;
export const LocalContextTokensSchema = z.coerce.number().int().min(MIN_LOCAL_CONTEXT_TOKENS).max(MAX_LOCAL_CONTEXT_TOKENS).default(DEFAULT_LOCAL_CONTEXT_TOKENS);
export const ThinkingEnabledSchema = z.boolean().default(false);

export const OllamaBaseUrlSchema = z.string().trim().url().max(1000).superRefine((value, context) => {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Ollama host must use HTTP or HTTPS" });
  if (url.username || url.password) context.addIssue({ code: z.ZodIssueCode.custom, message: "Ollama host cannot contain credentials" });
  if (url.pathname !== "/" || url.search || url.hash) context.addIssue({ code: z.ZodIssueCode.custom, message: "Ollama host must not contain a path, query, or fragment" });
}).transform((value) => new URL(value).origin);

export const ModelSettingsSchema = z.object({
  version: z.literal(1).default(1),
  vlm: z.object({
    provider: VlmProviderSchema.default("auto"),
    model: z.string().trim().max(200).optional(),
  }).default({ provider: "auto" }),
  orchestration: z.object({
    provider: OrchestrationProviderSchema.default("auto"),
    model: z.string().trim().max(200).optional(),
    baseUrl: z.string().url().max(1000).optional(),
    contextTokens: LocalContextTokensSchema,
    thinkingEnabled: ThinkingEnabledSchema,
  }).default({ provider: "auto", contextTokens: DEFAULT_LOCAL_CONTEXT_TOKENS, thinkingEnabled: false }),
  ollama: z.object({
    baseUrl: OllamaBaseUrlSchema.default("http://localhost:11434"),
  }).default({ baseUrl: "http://localhost:11434" }),
  hostedFallback: z.literal("ask").default("ask"),
});

export const ModelSettingsUpdateSchema = z.object({
  settings: ModelSettingsSchema,
  credentials: z.object({
    openai: z.string().trim().min(8).max(1000).optional(),
    google: z.string().trim().min(8).max(1000).optional(),
  }).optional(),
});

export const InferenceProviderSchema = z.enum(["litert", "ollama"]);
export const InferenceRequestSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  provider: InferenceProviderSchema,
  model: z.string().trim().min(1).max(200),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(z.unknown())]),
    name: z.string().max(200).optional(),
    toolCallId: z.string().max(200).optional(),
    toolCalls: z.array(z.unknown()).optional(),
  })).min(1).max(128),
  tools: z.array(z.unknown()).max(64).default([]),
  options: z.object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(8192).optional(),
    contextTokens: LocalContextTokensSchema.optional(),
    thinkingEnabled: z.boolean().optional(),
    toolChoice: z.unknown().optional(),
  }).default({}),
  stream: z.boolean().default(false),
  deadline: z.number().int().positive(),
});

export const InferenceResultSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  content: z.string(),
  toolCalls: z.array(z.object({
    id: z.string(),
    name: z.string(),
    args: z.record(z.unknown()),
  })).default([]),
  finishReason: z.string().default("stop"),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  }).optional(),
  metrics: z.record(z.number()).optional(),
});

export const OrchestrateRequestSchema = z.object({
  videoId: z.string().regex(/^[\w-]{6,20}$/),
  timestamp: z.number().nonnegative(),
  triggerConfidence: z.number().min(0).max(1),
  verification: FoodVerificationSchema,
  videoTitle: z.string().max(300).default("YouTube video"),
  location: z.string().max(1000).default("Bengaluru"),
  addressId: z.string().max(200).optional(),
  streamId: z.string().uuid().optional(),
  personalContext: z.string().trim().max(1000).default(""),
  timeZone: z.string().trim().max(100).optional(),
});

export const CartCustomizationSchema = z.object({
  instruction: z.string().trim().min(1).max(500),
  streamId: z.string().uuid().optional(),
  personalContext: z.string().trim().max(1000).optional(),
  timeZone: z.string().trim().max(100).optional(),
});

const AgentFollowUpOptionSchema = z.object({
  value: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(160),
  description: z.string().trim().max(240).optional(),
});

export const AgentFollowUpSchema = z.object({
  version: z.literal(1).default(1),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(400).optional(),
  fields: z.array(z.object({
    id: z.string().trim().regex(/^[a-z][a-z0-9_]{0,39}$/i),
    type: z.enum(["radio", "checkbox", "select", "text", "textarea"]),
    label: z.string().trim().min(1).max(240),
    required: z.boolean().default(true),
    placeholder: z.string().trim().max(240).optional(),
    defaultValue: z.union([
      z.string().trim().max(120),
      z.array(z.string().trim().max(120)).max(12),
    ]).optional(),
    options: z.array(AgentFollowUpOptionSchema).max(12).optional(),
  }).superRefine((field, context) => {
    if (["radio", "checkbox", "select"].includes(field.type) && !field.options?.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${field.type} fields require options`, path: ["options"] });
    }
  })).min(1).max(4),
  submitLabel: z.string().trim().min(1).max(40).default("Continue"),
});

export const CartMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set_quantity"),
    itemId: z.string().trim().min(1).max(200),
    quantity: z.number().int().min(0).max(20),
    confirmSameCustomizations: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("add_item"),
    itemId: z.string().trim().min(1).max(200),
    itemName: z.string().trim().min(1).max(200).optional(),
    selections: z.array(z.object({
      kind: z.enum(["variant", "addon"]),
      format: z.enum(["variants", "variations", "variantsV2", "addons"]),
      groupId: z.string().trim().min(1).max(200),
      choiceId: z.string().trim().min(1).max(200),
    })).max(30).optional(),
  }),
]);

export const CouponSelectionSchema = z.object({
  couponCode: z.string().trim().min(1).max(100),
});
