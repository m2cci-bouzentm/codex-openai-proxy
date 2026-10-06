export {
  openAIChatRequestContractSchema as chatCompletionRequestSchema,
  openAIMessageContractSchema as chatMessageSchema,
  openAIToolContractSchema as toolDefinitionSchema,
} from "./contracts.schema"

export type { OpenAIChatRequestContract as ChatCompletionRequest } from "./contracts.schema"

import type { z } from "zod"
import { openAIMessageContractSchema, openAIToolContractSchema } from "./contracts.schema"
export type ChatMessage = z.infer<typeof openAIMessageContractSchema>
export type ToolDefinition = z.infer<typeof openAIToolContractSchema>
