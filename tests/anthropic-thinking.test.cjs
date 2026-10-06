const { test } = require("node:test")
const assert = require("node:assert/strict")
const http = require("node:http")

test("Claude Code requests (adaptive thinking, effort, thinking history) are accepted", async () => {
  const seen = []
  const fake = http.createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    seen.push(JSON.parse(raw))
    const resp = {
      id: "resp_t",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(
      "event: response.completed\ndata: " + JSON.stringify({ type: "response.completed", response: resp }) + "\n\n",
    )
  })
  await new Promise((r) => fake.listen(0, "127.0.0.1", r))
  process.env.API_KEY = "think-key"
  process.env.CODEX_UPSTREAM_BASE_URL = `http://127.0.0.1:${fake.address().port}`
  const auth = require("../dist/services/auth.service")
  auth.getAuth = async () => ({ accessToken: "test-secret", accountId: "test-account" })
  const { app } = require("../dist/index")
  const server = app.listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  const post = (body) =>
    fetch(`http://127.0.0.1:${server.address().port}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "think-key", "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  try {
    let res = await post({
      model: "gpt-5.5",
      max_tokens: 32000,
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "hi" }],
    })
    assert.equal(res.status, 200)
    assert.equal(seen.at(-1).reasoning.effort, "high")
    res = await post({
      model: "gpt-5.5",
      max_tokens: 100,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "x", signature: "foreign" },
            { type: "redacted_thinking", data: "y" },
            { type: "text", text: "hello" },
          ],
        },
        { role: "user", content: "again" },
      ],
    })
    assert.equal(res.status, 200, await res.clone().text())
    assert.equal(seen.at(-1).reasoning.effort, "low")
    assert.doesNotMatch(JSON.stringify(seen.at(-1).input), /foreign|redacted/)
  } finally {
    server.close()
    fake.close()
  }
})
