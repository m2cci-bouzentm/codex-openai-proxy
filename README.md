# codex-openai-proxy

OpenAI-compatible API proxy that routes through your ChatGPT subscription (Plus/Pro) instead of API credits.

## Setup

**1. Get auth credentials** — login locally, copy to VPS, delete local copy:

```bash
codex login
scp ~/.codex/auth.json your-vps:~/.codex/auth.json
rm ~/.codex/auth.json   # one token, one machine — avoid revocation
```

**2. Configure and start** on VPS:

```bash
cp .env.example .env    # set API_KEY
docker compose up -d --build
```

On first start, the proxy seeds from `~/.codex/auth.json` and writes its own copy to `~/.codex-proxy/auth.json`. From then on, it manages token refresh automatically — the seed file is never read again.

**Re-auth** — only needed if the refresh token dies. Copy a fresh `auth.json` to VPS, then `rm -rf ~/.codex-proxy && docker restart codex-openai-proxy` to force re-seed.

## API

```bash
curl http://your-vps:7391/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5.4-mini", "messages": [{"role": "user", "content": "Hello"}]}'
```

Works with any OpenAI SDK — just change `base_url` to `http://your-vps:7391/v1`.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | required | Secures proxy endpoint |
| `DEFAULT_MODEL` | `gpt-5.4-mini` | Fallback model |
| `PORT` | `3033` | Internal container port |
