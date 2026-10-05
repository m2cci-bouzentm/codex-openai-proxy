# codex-openai-proxy

ChatGPT/Codex OAuth proxy for OpenAI Chat Completions and Anthropic-compatible clients. Clients use proxy API keys; OAuth/account identity stay server-side.

## Auth & Credential Management (`proxy-auth`)

Authentication is managed via `proxy-auth login`, `import`, and `status`.
Docker credentials live in canonical `/data/auth.json`. Compose always sets
`PROXY_AUTH_DIR=/data` inside containers, regardless of the host setting.
`PROXY_AUTH_VOLUME` selects the mount source: the default named volume
`codex-proxy-data`, or an absolute host directory for a bind mount. For native
execution, `PROXY_AUTH_DIR` selects the local credential directory; it does not
select the Docker mount. Login/import one-off containers share the server's mount.
Prefer the named volume. A bind-mounted credential directory must be owned by
the container's user (root in this image), mode `0700`, without symlink path
components; `auth.json` must be mode `0600`. Host-native execution instead
requires ownership by the native process user.

### Interactive Login
The image includes official Codex CLI pinned to `0.160.0`. Login uses an isolated
CLI configuration directory beneath the auth directory.
```bash
# Docker device login (default; explicit --device is also supported):
docker compose run --rm codex-proxy proxy-auth login
```
Complete the displayed device verification in your host browser. Container
browser login (`--browser`) is unsupported and rejected: its callback listener
is not exposed. For browser login, run `proxy-auth login --browser` natively,
then import those credentials into the Docker volume.

### Import Credentials
Import existing native Codex credentials (`{"tokens": {"id_token", "access_token", "refresh_token"}}`) or normalized OAuth credentials (`{"type": "oauth", "access", "refresh", "expires", "accountId"}`):
```bash
# Via file mount:
docker compose run --rm -v "$(pwd)/import:/imports:ro" codex-proxy proxy-auth import --file /imports/auth.json

# Via stdin (avoid placing tokens in shell arguments):
docker compose run --rm -T codex-proxy proxy-auth import - < auth.json
```

### Check Status
Inspect credential presence, method, expiration, and account-ID presence without revealing tokens or account identifiers:
```bash
docker compose run --rm codex-proxy proxy-auth status
```

The server automatically monitors `/data/auth.json` and hot-reloads updated credentials dynamically without needing a container restart.

## Setup

Use one central owner for refresh tokens; avoid concurrent independent refresh.
Never publish credentials. Use HTTPS or private networking for remote access.

```bash
npm ci
npm run build
cp .env.example .env  # set strong API_KEY
npm start
```

Docker setup: `docker compose up -d --build`. Internal port: 3033; host mapping: 7391.
Missing API_KEY fails closed. `/health` is public; all protocol endpoints require `Authorization: Bearer ***`.

## Protocol endpoints

Old `/v1` root is removed. Unified OpenAI base URL: `http://host:3033/openai/v1`.

- POST `/openai/v1/chat/completions`: text, function tools, images, caching, usage.
- GET `/openai/v1/models`: live upstream catalog converted to OpenAI format.

The server replaces inbound OAuth/account headers with its own credentials.
No arbitrary upstream URL can be selected by a client. WebSockets, hosted cloud
sessions, login management and the entire ChatGPT backend are not proxied.

## Codex CLI compatibility

No native Codex gateway is exposed. Installed Codex CLI rejects `wire_api = "chat"`
and requires Responses API; direct CLI compatibility with this completion-only
OpenAI surface is not supported. This does not prevent other OpenAI Chat
Completions clients from using the proxy.

## Anthropic-compatible clients (Claude Code)

Claude Code can use Codex models through an Anthropic Messages protocol adapter.
This does not serve Claude models or promise the full Anthropic API surface.

- POST `/anthropic/v1/messages`: text/images, custom tools and tool results,
  incremental Anthropic SSE, native error envelopes and upstream usage.
- GET `/anthropic/v1/models`: live Codex catalog in Anthropic list format.
  Codex does not expose model creation dates; `created_at` uses the Unix epoch
  as an explicit unknown-date sentinel, not a real model creation date.
- Token counting is not supported; no `/anthropic/v1/messages/count_tokens` route is exposed.
- Authentication accepts `x-api-key` or Bearer proxy key. Server OAuth stays private.

Example isolated client invocation (replace placeholders; do not reuse upstream
OAuth as the proxy key):

```bash
ANTHROPIC_BASE_URL=https://your-host/anthropic \
ANTHROPIC_API_KEY="$PROXY_KEY" MAX_THINKING_TOKENS=0 \
claude --bare --model YOUR_CODEX_MODEL
```

Choose an ID from `/anthropic/v1/models`. Set `ANTHROPIC_DEFAULT_SONNET_MODEL`,
`ANTHROPIC_DEFAULT_HAIKU_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL` to valid Codex
IDs if the client uses model aliases or secondary calls. Clear conflicting
`CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_AUTH_TOKEN` in that client process.

Limitations: Anthropic thinking/signatures, hosted server tools, documents,
image-valued tool results, stop sequences, structured-output formats and MCP
server blocks are unsupported and rejected. `max_tokens` is validated but NOT
an enforced output limit because this subscription Responses backend rejects
`max_output_tokens`; sampling controls are not applied. `cache_control` is
accepted as a hint, but Codex determines cache hits/retention. Usage subtracts
real cached tokens from Anthropic `input_tokens` to avoid double counting;
cache creation is reported as zero, not fabricated. Hidden Codex reasoning
is not returned as Anthropic thinking or preserved through Anthropic history.
Claude Code may warn about custom models and unsupported auto-mode classifier
billing; that integration is not implemented. Full interactive/default-plugin
workflows are not claimed verified.

Real verification:

```bash
npm test
python scripts/anthropic-e2e.py --output /tmp/anthropic-codex-e2e.json
```

Opt-in E2E uses an ephemeral local proxy and isolated Claude Code home. It tests
live text, incremental SSE, custom tool roundtrip, image recognition, cached
usage and Claude Code print-mode text plus an observed Bash call/result.
It neither deploys nor modifies permanent Claude Code config.

## OpenAI-compatible behavior

- System/developer instructions become native `instructions`.
- Function schemas, tool choices, parallel calls, call IDs/results become Responses
  function items. Ajv validates newly returned arguments before exposing
  executable calls. Completed historical calls keep structural/JSON/ID/pairing
  validation without requiring their tools to remain in the current registry.
  The proxy never executes tools.
- User text/images become `input_text`/`input_image`; image URLs are not fetched locally.
- Encrypted reasoning context returns as `reasoning_details`; replay it unchanged
  with assistant history in tool loops. Refusals preserve diagnostics without tools.
- Chat SSE is buffered until response/tool validation completes, then emits OpenAI
  chunks, optional usage and `[DONE]`.
- Usage maps real upstream input/output/cached/reasoning counters, not invented totals.
- Stable prompt cache keys and session routing persist across chat turns. Override
  `prompt_cache_key` or supply a stable `session_id` header if desired. Upstream
  decides cache hits; no local response cache.
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
- CODEX_TIMEOUT_MS: `120000`, upstream response idle timeout.
- CODEX_UPSTREAM_BASE_URL: server-controlled backend override for local tests.

JSON requests/buffered responses are bounded to 32 MiB. Redirects are rejected;
client disconnects cancel inference. Error messages do not expose credentials.
Discovery is live rather than a hardcoded model list. Keep deliberate legacy aliases
in `src/models.ts` current when upstream retires targets.

## Reproducible Docker verification

```bash
# Actual proxy container; ONLY external provider mocked. No login required.
npm run test:http:docker
# Negative control: cache accounting mutation must be detected.
npm run test:http:mutation
# Opt-in: real subscription inference; explicit authorization required.
npm run test:e2e:docker -- --artifact-dir /absolute/private/path/codex-e2e
```

Both Docker runners reuse `scripts/http-cases.py`: all five public endpoints,
JSON/SSE text, tool calls/results, images, authentication and removed-route 404s.
Live runner discovers model ID, repeats a long identical prompt three times per
protocol and requires positive upstream cached-token counters. This is provider
prompt caching, never a local response cache. Provider fixture checks exact
100 input / 40 cached tokens (Anthropic uncached input must equal 60).

Live runner copies login into a chmod-700 artifact directory outside repository,
mounts only that copy read-only, publishes a random loopback port, and leaves
container running for inspection. Private `container.env` contains proxy key;
never share it. `report.json` stores sanitized results. Claude Code runs with
isolated HOME/config, bare mode and nonessential traffic disabled; Bash success
requires actual tool_use/tool_result events. Installed Codex chat config rejection
is recorded; no Responses endpoint is added. Docker/provider/cache errors fail
visibly rather than skip. Credential refresh affects only copied credentials.
Do not independently refresh original login while testing copies.

Linux Docker daemon must support current containerd shim. A shim bootstrap API
mismatch blocks container startup; these scripts never restart existing services.
For a non-Docker diagnostic only, `npm run test:http:local`
runs the same mock HTTP cases and verifies cache mutation against local Node;
it exits nonzero if baseline cases fail or the deliberate mutation is missed.
This diagnostic is not evidence of container or real-provider success.

Live Docker verification on 2026-10-05 passed all 33 HTTP cases against the
real Codex backend. OpenAI and Anthropic cache tests each observed 2176 cached
tokens on all three measured repeats. Claude Code text and Bash tool/result
flows passed through `/anthropic`; installed Codex CLI rejected `wire_api =
"chat"` before network, as documented above.

OpenCode 1.14.39 also passed against `/openai/v1`: text marker, completed Bash
tool execution and four repeated cache probes. Three probes reported 8704 cache
read tokens; one provider-routed repeat reported zero, so callers must consume
actual per-request usage rather than assume every repeat is a hit.

The full real client matrix across Claude Code and OpenCode confirmed:
- Claude Code bare mode exposes exactly 3/3 tools: `Bash`, `Edit`, `Read` (with `Write`, `Glob`, `Grep` unexposed in bare mode).
- OpenCode exposes 9/9 standard tools: `bash`, `read`, `glob`, `grep`, `apply_patch`, `todowrite`, `skill`, `task`, `webfetch`. In GPT mode OpenCode maps file modifications to `apply_patch` instead of `edit`/`write`.
- Both `/openai/v1/models` and `/anthropic/v1/models` return all 9/9 catalog IDs (`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-reserve`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `codex-auto-review`).
- Two-model switching forwards exact chosen IDs (`gpt-6-astra` vs `gpt-6-sol`) without alias interference.
- Caching behavior verified across 17 positive matrix records totaling 152,320 aggregate cache read tokens without double-counting against uncached input tokens.
- OpenCode dynamic model discovery requires static configuration; dynamic discovery from the proxy provider fails (`Provider not found: proxy`), so static model declarations are mandatory.

## Verification

```bash
npm test
npm run test:auth:docker  # builds unique current image; local synthetic provider only
npm audit
# Opt-in REAL requests: consumes subscription usage, uses existing server login.
python scripts/e2e.py --output /tmp/codex-proxy-e2e.json
```

Real E2E uses a temporary server, not a deployed-service restart. Earlier real
verification covered text, function-tool roundtrip, image input, live model
discovery and 7040 cached input tokens. Current script exercises those supported
endpoints only; native Codex routes and CLI checks were removed.
Cache routing is upstream-controlled; every repeated request need not hit cache.
