# codex-openai-proxy

OpenAI-compatible API proxy that uses your ChatGPT subscription (Plus/Pro) instead of API credits. Calls `chatgpt.com/backend-api/codex/responses` directly using OAuth tokens from `~/.codex/auth.json` — no codex CLI needed at runtime.

## Setup

1. Run `codex login` on a machine with a browser to generate `~/.codex/auth.json`
2. Copy `.env.example` to `.env` and set your `API_KEY` (used to secure the proxy endpoint)
3. Run with Docker: `docker compose up -d` or directly: `npm start`
4. Send requests to `POST /v1/chat/completions` with the same format as the OpenAI API
