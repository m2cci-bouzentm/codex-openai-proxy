import express from "express"
import cors from "cors"
import "dotenv/config"
import { config } from "./config"
import { AUTH_FILE } from "./lib/auth-storage"
import { healthRouter } from "./routes/health"
import { openaiRouter } from "./routes/openai"
import { anthropicRouter } from "./routes/anthropic"
import { anthropicError } from "./services/anthropic.service"
import { startJobs } from "./jobs"
import { resolveModel } from "./config/models"
import { runtimeLogger } from "./lib/runtime-logger"

export const app = express()
app.use(cors())

// Configure body parsers for high-capacity inference endpoints (32mb)
app.use(["/openai/v1/chat/completions", "/anthropic/v1/messages"], express.json({ limit: "32mb" }))
app.use(express.json())
app.use(
  runtimeLogger({
    resolveOpenAIModel: resolveModel,
    resolveAnthropicModel: resolveModel,
    defaultModel: process.env.DEFAULT_MODEL || "gpt-6.1-sol",
    openaiDefaultEffort: process.env.REASONING_EFFORT || "high",
    anthropicDefaultEffort: process.env.ANTHROPIC_REASONING_EFFORT || "low",
  }),
)

// Mount routers
app.use("/health", healthRouter)
app.use("/openai/v1", openaiRouter)
app.use("/anthropic", anthropicRouter)

app.use(((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (_req.path.startsWith("/anthropic/")) {
    anthropicError(
      res,
      err.type === "entity.too.large" ? 413 : 400,
      "invalid_request_error",
      "Invalid or oversized request body",
    )
    return
  }
  res.status(err.type === "entity.too.large" ? 413 : 400).json({
    error: {
      type: "invalid_request_error",
      message: "Invalid or oversized request body",
    },
  })
}) as express.ErrorRequestHandler)

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`codex-proxy listening on :${config.port}`)
    console.log(`auth: ${AUTH_FILE}`)
    startJobs()
  })
}
