# codex-openai-proxy

OpenAI-compatible API proxy that uses your ChatGPT subscription (Plus/Pro) instead of API credits. Calls `chatgpt.com/backend-api/codex/responses` directly using OAuth tokens. Auth is managed in its own file (`~/.codex-proxy/auth.json`), seeded from codex CLI on first run — no token rotation conflicts.

## Setup

1. Run `codex login` on a machine with a browser to generate `~/.codex/auth.json`
2. Copy `.env.example` to `.env` and set your `API_KEY` (used to secure the proxy endpoint)
3. Run `npm install && npm run build && npm start`, or with Docker: `docker compose up -d`
4. Send requests to `POST /v1/chat/completions` with the same format as the OpenAI API
