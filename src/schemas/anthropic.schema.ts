import { z } from "zod";
import { anthropicMessagesRequestContractSchema } from "./contracts.schema";

const anthropicTextPart = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: z.object({ type: z.literal("ephemeral") }).optional(),
});

const anthropicBase64ImageSource = z.object({
  type: z.literal("base64"),
  media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.string().min(1),
});

const anthropicUrlImageSource = z.object({
  type: z.literal("url"),
  url: z.string().url(),
});

const anthropicImagePart = z.object({
  type: z.literal("image"),
  source: z.union([anthropicBase64ImageSource, anthropicUrlImageSource]),
  cache_control: z.object({ type: z.literal("ephemeral") }).optional(),
});

const anthropicToolUsePart = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});

const anthropicToolResultPart = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(z.union([anthropicTextPart, anthropicImagePart]))]).optional(),
  is_error: z.boolean().optional(),
});

const anthropicThinkingPart = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});

const anthropicRedactedThinkingPart = z.object({
  type: z.literal("redacted_thinking"),
  data: z.string(),
});

export const anthropicContentPart = z.union([
  anthropicTextPart,
  anthropicImagePart,
  anthropicToolUsePart,
  anthropicToolResultPart,
  anthropicThinkingPart,
  anthropicRedactedThinkingPart,
]);

export const anthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(anthropicContentPart)]),
});

export const anthropicToolSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  description: z.string().optional(),
  input_schema: z.unknown(),
  cache_control: z.object({ type: z.literal("ephemeral") }).optional(),
});

const providerMessagesRequestSchema = z.object({
  model: z.string().min(1, "model is required"),
  max_tokens: z.number().int().positive("max_tokens must be a positive integer"),
  messages: z.array(anthropicMessageSchema).min(1, "messages is required"),
  system: z.union([
    z.string(),
    z.array(z.object({
      type: z.literal("text"),
      text: z.string(),
      cache_control: z.object({ type: z.literal("ephemeral") }).optional(),
    }))
  ]).optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().positive().optional(),
  tools: z.array(anthropicToolSchema).optional(),
  tool_choice: z.union([
    z.object({ type: z.literal("auto") }),
    z.object({ type: z.literal("any") }),
    z.object({ type: z.literal("none") }),
    z.object({ type: z.literal("tool"), name: z.string() }),
  ]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  stop_sequences: z.array(z.string()).optional(),
}).passthrough();

export const messagesRequestSchema = z.intersection(
  anthropicMessagesRequestContractSchema,
  providerMessagesRequestSchema,
);

export type MessagesRequest = z.infer<typeof messagesRequestSchema>;
export type AnthropicMessage = z.infer<typeof anthropicMessageSchema>;
export type AnthropicTool = z.infer<typeof anthropicToolSchema>;
