const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { createCompletion } = require("./src/codex");
const { AUTH_FILE } = require("./src/auth");

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gpt-5.4-mini";
const PORT = process.env.PORT || 3033;

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: { message: "Invalid API key", type: "auth_error" } });
  }
  next();
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/v1/chat/completions", auth, async (req, res) => {
  const { messages, model } = req.body;

  if (!messages || !messages.length) {
    return res.status(400).json({ error: { message: "messages is required", type: "invalid_request" } });
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
    console.error("request failed:", err.message);
    res.status(500).json({ error: { message: err.message, type: "server_error" } });
  }
});

app.listen(PORT, () => {
  console.log(`codex-proxy listening on :${PORT}`);
  console.log(`auth: ${AUTH_FILE}`);
});
