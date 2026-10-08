import { randomUUID } from "crypto"
import type { NextFunction, Request, RequestHandler, Response } from "express"

interface RuntimeLoggerOptions {
  resolveOpenAIModel?: (model: string) => string
  resolveAnthropicModel?: (model: string) => string
  defaultModel?: string
  openaiDefaultEffort?: string
  anthropicDefaultEffort?: string
  openaiEffortSupported?: boolean
  anthropicEffortSupported?: boolean
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9._:[\]-]{1,100}$/.test(value) ? value : undefined
}

export function runtimeLogger(options: RuntimeLoggerOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const path = req.originalUrl.split("?", 1)[0]
    if (req.method !== "POST" || (!path.endsWith("/chat/completions") && !path.endsWith("/v1/messages"))) {
      next()
      return
    }
    const started = process.hrtime.bigint()
    const protocol = req.originalUrl.startsWith("/anthropic") ? "anthropic" : "openai"
    const requestedModel = clean(req.body?.model) || options.defaultModel || "default"
    const resolver = protocol === "anthropic" ? options.resolveAnthropicModel : options.resolveOpenAIModel
    const model = clean(resolver?.(requestedModel)) || requestedModel
    const requestedEffort =
      protocol === "anthropic" ? clean(req.body?.output_config?.effort) : clean(req.body?.reasoning_effort)
    const effortSupported =
      protocol === "anthropic" ? options.anthropicEffortSupported !== false : options.openaiEffortSupported !== false
    const effort = effortSupported
      ? requestedEffort ||
        (protocol === "anthropic" ? options.anthropicDefaultEffort : options.openaiDefaultEffort) ||
        "provider-default"
      : "provider-default"
    const requestId = randomUUID().slice(0, 12)
    const fields = {
      request_id: requestId,
      protocol,
      method: req.method,
      path: req.originalUrl.split("?", 1)[0],
      model_requested: requestedModel,
      model_upstream: model,
      effort,
      stream: req.body?.stream === true,
      messages: Array.isArray(req.body?.messages) ? req.body.messages.length : 0,
      tools: Array.isArray(req.body?.tools) ? req.body.tools.length : 0,
    }
    console.log(`[runtime:start] ${JSON.stringify(fields)}`)
    let logged = false
    const finish = (event: "finish" | "close") => {
      if (logged) return
      logged = true
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6
      console.log(
        `[runtime:end] ${JSON.stringify({
          request_id: requestId,
          status: res.statusCode,
          error: res.statusCode >= 400,
          event,
          duration_ms: Math.round(durationMs),
        })}`,
      )
    }
    res.once("finish", () => finish("finish"))
    res.once("close", () => finish("close"))
    next()
  }
}
