const { test } = require("node:test")
const assert = require("node:assert/strict")
const http = require("node:http")
process.env.API_KEY = "proxy-test"

test("protocol routes centralize auth, preserve native caching/usage and bridge tool round trips", async () => {
  const requests = []
  const upstream = http.createServer(async (req, res) => {
    let raw = ""
    for await (const c of req) raw += c
    const body = raw ? JSON.parse(raw) : null
    requests.push({ path: req.url, headers: req.headers, body })
    if (req.url.includes("models")) {
      res.setHeader("content-type", "application/json")
      return res.end(JSON.stringify({ models: [{ slug: "test-model", display_name: "Test", context_window: 200000 }] }))
    }
    if (req.url.includes("usage")) {
      res.setHeader("content-type", "application/json")
      return res.end(JSON.stringify({ rate_limit: { allowed: true } }))
    }
    if (body.model === "error") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "5" })
      return res.end(JSON.stringify({ error: { message: "limited" } }))
    }
    if (body.model === "redirect") {
      res.writeHead(307, { location: "/leak" })
      return res.end()
    }
    const output =
      body.model === "refusal"
        ? [{ type: "message", content: [{ type: "refusal", refusal: "Cannot comply" }] }]
        : body.tools?.length && !body.input.some((i) => i.type === "function_call_output")
          ? [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "echo", arguments: '{"text":"ok"}' }]
          : [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "E2E_OK" }] }]
    const response = {
      id: "resp_1",
      model: body.model,
      status: "completed",
      output,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 8 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(
      "event: response.created\ndata: " +
        JSON.stringify({ type: "response.created", response: { id: "resp_1" } }) +
        "\n\n",
    )
    setTimeout(() => {
      for (const item of output)
        res.write(
          "event: response.output_item.done\ndata: " +
            JSON.stringify({ type: "response.output_item.done", item }) +
            "\n\n",
        )
      res.end(
        "event: response.completed\ndata: " +
          JSON.stringify({ type: "response.completed", response: { ...response, output: [] } }) +
          "\n\n",
      )
    }, 30)
  })
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r))
  process.env.CODEX_UPSTREAM_BASE_URL = `http://127.0.0.1:${upstream.address().port}`
  const auth = require("../dist/services/auth.service")
  auth.getAuth = async () => ({ accessToken: "central-token", accountId: "central-account" })
  const { app } = require("../dist/index")
  const server = app.listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { "content-type": "application/json", authorization: "Bearer proxy-test" }
  const post = (path, body, h = {}) =>
    fetch(base + path, { method: "POST", headers: { ...headers, ...h }, body: JSON.stringify(body) })
  try {
    assert.equal(
      (await post("/openai/v1/chat/completions", { model: "test-model", input: [] }, { authorization: "Bearer wrong" }))
        .status,
      401,
    )
    assert.equal(requests.length, 0)
    for (const p of ["/v1/models", "/tools/v1/models"]) assert.equal((await fetch(base + p)).status, 404)
    const completion = {
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      prompt_cache_key: "cache-id",
    }
    const response = await post("/openai/v1/chat/completions", completion, { "chatgpt-account-id": "do-not-forward" })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).usage.prompt_tokens_details.cached_tokens, 8)
    assert.equal(requests[0].body.prompt_cache_key, "cache-id")
    assert.equal(requests[0].headers.authorization, "Bearer central-token")
    assert.equal(requests[0].headers["chatgpt-account-id"], "central-account")
    const discovered = await fetch(base + "/openai/v1/models", { headers })
    assert.equal(discovered.status, 200)
    assert.equal((await discovered.json()).data[0].id, "test-model")

    const body = {
      model: "test-model",
      messages: [
        { role: "system", content: "keep system" },
        { role: "user", content: "hello" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "echo", parameters: { type: "object", properties: { text: { type: "string" } } } },
        },
      ],
    }
    const first = await (await post("/openai/v1/chat/completions", body)).json()
    assert.equal(first.choices[0].finish_reason, "tool_calls")
    assert.equal(first.choices[0].message.tool_calls[0].id, "call_1")
    assert.equal(first.usage.prompt_tokens_details.cached_tokens, 8)
    const second = await (
      await post("/openai/v1/chat/completions", {
        ...body,
        messages: [...body.messages, first.choices[0].message, { role: "tool", tool_call_id: "call_1", content: "ok" }],
      })
    ).json()
    assert.equal(second.choices[0].message.content, "E2E_OK")
    const chats = requests.filter((r) => r.path.includes("responses") && r.body?.tools?.length)
    assert.equal(chats[0].headers.session_id, chats[1].headers.session_id)
    const refusal = await (await post("/openai/v1/chat/completions", { ...body, model: "refusal" })).json()
    assert.equal(refusal.choices[0].message.refusal, "Cannot comply")
    assert.equal(refusal.choices[0].message.tool_calls, undefined)
    const stream = await post("/openai/v1/chat/completions", {
      ...body,
      stream: true,
      stream_options: { include_usage: true },
    })
    assert.match(await stream.text(), /\[DONE\]/)
    assert.equal((await post("/openai/v1/chat/completions", { ...completion, model: "error" })).status, 429)
    assert.equal((await post("/openai/v1/chat/completions", { ...completion, model: "redirect" })).status, 502)
    assert.ok(!requests.some((r) => r.path === "/leak"))
  } finally {
    server.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))])
  }
})
