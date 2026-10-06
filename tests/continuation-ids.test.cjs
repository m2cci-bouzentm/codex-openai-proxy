const { test } = require("node:test")
const assert = require("node:assert/strict")
const http = require("node:http")

test("tool-call continuation never sends client call ids as Codex item ids", async () => {
  const seen = []
  const fake = http.createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    seen.push(JSON.parse(raw))
    const resp = {
      id: "resp_c",
      object: "response",
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "message", id: "msg_c", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(
      "event: response.completed\ndata: " + JSON.stringify({ type: "response.completed", response: resp }) + "\n\n",
    )
  })
  await new Promise((r) => fake.listen(0, "127.0.0.1", r))
  process.env.API_KEY = "ids-key"
  process.env.CODEX_UPSTREAM_BASE_URL = `http://127.0.0.1:${fake.address().port}`
  const auth = require("../dist/services/auth.service")
  auth.getAuth = async () => ({ accessToken: "test-secret", accountId: "test-account" })
  const { app } = require("../dist/index")
  const server = app.listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer ids-key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        tools: [{ type: "function", function: { name: "write", parameters: { type: "object" } } }],
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_2950382d4bd3478ba867bd925c1e7ab7",
                type: "function",
                function: { name: "write", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_2950382d4bd3478ba867bd925c1e7ab7", content: "ok" },
        ],
      }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    const call = seen[0].input.find((item) => item.type === "function_call")
    assert.equal(call.call_id, "call_2950382d4bd3478ba867bd925c1e7ab7")
    assert.ok(call.id === undefined || call.id.startsWith("fc"), `invalid Codex item id ${call.id}`)
  } finally {
    server.close()
    fake.close()
  }
})
