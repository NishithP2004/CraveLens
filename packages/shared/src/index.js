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
});
