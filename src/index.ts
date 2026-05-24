import express from "express";
import cors from "cors";
import "dotenv/config";

import { createCompletion } from "./codex";
import { AUTH_FILE } from "./auth";

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gpt-5.4-mini";
const PORT = process.env.PORT || 3033;

function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${API_KEY}`) {
    res.status(401).json({ error: { message: "Invalid API key", type: "auth_error" } });
    return;
  }
  next();
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/v1/chat/completions", auth, async (req, res) => {
  const { messages, model } = req.body;

  if (!messages || !messages.length) {
    res.status(400).json({ error: { message: "messages is required", type: "invalid_request" } });
    return;
  }

  try {
    const content = await createCompletion(messages, model || DEFAULT_MODEL);

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model || DEFAULT_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("request failed:", message);
    res.status(500).json({ error: { message, type: "server_error" } });
  }
});

app.listen(PORT, () => {
  console.log(`codex-proxy listening on :${PORT}`);
  console.log(`auth: ${AUTH_FILE}`);
});
