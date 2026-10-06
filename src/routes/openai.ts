import { Router } from "express"
import { authenticate } from "../middleware/auth"
import { listModels, chatCompletion } from "../controllers/openai.controller"

export function createOpenAIRouter(): Router {
  const router = Router()
  router.get("/models", authenticate, listModels)
  router.post("/chat/completions", authenticate, chatCompletion)
  return router
}

export const openaiRouter = createOpenAIRouter()
