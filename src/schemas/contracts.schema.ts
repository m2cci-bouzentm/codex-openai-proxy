import { z } from "zod"

const textPartSchema = z.object({ type: z.literal("text"), text: z.string() })
const imagePartSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string().min(1),
    detail: z.enum(["auto", "low", "high"]).optional(),
  }),
})
const userContentPartSchema = z.union([textPartSchema, imagePartSchema])
const functionCallSchema = z.object({ name: z.string().min(1), arguments: z.string() })
const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: functionCallSchema,
})
const reasoningDetailSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    encrypted_content: z.string().optional(),
    summary: z.unknown().optional(),
  })
  .passthrough()

export const openAIMessageContractSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.enum(["system", "developer"]),
    content: z.union([z.string(), z.array(textPartSchema)]),
    name: z.string().optional(),
  }),
  z.object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(userContentPartSchema)]),
    name: z.string().optional(),
  }),
  z.object({
    role: z.literal("assistant"),
    content: z
      .union([z.string(), z.array(textPartSchema)])
      .nullable()
      .optional(),
    tool_calls: z.array(toolCallSchema).optional(),
    reasoning_details: z.array(reasoningDetailSchema).optional(),
    refusal: z.string().nullable().optional(),
    name: z.string().optional(),
  }),
  z.object({
    role: z.literal("tool"),
    content: z.union([z.string(), z.array(userContentPartSchema)]),
    tool_call_id: z.string().min(1),
    name: z.string().optional(),
  }),
])

export const openAIToolContractSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    description: z.string().optional(),
    parameters: z.unknown().optional(),
    strict: z.boolean().optional(),
  }),
})

export const openAIChatRequestContractSchema = z.object({
  messages: z.array(openAIMessageContractSchema).min(1),
  model: z.string().min(1).optional(),
  max_tokens: z.number().int().positive().nullish(),
  max_completion_tokens: z.number().int().positive().nullish(),
  max_output_tokens: z.number().int().positive().nullish(),
  stream: z.boolean().optional().default(false),
  tools: z.array(openAIToolContractSchema).max(128).optional().default([]),
  tool_choice: z
    .union([
      z.literal("none"),
      z.literal("auto"),
      z.literal("required"),
      z.object({ type: z.literal("function"), function: z.object({ name: z.string().min(1) }) }),
    ])
    .optional(),
  parallel_tool_calls: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  prompt_cache_options: z.object({ ttl: z.string().optional() }).passthrough().optional(),
  prompt_cache_key: z.string().optional(),
  prompt_cache_retention: z.unknown().optional(),
  reasoning_effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  store: z.literal(false).optional(),
  n: z.literal(1).optional(),
  functions: z.never().optional(),
  function_call: z.never().optional(),
  response_format: z.never().optional(),
})

const anthropicMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  })
  .passthrough()

export const anthropicMessagesRequestContractSchema = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive(),
    messages: z.array(anthropicMessageSchema).min(1),
    system: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).optional(),
    stream: z.boolean().optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    tool_choice: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    stop_sequences: z.array(z.string()).optional(),
    temperature: z.number().min(0).max(1).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().positive().optional(),
    thinking: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

export const anthropicCountTokensRequestContractSchema = anthropicMessagesRequestContractSchema
  .omit({ max_tokens: true, stream: true })
  .passthrough()

export const anthropicModelsQueryContractSchema = z
  .object({
    before_id: z.string().optional(),
    after_id: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  })
  .passthrough()

export const canonicalOAuthContractSchema = z
  .object({
    type: z.literal("oauth"),
    access: z.string().default(""),
    refresh: z.string().default(""),
    expires: z.number().finite().nonnegative().max(8_640_000_000_000_000).optional(),
    accountId: z.string().nullable().optional(),
    scopes: z.array(z.string()).optional(),
    subscriptionType: z.string().nullable().optional(),
    rateLimitTier: z.string().nullable().optional(),
  })
  .superRefine((entry, ctx) => {
    if (!entry.access.trim() && !entry.refresh.trim()) {
      ctx.addIssue({ code: "custom", message: "Invalid credential: missing access/refresh" })
    }
    if (entry.access.trim() && entry.expires === undefined) {
      ctx.addIssue({ code: "custom", path: ["expires"], message: "Expiry is required with access token" })
    }
  })
  .transform((entry) => ({ ...entry, expires: entry.expires ?? 0 }))

export const authStatusContractSchema = z.object({
  configured: z.boolean(),
  type: z.literal("oauth").nullable(),
  provider: z.enum(["openai", "claude"]),
  expiresAt: z.string().nullable(),
  isExpired: z.boolean(),
  accessPresent: z.boolean(),
  refreshPresent: z.boolean(),
  accountIdPresent: z.boolean(),
  subscriptionType: z.string().nullable(),
  rateLimitTier: z.string().nullable(),
})

export const tokenWizardContractSchema = z
  .object({
    access: z.string(),
    refresh: z.string(),
    expires: z.string().optional().default(""),
    accountId: z.string().optional().default(""),
  })
  .refine((entry) => Boolean(entry.access.trim() || entry.refresh.trim()), {
    message: "At least one token is required",
  })

export type OpenAIChatRequestContract = z.infer<typeof openAIChatRequestContractSchema>
export type AnthropicMessagesRequestContract = z.infer<typeof anthropicMessagesRequestContractSchema>
export type CanonicalOAuthContract = z.infer<typeof canonicalOAuthContractSchema>
export type AuthStatusContract = z.infer<typeof authStatusContractSchema>
