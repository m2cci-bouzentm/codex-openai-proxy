export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface AnthropicMessageResponse {
  id: string
  type: "message"
  role: "assistant"
  model: string
  content: any[]
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "refusal" | null
  stop_sequence: string | null
  usage: AnthropicUsage
}
