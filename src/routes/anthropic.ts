import { Router } from "express";
import { authenticateAnthropic } from "../middleware/auth";
import { anthropicMessages, anthropicModels } from "../controllers/anthropic.controller";

export function createAnthropicRouter(): Router {
  const router = Router();
  router.get("/v1/models", authenticateAnthropic, anthropicModels);
  router.post("/v1/messages", authenticateAnthropic, anthropicMessages);
  return router;
}

export const anthropicRouter = createAnthropicRouter();
