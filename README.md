# codex-openai-proxy

Central ChatGPT/Codex OAuth gateway for OpenAI clients and native Codex CLI on
other devices. Clients use proxy API keys; OAuth/account identity stay server-side.

## Setup

Provision server-side `~/.codex/auth.json` using `codex login`. First request copies
that login into `~/.codex-proxy/auth.json`; source credentials are not deleted.
Use one central owner for refresh tokens; avoid concurrent independent refresh.
Never publish credentials. Use HTTPS or private networking for remote access.

```bash
npm ci
npm run build
cp .env.example .env  # set strong API_KEY
npm start
```

Docker setup remains `docker compose up -d --build`. Internal port: 3033; existing
compose mapping: 7391. Missing API_KEY fails closed. `/health` is public; all
protocol endpoints require `Authorization: Bearer <proxy-key>`.

## Protocol endpoints

Old `/v1` root is removed. Unified OpenAI base URL: `http://host:3033/openai/v1`.
Native Codex base URL: `http://host:3033/codex` (no `/v1`).

- POST `/openai/v1/chat/completions`: text, function tools, images, caching, usage.
- GET `/openai/v1/models`: live upstream catalog converted to OpenAI format.
- POST `/openai/v1/responses`: native Responses alias; use `stream: true`.
- POST `/codex/responses`: native Responses body and incremental SSE preserved.
- POST `/codex/responses/compact`: compatibility forwarding only; real upstream
  probe returned 404, so availability is NOT verified. Current native compaction
  via Responses requests passes through without modifying its fields.
- GET `/codex/models?client_version=0.157.1`: native model metadata/catalog.
- GET `/codex/usage`: central account usage/limits, backed by `/wham/usage`.

The server replaces inbound OAuth/account headers with its own credentials.
No arbitrary upstream URL can be selected by a client. WebSockets, hosted cloud
sessions, login management and the entire ChatGPT backend are not proxied.

## Native Codex client configuration

Set `CODEX_GATEWAY_KEY` to the proxy key. Client-side ChatGPT login is not needed.
Add to `~/.codex/config.toml`:

```toml
model_provider = "central"
model = "gpt-6-sol" # select a slug advertised by /codex/models
# Optional model catalog path, configured before the provider table:
# model_catalog_json = "/absolute/path/to/.codex/central-models.json"

[model_providers.central]
name = "Central Codex gateway"
base_url = "https://your-host/codex"
env_key = "CODEX_GATEWAY_KEY"
wire_api = "responses"
supports_websockets = false
```

Custom providers may not automatically fetch model metadata. Download the native
catalog and set the absolute `model_catalog_json` path above:

```bash
curl -f 'https://your-host/codex/models?client_version=0.157.1' \
  -H "Authorization: Bearer $CODEX_GATEWAY_KEY" \
  -o ~/.codex/central-models.json
```

Refresh the catalog after CLI/model updates. Accepted but unadvertised model names
can still trigger Codex's fallback metadata warning.

## OpenAI-compatible behavior

- System/developer instructions become native `instructions`.
- Function schemas, tool choices, parallel calls, call IDs/results become Responses
  function items. Ajv validates returned/historical arguments before exposing
  executable calls. The proxy never executes tools.
- User text/images become `input_text`/`input_image`; image URLs are not fetched locally.
- Encrypted reasoning context returns as `reasoning_details`; replay it unchanged
  with assistant history in tool loops. Refusals preserve diagnostics without tools.
- Chat SSE is buffered until response/tool validation completes, then emits OpenAI
  chunks, optional usage and `[DONE]`. Native Responses SSE is incremental.
- Usage maps real upstream input/output/cached/reasoning counters, not invented totals.
- Stable prompt cache keys and session routing persist across chat turns. Override
  `prompt_cache_key` or supply a stable `session_id` header if desired. Native cache
  fields and usage are untouched. Upstream decides cache hits; no local response cache.
- Optional `prompt_cache_options`/`prompt_cache_retention` pass through when supplied;
  model support varies. Explicit `prompt_cache_options` was rejected by the tested
  model, so it is NOT injected by default.
- `n=1`, function tools and text tool outputs are supported. Legacy `functions`,
  `function_call`, and `response_format` are rejected. `max_tokens` and
  `max_completion_tokens` are not translated; output limits are upstream-controlled.
  Other unlisted OpenAI parameters are not guaranteed.

## Configuration

- API_KEY: required proxy key.
- DEFAULT_MODEL: chat fallback `gpt-6.1-sol`; .env.example may override.
- REASONING_EFFORT: `high` by default.
- MODEL_ALIASES: existing legacy mappings plus optional `old=new,old2=new2`.
- PORT: `3033`.
- CODEX_PROXY_HOME: token storage, default `~/.codex-proxy`.
- CODEX_HOME: initial server CLI login source, default `~/.codex`.
- CODEX_CLIENT_VERSION: OpenAI model discovery version, default `0.157.1`.
- CODEX_TIMEOUT_MS: `120000`, first response/body deadline and native stream idle timeout.
- CODEX_UPSTREAM_BASE_URL: server-controlled backend override for local tests.

JSON requests/buffered responses are bounded to 32 MiB. Redirects are rejected;
client disconnects cancel inference. Error messages do not expose credentials.
Discovery is live rather than a hardcoded model list. Keep deliberate legacy aliases
in `src/models.ts` current when upstream retires targets.

## Verification

```bash
npm test
npm audit
# Opt-in REAL requests: consumes subscription usage, uses existing server login.
python scripts/e2e.py --cli --output /tmp/codex-proxy-e2e.json
```

Real E2E uses a temporary server and isolated CLI home, not a deployed-service
restart. Verified text, function-tool roundtrip, image input, live model discovery,
account usage, native Codex shell-tool execution, and 7040 cached input tokens.
Cache routing is upstream-controlled; every repeated request need not hit cache.
