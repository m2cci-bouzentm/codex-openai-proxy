# codex-openai-proxy

OpenAI-compatible API proxy that routes through your ChatGPT subscription (Plus/Pro) instead of API credits.

## Setup

**1. Auth** — login locally, copy token to VPS:

```bash
codex login
scp -i ~/.ssh/id_ed25519_devops ~/.codex/auth.json ubuntu@51.255.202.75:~/.config/codex/auth.json
rm ~/.codex/auth.json   # one token, one machine — avoid revocation
```

**2. Build and run** on VPS:

```bash
cp .env.example .env    # set API_KEY
docker compose up -d --build
```

**3. Re-auth** — repeat step 1 when tokens expire, then `docker restart codex-openai-proxy`.

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
