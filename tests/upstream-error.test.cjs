const { test } = require("node:test")
const assert = require("node:assert/strict")
const http = require("node:http")

test("provider rejections reach OpenAI and Anthropic clients with status and sanitized message", async () => {
  let reply = {
    status: 400,
    body: { error: { message: "Unsupported parameter: reasoning.summary", type: "invalid_request_error" } },
    headers: {},
  }
  const fake = http.createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers })
    res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body))
  })
  await new Promise((r) => fake.listen(0, "127.0.0.1", r))
  process.env.API_KEY = "err-key"
  process.env.CODEX_UPSTREAM_BASE_URL = `http://127.0.0.1:${fake.address().port}`
  const auth = require("../dist/services/auth.service")
  auth.getAuth = async () => ({ accessToken: "test-secret", accountId: "test-account" })
  const { app } = require("../dist/index")
  const server = app.listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  const base = `http://127.0.0.1:${server.address().port}`
  const openai = () =>
    fetch(base + "/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer err-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
    })
  const anthropic = () =>
    fetch(base + "/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "err-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    })
  try {
    let res = await openai()
    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), {
      error: {
        message: "Codex rejected request (HTTP 400): Unsupported parameter: reasoning.summary",
        type: "invalid_request_error",
      },
    })
    res = await anthropic()
    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Codex rejected request (HTTP 400): Unsupported parameter: reasoning.summary",
      },
    })

    reply = { status: 429, body: { detail: "Usage limit reached" }, headers: { "retry-after": "30" } }
    res = await openai()
    assert.equal(res.status, 429)
    assert.equal(res.headers.get("retry-after"), "30")
    assert.deepEqual(await res.json(), {
      error: { message: "Codex rate limit reached (HTTP 429): Usage limit reached", type: "rate_limit_error" },
    })

    reply = { status: 401, body: "secret raw upstream body", headers: {} }
    res = await openai()
    assert.equal(res.status, 502)
    assert.deepEqual(await res.json(), {
      error: { message: "Codex rejected the proxy credentials (HTTP 401)", type: "upstream_error" },
    })
    res = await anthropic()
    assert.equal(res.status, 502)
    assert.deepEqual(await res.json(), {
      type: "error",
      error: { type: "api_error", message: "Codex rejected the proxy credentials (HTTP 401)" },
    })
  } finally {
    server.close()
    fake.close()
  }
})
