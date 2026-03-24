const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY;
const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_EFFORT = "medium";
const PORT = process.env.PORT || 3033;

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: { message: "Invalid API key", type: "auth_error" } });
  }
  next();
}

function messagesToPrompt(messages) {
  return messages
    .map((m) => {
      if (typeof m.content === "string") return `${m.role}: ${m.content}`;
      if (Array.isArray(m.content)) {
        const text = m.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        return `${m.role}: ${text}`;
      }
      return "";
    })
    .join("\n\n");
}

function runCodex(prompt, model, effort) {
  return new Promise((resolve, reject) => {
    const args = [
      "exec",
      prompt,
      "--model", model,
      "-c", `model_reasoning_effort="${effort}"`,
      "--skip-git-repo-check",
      "--full-auto",
    ];

    execFile("codex", args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/v1/chat/completions", auth, async (req, res) => {
  const { messages, model, reasoning_effort } = req.body;

  if (!messages || !messages.length) {
    return res.status(400).json({ error: { message: "messages is required", type: "invalid_request" } });
  }

  const prompt = messagesToPrompt(messages);
  const useModel = model || DEFAULT_MODEL;
  const effort = reasoning_effort || DEFAULT_EFFORT;

  try {
    const content = await runCodex(prompt, useModel, effort);

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: useModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    console.error("codex exec failed:", err.message);
    res.status(500).json({ error: { message: "Codex execution failed: " + err.message, type: "server_error" } });
  }
});

app.listen(PORT, () => console.log(`codex-openai-proxy listening on port ${PORT}`));
