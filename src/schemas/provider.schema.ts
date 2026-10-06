import { z } from "zod"

export const upstreamUsageSchema = z
  .object({
    input_tokens: z.number().optional().default(0),
    output_tokens: z.number().optional().default(0),
    total_tokens: z.number().optional(),
    input_tokens_details: z
      .record(z.string(), z.unknown())
      .optional()
      .default(() => ({})),
    output_tokens_details: z
      .record(z.string(), z.unknown())
      .optional()
      .default(() => ({})),
  })
  .passthrough()

export const upstreamContentPartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    refusal: z.string().optional(),
  })
  .passthrough()

export const upstreamOutputItemSchema = z
  .object({
    id: z.string().optional(),
    type: z.string(),
    name: z.string().optional(),
    call_id: z.string().optional(),
    arguments: z.string().optional(),
    text: z.string().optional(),
    content: z.array(upstreamContentPartSchema).optional(),
    summary: z.unknown().optional(),
    encrypted_content: z.string().optional(),
    refusal: z.string().optional(),
  })
  .passthrough()

export const providerResponseSchema = z
  .object({
    id: z.string().optional(),
    status: z.string().optional(),
    output: z
      .array(upstreamOutputItemSchema)
      .optional()
      .default(() => []),
    usage: upstreamUsageSchema.nullish(),
    error: z.unknown().optional(),
    incomplete_details: z.object({ reason: z.string() }).nullish(),
  })
  .passthrough()

export const providerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("response.output_item.done"), item: upstreamOutputItemSchema }),
  z.object({ type: z.literal("response.completed"), response: providerResponseSchema }),
  z.object({ type: z.literal("response.failed"), response: providerResponseSchema.optional() }).passthrough(),
  z.object({ type: z.literal("error"), error: z.unknown().optional() }).passthrough(),
])

const eventBaseSchema = z.object({ type: z.string().min(1) }).passthrough()
const responseEventSchema = eventBaseSchema.extend({ response: providerResponseSchema })
const itemEventSchema = eventBaseSchema.extend({ item: upstreamOutputItemSchema })
const deltaEventSchema = eventBaseSchema.extend({ item_id: z.string(), delta: z.string() })
const contentPartEventSchema = eventBaseSchema.extend({
  item_id: z.string(),
  content_index: z.number().int().nonnegative(),
  part: upstreamContentPartSchema,
})

export const codexStreamEventSchema = eventBaseSchema.superRefine((event, ctx) => {
  const schema = ["response.created", "response.completed", "response.incomplete"].includes(event.type)
    ? responseEventSchema
    : ["response.output_item.added", "response.output_item.done"].includes(event.type)
      ? itemEventSchema
      : ["response.output_text.delta", "response.refusal.delta", "response.function_call_arguments.delta"].includes(
            event.type,
          )
        ? deltaEventSchema
        : event.type === "response.content_part.added"
          ? contentPartEventSchema
          : null
  if (schema && !schema.safeParse(event).success) {
    ctx.addIssue({ code: "custom", message: "Invalid upstream event" })
  }
})

export const modelItemSchema = z
  .object({
    slug: z.string(),
    display_name: z.string().optional(),
    context_window: z.number().optional(),
  })
  .passthrough()

export const modelsResponseSchema = z
  .object({
    models: z.array(modelItemSchema),
  })
  .passthrough()

export type ProviderResponse = z.infer<typeof providerResponseSchema>
export type UpstreamOutputItem = z.infer<typeof upstreamOutputItemSchema>
export type ModelsResponse = z.infer<typeof modelsResponseSchema>
