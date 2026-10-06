const { test } = require("node:test")
const assert = require("node:assert/strict")
const http = require("node:http")
const { prepareAnthropic } = require("../dist/services/anthropic.service")
const tool = {
  name: "echo",
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}
const base = { model: "bad", max_tokens: 256, tools: [tool], messages: [{ role: "user", content: "hi" }] }
test("Anthropic failed tool results preserve failure semantics", () => {
  const p = prepareAnthropic({
    ...base,
    messages: [
      ...base.messages,
      { role: "assistant", content: [{ type: "tool_use", id: "c", name: "echo", input: { text: "hi" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "denied", is_error: true }] },
    ],
  })
  assert.match(p.native.input.find((x) => x.type === "function_call_output").output, /tool_error/)
})
test("streamed invalid calls never close executable blocks; token cap and backward pagination remain native", async () => {
  process.env.API_KEY = "review-compat-key"
  const fake = http.createServer(async (req, res) => {
    if (req.url.includes("models"))
      return res.end(JSON.stringify({ models: ["a", "b", "c", "d"].map((slug) => ({ slug, display_name: slug })) }))
    let raw = ""
    for await (const c of req) raw += c
    const body = JSON.parse(raw)
    res.writeHead(200, { "content-type": "text/event-stream" })
    const emit = (e) => res.write("event: " + e.type + "\ndata: " + JSON.stringify(e) + "\n\n")
    const item = { id: "fc", type: "function_call", call_id: "c", name: "echo", arguments: '{"text":' }
    emit({ type: "response.created", response: { id: "r", status: "in_progress", output: [] } })
    emit({ type: "response.output_item.added", item: { ...item, arguments: "" } })
    emit({ type: "response.function_call_arguments.delta", item_id: "fc", delta: item.arguments })
    emit({ type: "response.output_item.done", item })
    const incomplete = body.model === "cap"
    emit({
      type: incomplete ? "response.incomplete" : "response.completed",
      response: {
        id: "r",
        status: incomplete ? "incomplete" : "completed",
        incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
        output: [item],
        usage: { input_tokens: 2, output_tokens: 3 },
      },
    })
    res.end()
  })
  await new Promise((r) => fake.listen(0, "127.0.0.1", r))
  process.env.CODEX_UPSTREAM_BASE_URL = `http://127.0.0.1:${fake.address().port}`
  const auth = require("../dist/services/auth.service")
  auth.getAuth = async () => ({ accessToken: "fake-private", accountId: "fake-account" })
  const { app } = require("../dist/index")
  const server = app.listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  const url = `http://127.0.0.1:${server.address().port}/anthropic/v1`
  const headers = { "content-type": "application/json", "x-api-key": "review-compat-key" }
  const post = (model, stream) =>
    fetch(url + "/messages", { method: "POST", headers, body: JSON.stringify({ ...base, model, stream }) })
  try {
    let response = await post("bad", true)
    let raw = await response.text()
    assert.match(raw, /event: error/)
    assert.doesNotMatch(raw, /content_block_stop/)
    response = await post("cap", false)
    assert.equal(response.status, 200)
    let data = await response.json()
    assert.equal(data.stop_reason, "max_tokens")
    assert.equal(
      data.content.some((x) => x.type === "tool_use"),
      false,
    )
    response = await post("cap", true)
    raw = await response.text()
    assert.match(raw, /"stop_reason":"max_tokens"/)
    assert.doesNotMatch(raw, /event: error/)
    response = await fetch(url + "/models?before_id=d&limit=1", { headers })
    data = await response.json()
    assert.deepEqual(
      data.data.map((x) => x.id),
      ["c"],
    )
    assert.equal(data.has_more, true)
  } finally {
    server.closeAllConnections()
    fake.closeAllConnections()
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => fake.close(r))])
  }
})
