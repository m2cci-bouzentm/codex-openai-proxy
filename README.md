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
  -d '{"model": "gpt-5.6-luna", "messages": [{"role": "user", "content": "Hello"}]}'
```

Works with any OpenAI SDK — just change `base_url` to `http://your-vps:7391/v1`.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | required | Secures proxy endpoint |
| `DEFAULT_MODEL` | `gpt-5.6-luna` | Fallback model |
| `REASONING_EFFORT` | `high` | Default reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`). Per request: `reasoning_effort` field |
| `MODEL_ALIASES` | see below | Extra `old=new,old2=new2` pairs |
| `PORT` | `3033` | Internal container port |

## Models

Current lineup accepted upstream (`GET /v1/models`): `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.3-codex-spark`.

Retired names are aliased so old callers keep working:

| Requested | Served |
|-----------|--------|
| `gpt-5.4-mini` | `gpt-5.6-luna` |
| `gpt-5.4` | `gpt-5.6-terra` |
| `gpt-5.3-codex` | `gpt-5.6-terra` |
| `gpt-5.2` | `gpt-5.6-sol` |

Upstream rejects anything else with `400 ... not supported when using Codex with a ChatGPT account`. When OpenAI retires a model again, update `src/models.ts` (list from `~/.codex/models_cache.json` after running `codex`).
