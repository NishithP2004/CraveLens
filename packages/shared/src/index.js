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
  cuisine: z.string(),
  ingredients: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  context: z.enum(["ready_to_eat", "recipe", "restaurant_experience"]),
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
