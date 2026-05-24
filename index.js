const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gpt-5.4-mini";
const PORT = process.env.PORT || 3033;
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const AUTH_FILE = path.join(CODEX_HOME, "auth.json");
const CODEX_API = "https://chatgpt.com/backend-api/codex/responses";
const AUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

let cachedAuth = null;

function loadAuth() {
  const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
  const idPayload = JSON.parse(
    Buffer.from(raw.tokens.id_token.split(".")[1] + "==", "base64url").toString()
  );
  const oaClaims = idPayload["https://api.openai.com/auth"] || {};
  cachedAuth = {
    accessToken: raw.tokens.access_token,
    refreshToken: raw.tokens.refresh_token,
    idToken: raw.tokens.id_token,
    accountId: oaClaims.chatgpt_account_id || "",
    expiresAt: (idPayload.exp || 0) * 1000,
  };
  return cachedAuth;
}

let refreshPromise = null;

async function ensureAuth() {
  if (!cachedAuth) loadAuth();
  if (Date.now() < cachedAuth.expiresAt - 60000) return cachedAuth;

  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const resp = await fetch(AUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: cachedAuth.refreshToken,
      }),
    });

    if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);

    const tokens = await resp.json();

    const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
    raw.tokens.id_token = tokens.id_token;
    raw.tokens.access_token = tokens.access_token;
    if (tokens.refresh_token) raw.tokens.refresh_token = tokens.refresh_token;
    fs.writeFileSync(AUTH_FILE, JSON.stringify(raw, null, 2));

    cachedAuth = null;
    loadAuth();
    return cachedAuth;
  })().finally(() => { refreshPromise = null; });

  return refreshPromise;
}

function buildHeaders(auth, sessionId) {
  return {
    "Authorization": `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-Id": auth.accountId,
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "User-Agent": `codex-proxy/1.0.0 (${process.platform} ${os.release()}; ${process.arch})`,
    "originator": "opencode",
    "session_id": sessionId,
  };
}

function messagesToInput(messages) {
  const input = [];
  let instructions = "You are a helpful assistant.";

  for (const m of messages) {
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
        : "";

    if (m.role === "system") {
      instructions = text;
    } else {
      input.push({ role: m.role === "assistant" ? "assistant" : "user", content: text });
    }
  }

  return { instructions, input };
}

async function callCodexAPI(messages, model, sessionId) {
  const auth = await ensureAuth();
  const { instructions, input } = messagesToInput(messages);

  const resp = await fetch(CODEX_API, {
    method: "POST",
    headers: buildHeaders(auth, sessionId),
    body: JSON.stringify({
      model,
      instructions,
      input,
      stream: true,
      store: false,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Codex API ${resp.status}: ${body}`);
  }

  const body = await resp.text();
  let content = "";

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const evt = JSON.parse(line.slice(6));
      if (evt.type === "response.output_text.delta") {
        content += evt.delta || "";
      }
    } catch {}
  }

  return content;
}

function auth_mw(req, res, next) {
  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: { message: "Invalid API key", type: "auth_error" } });
  }
  next();
}

let stats = { total: 0, errors: 0, avgMs: 0, totalMs: 0 };

app.get("/health", (req, res) => {
  res.json({ status: "ok", mode: "direct-api", stats });
});

app.post("/v1/chat/completions", auth_mw, async (req, res) => {
  const { messages, model } = req.body;

  if (!messages || !messages.length) {
    return res.status(400).json({ error: { message: "messages is required", type: "invalid_request" } });
  }

  const useModel = model || DEFAULT_MODEL;
  const sessionId = crypto.randomUUID();
  const start = Date.now();

  try {
    const content = await callCodexAPI(messages, useModel, sessionId);
    const elapsed = Date.now() - start;
    stats.total++;
    stats.totalMs += elapsed;
    stats.avgMs = Math.round(stats.totalMs / stats.total);

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
    stats.errors++;
    console.error("codex API failed:", err.message);
    res.status(500).json({ error: { message: err.message, type: "server_error" } });
  }
});

app.listen(PORT, () => {
  console.log(`codex-proxy (direct-api) listening on port ${PORT}`);
  console.log(`Auth: ${AUTH_FILE}`);
  console.log(`Default model: ${DEFAULT_MODEL}`);
});
