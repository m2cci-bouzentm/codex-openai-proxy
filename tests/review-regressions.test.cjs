const { test } = require("node:test")
const assert = require("node:assert/strict")
const http = require("node:http")
const { prepareChat } = require("../dist/services/openai.service")
test("equivalent array text and complete historical tools survive registry changes", () => {
  const converted = prepareChat({
    messages: [
      { role: "system", content: [{ type: "text", text: "system" }] },
      { role: "developer", content: [{ type: "text", text: "developer" }] },
      { role: "assistant", content: [{ type: "text", text: "old" }] },
      { role: "user", content: "next" },
    ],
  }).native
  assert.equal(converted.instructions, "system\n\ndeveloper")
  assert.equal(converted.input[0].content[0].type, "output_text")
  const history = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "retired", arguments: '{"old":1}' } }],
    },
    { role: "tool", tool_call_id: "c1", content: "done" },
    { role: "user", content: "next" },
  ]
  assert.equal(prepareChat({ messages: history }).native.input[1].name, "retired")
  assert.throws(() =>
    prepareChat({
      messages: [
        history[0],
        {
          ...history[1],
          tool_calls: [{ ...history[1].tool_calls[0], function: { name: "retired", arguments: "not-json" } }],
        },
        ...history.slice(2),
      ],
    }),
  )
})
// chat buffering uses idle timeout, not a total generation deadline
// Regressions derived from real CC and OpenCode tool/model/cache matrix:
// 1. OpenCode OpenAI payload with tool definitions (bash, read, glob, grep, apply_patch, todowrite, skill, task, webfetch)
//    Model returns function_call, proxy maps to valid tool_call and handles continuation tool_result.
// 2. Claude Code Anthropic adapter tool roundtrip for exposed tools (Bash, Edit, Read) with actual tool_use/tool_result IDs and is_error semantics.
// 3. Both model endpoint shapes include mock catalog IDs and switching between IDs forwards exact chosen IDs.
// 4. Cache mapping positive and no double-count in usage.

test("OpenCode OpenAI payload with 9 standard tools roundtrips function call and tool result continuation", async () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "bash",
        description: "Run bash command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    },
    {
      type: "function",
      function: {
        name: "read",
        description: "Read file",
        parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
      },
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: "Find files by pattern",
        parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search files",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    },
    {
      type: "function",
      function: {
        name: "apply_patch",
        description: "Apply diff patch to files",
        parameters: { type: "object", properties: { patchText: { type: "string" } }, required: ["patchText"] },
      },
    },
    {
      type: "function",
      function: {
        name: "todowrite",
        description: "Write todo items",
        parameters: {
          type: "object",
          properties: { todos: { type: "array", items: { type: "string" } } },
          required: ["todos"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "skill",
        description: "Load skill instructions",
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
    },
    {
      type: "function",
      function: {
        name: "task",
        description: "Spawn subagent task",
        parameters: {
          type: "object",
          properties: { description: { type: "string" }, prompt: { type: "string" } },
          required: ["description", "prompt"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "webfetch",
        description: "Fetch URL content",
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      },
    },
  ]

  let upstreamCalls = []
  const fake = http.createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : null
    upstreamCalls.push({ path: req.url, body })

    const isContinuation = body?.input?.some((i) => i.type === "function_call_output")
    const output = isContinuation
      ? [
          {
            type: "message",
            id: "msg_2",
            role: "assistant",
            content: [{ type: "output_text", text: "PATCH_APPLIED_OK" }],
          },
        ]
      : [
          {
            type: "function_call",
            id: "fc_patch_1",
            call_id: "call_patch_123",
            name: "apply_patch",
            arguments: JSON.stringify({ patchText: "*** Begin Patch\n+test\n*** End Patch" }),
          },
        ]

    const resp = {
      id: "resp_oc_tools",
      object: "response",
      model: body?.model || "gpt-6-astra",
      status: "completed",
      output,
      usage: {
        input_tokens: 120,
        output_tokens: 15,
        total_tokens: 135,
        input_tokens_details: { cached_tokens: 50 },
      },
    }

    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write("event: response.created\ndata: " + JSON.stringify({ type: "response.created", response: resp }) + "\n\n")
    if (!isContinuation) {
      res.write(
        "event: response.output_item.done\ndata: " +
          JSON.stringify({ type: "response.output_item.done", item: output[0] }) +
          "\n\n",
      )
    }
    res.write(
      "event: response.completed\ndata: " + JSON.stringify({ type: "response.completed", response: resp }) + "\n\n",
    )
    res.end()
  })

  await new Promise((r) => fake.listen(0, "127.0.0.1", r))
  process.env.API_KEY = "oc-matrix-key"
  process.env.CODEX_UPSTREAM_BASE_URL = `http://127.0.0.1:${fake.address().port}`
  const auth = require("../dist/services/auth.service")
  auth.getAuth = async () => ({ accessToken: "test-secret", accountId: "test-account" })
  const { app } = require("../dist/index")
  const server = app.listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))

  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const headers = { authorization: "Bearer oc-matrix-key", "content-type": "application/json" }

    // Turn 1: OpenCode payload with 9 tools, requesting apply_patch
    const reqBody1 = {
      model: "gpt-6-astra",
      messages: [{ role: "user", content: "Apply patch to file" }],
      tools,
    }
    const res1 = await fetch(base + "/openai/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody1),
    })
    assert.equal(res1.status, 200)
    const data1 = await res1.json()
    assert.equal(data1.choices[0].finish_reason, "tool_calls")
    const toolCall = data1.choices[0].message.tool_calls[0]
    assert.equal(toolCall.id, "call_patch_123")
    assert.equal(toolCall.function.name, "apply_patch")
    assert.deepEqual(JSON.parse(toolCall.function.arguments), { patchText: "*** Begin Patch\n+test\n*** End Patch" })
    assert.equal(data1.usage.prompt_tokens_details.cached_tokens, 50)

    // Verify upstream received all 9 tools including apply_patch distinction
    const upstreamTools = upstreamCalls[0].body.tools
    assert.equal(upstreamTools.length, 9)
    assert.ok(upstreamTools.some((t) => t.name === "apply_patch"))
    assert.ok(!upstreamTools.some((t) => t.name === "edit" || t.name === "write"))

    // Turn 2: OpenCode sends tool_result continuation
    const reqBody2 = {
      model: "gpt-6-astra",
      messages: [
        { role: "user", content: "Apply patch to file" },
        data1.choices[0].message,
        { role: "tool", tool_call_id: "call_patch_123", content: "Patch applied successfully" },
      ],
      tools,
    }
    const res2 = await fetch(base + "/openai/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody2),
    })
    assert.equal(res2.status, 200)
    const data2 = await res2.json()
    assert.equal(data2.choices[0].finish_reason, "stop")
    assert.equal(data2.choices[0].message.content, "PATCH_APPLIED_OK")

    // Verify upstream turn 2 received function_call_output
    const lastUpstream = upstreamCalls[1].body
    assert.ok(
      lastUpstream.input.some(
        (i) =>
          i.type === "function_call_output" &&
          i.call_id === "call_patch_123" &&
          i.output === "Patch applied successfully",
      ),
    )
  } finally {
    server.closeAllConnections()
    fake.closeAllConnections()
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => fake.close(r))])
  }
})

test("Claude Code Anthropic adapter tool roundtrip for exposed Bash, Edit, and Read with tool IDs and is_error", async () => {
  const ccTools = [
    {
      name: "Bash",
      description: "Run bash command",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
    {
      name: "Edit",
      description: "Edit file content",
      input_schema: {
        type: "object",
        properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
        required: ["file_path", "old_string", "new_string"],
      },
    },
    {
      name: "Read",
      description: "Read file",
      input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
    },
  ]

  let upstreamCalls = []
  const fake = http.createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : null
    upstreamCalls.push({ path: req.url, body })

    const isContinuation = body?.input?.some((i) => i.type === "function_call_output")
    const output = isContinuation
      ? [
          {
            type: "message",
            id: "msg_cc_2",
            role: "assistant",
            content: [{ type: "output_text", text: "CC_CONTINUATION_OK" }],
          },
        ]
      : [
          {
            type: "function_call",
            id: "fc_edit_1",
            call_id: "call_edit_abc",
            name: "Edit",
            arguments: JSON.stringify({ file_path: "/tmp/f.txt", old_string: "a", new_string: "b" }),
          },
        ]

    const resp = {
      id: "resp_cc_tools",
      object: "response",
      model: body?.model || "gpt-6-astra",
      status: "completed",
      output,
      usage: {
        input_tokens: 150,
        output_tokens: 20,
        total_tokens: 170,
        input_tokens_details: { cached_tokens: 60 },
      },
    }

    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write("event: response.created\ndata: " + JSON.stringify({ type: "response.created", response: resp }) + "\n\n")
    if (!isContinuation) {
      res.write(
        "event: response.output_item.done\ndata: " +
          JSON.stringify({ type: "response.output_item.done", item: output[0] }) +
          "\n\n",
      )
    }
    res.write(
      "event: response.completed\ndata: " + JSON.stringify({ type: "response.completed", response: resp }) + "\n\n",
    )
    res.end()
  })

  await new Promise((r) => fake.listen(0, "127.0.0.1", r))
  process.env.API_KEY = "cc-matrix-key"
  process.env.CODEX_UPSTREAM_BASE_URL = `http://127.0.0.1:${fake.address().port}`
  const auth = require("../dist/services/auth.service")
  auth.getAuth = async () => ({ accessToken: "test-secret", accountId: "test-account" })
  const { app } = require("../dist/index")
  const server = app.listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))

  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const headers = {
      "x-api-key": "cc-matrix-key",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    }

    // Turn 1: Claude Code request with 3 exposed tools (Bash, Edit, Read)
    const req1 = {
      model: "gpt-6-astra",
      max_tokens: 256,
      messages: [{ role: "user", content: "Edit file" }],
      tools: ccTools,
    }
    const res1 = await fetch(base + "/anthropic/v1/messages", { method: "POST", headers, body: JSON.stringify(req1) })
    assert.equal(res1.status, 200)
    const data1 = await res1.json()
    assert.equal(data1.stop_reason, "tool_use")
    const toolUseBlock = data1.content.find((c) => c.type === "tool_use")
    assert.ok(toolUseBlock)
    assert.equal(toolUseBlock.id, "call_edit_abc")
    assert.equal(toolUseBlock.name, "Edit")
    assert.deepEqual(toolUseBlock.input, { file_path: "/tmp/f.txt", old_string: "a", new_string: "b" })
    // Cache mapping: cache_read_input_tokens = 60, input_tokens = 150 - 60 = 90 (no double count)
    assert.equal(data1.usage.cache_read_input_tokens, 60)
    assert.equal(data1.usage.input_tokens, 90)

    // Turn 2: tool_result continuation with is_error = true
    const req2Error = {
      model: "gpt-6-astra",
      max_tokens: 256,
      messages: [
        { role: "user", content: "Edit file" },
        { role: "assistant", content: [toolUseBlock] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_edit_abc", is_error: true, content: "File not found" }],
        },
      ],
      tools: ccTools,
    }
    const res2Error = await fetch(base + "/anthropic/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(req2Error),
    })
    assert.equal(res2Error.status, 200)
    const lastUpstreamError = upstreamCalls[1].body
    const outputBlockError = lastUpstreamError.input.find((i) => i.type === "function_call_output")
    assert.ok(outputBlockError)
    assert.equal(outputBlockError.call_id, "call_edit_abc")
    assert.ok(outputBlockError.output.includes("[tool_error]"))
    assert.ok(outputBlockError.output.includes("File not found"))

    // Turn 3: tool_result continuation with is_error = false (success)
    const req2Success = {
      model: "gpt-6-astra",
      max_tokens: 256,
      messages: [
        { role: "user", content: "Edit file" },
        { role: "assistant", content: [toolUseBlock] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_edit_abc",
              is_error: false,
              content: "File updated successfully",
            },
          ],
        },
      ],
      tools: ccTools,
    }
    const res2Success = await fetch(base + "/anthropic/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(req2Success),
    })
    assert.equal(res2Success.status, 200)
    const lastUpstreamSuccess = upstreamCalls[2].body
    const outputBlockSuccess = lastUpstreamSuccess.input.find((i) => i.type === "function_call_output")
    assert.ok(outputBlockSuccess)
    assert.equal(outputBlockSuccess.call_id, "call_edit_abc")
    assert.ok(!outputBlockSuccess.output.includes("[tool_error]"))
    assert.equal(outputBlockSuccess.output, "File updated successfully")
  } finally {
    server.closeAllConnections()
    fake.closeAllConnections()
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => fake.close(r))])
  }
})

test("both model endpoints include all 9 mock catalog IDs and switching two IDs forwards exact chosen IDs", async () => {
  const mockModels = [
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", context_window: 272000 },
    { slug: "gpt-6-sol", display_name: "GPT-6-Sol", context_window: 272000 },
    { slug: "gpt-6-luna", display_name: "GPT-6-Luna", context_window: 272000 },
    { slug: "gpt-reserve", display_name: "GPT-Reserve", context_window: 272000 },
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", context_window: 272000 },
    { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", context_window: 272000 },
    { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", context_window: 272000 },
    { slug: "gpt-5.5", display_name: "GPT-5.5", context_window: 272000 },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", context_window: 272000 },
  ]

  let upstreamCalls = []
  const fake = http.createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : null
    upstreamCalls.push({ path: req.url, body })

    if (req.url.includes("/codex/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ models: mockModels }))
    }

    const resp = {
      id: "resp_model_switch",
      object: "response",
      model: body?.model,
      status: "completed",
      output: [
        { type: "message", id: "msg_switch", role: "assistant", content: [{ type: "output_text", text: "SWITCH_OK" }] },
      ],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write("event: response.created\ndata: " + JSON.stringify({ type: "response.created", response: resp }) + "\n\n")
    res.write(
      "event: response.completed\ndata: " + JSON.stringify({ type: "response.completed", response: resp }) + "\n\n",
    )
    res.end()
  })

  await new Promise((r) => fake.listen(0, "127.0.0.1", r))
  process.env.API_KEY = "model-switch-key"
  process.env.CODEX_UPSTREAM_BASE_URL = `http://127.0.0.1:${fake.address().port}`
  const auth = require("../dist/services/auth.service")
  auth.getAuth = async () => ({ accessToken: "test-secret", accountId: "test-account" })
  const { app } = require("../dist/index")
  const server = app.listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))

  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const oaHeaders = { authorization: "Bearer model-switch-key", "content-type": "application/json" }
    const antHeaders = {
      "x-api-key": "model-switch-key",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    }

    // 1. OpenAI /openai/v1/models catalog check
    const oaModelsRes = await fetch(base + "/openai/v1/models", { headers: oaHeaders })
    assert.equal(oaModelsRes.status, 200)
    const oaModels = (await oaModelsRes.json()).data.map((m) => m.id)
    for (const m of mockModels) {
      assert.ok(oaModels.includes(m.slug), `missing OpenAI model ${m.slug}`)
    }

    // 2. Anthropic /anthropic/v1/models catalog check
    const antModelsRes = await fetch(base + "/anthropic/v1/models", { headers: antHeaders })
    assert.equal(antModelsRes.status, 200)
    const antModels = (await antModelsRes.json()).data.map((m) => m.id)
    for (const m of mockModels) {
      assert.ok(antModels.includes(m.slug), `missing Anthropic model ${m.slug}`)
    }

    // 3. Switching two IDs on OpenAI endpoint: gpt-6-astra vs gpt-6-sol
    upstreamCalls.length = 0
    const oa1 = await fetch(base + "/openai/v1/chat/completions", {
      method: "POST",
      headers: oaHeaders,
      body: JSON.stringify({ model: "gpt-6-astra", messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(oa1.status, 200)
    assert.equal(upstreamCalls[0].body.model, "gpt-6-astra")

    const oa2 = await fetch(base + "/openai/v1/chat/completions", {
      method: "POST",
      headers: oaHeaders,
      body: JSON.stringify({ model: "gpt-6-sol", messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(oa2.status, 200)
    assert.equal(upstreamCalls[1].body.model, "gpt-6-sol")

    // 4. Switching two IDs on Anthropic endpoint: gpt-6-astra vs gpt-6-sol
    upstreamCalls.length = 0
    const ant1 = await fetch(base + "/anthropic/v1/messages", {
      method: "POST",
      headers: antHeaders,
      body: JSON.stringify({ model: "gpt-6-astra", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(ant1.status, 200)
    assert.equal(upstreamCalls[0].body.model, "gpt-6-astra")

    const ant2 = await fetch(base + "/anthropic/v1/messages", {
      method: "POST",
      headers: antHeaders,
      body: JSON.stringify({ model: "gpt-6-sol", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(ant2.status, 200)
    assert.equal(upstreamCalls[1].body.model, "gpt-6-sol")
  } finally {
    server.closeAllConnections()
    fake.closeAllConnections()
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => fake.close(r))])
  }
})

test("chat buffering uses idle timeout, not a total generation deadline", async () => {
  process.env.API_KEY = "review-key"
  process.env.CODEX_TIMEOUT_MS = "200"
  const fake = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write('event: response.created\ndata: {"type":"response.created"}\n\n')
    let n = 0
    const timer = setInterval(() => {
      if (++n < 12) {
        res.write(": heartbeat\n\n")
        return
      }
      clearInterval(timer)
      res.end(
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "r",
              status: "completed",
              output: [{ type: "message", content: [{ type: "output_text", text: "ACTIVE_OK" }] }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          }) +
          "\n\n",
      )
    }, 50)
    res.on("close", () => clearInterval(timer))
  })
  await new Promise((r) => fake.listen(0, "127.0.0.1", r))
  process.env.CODEX_UPSTREAM_BASE_URL = `http://127.0.0.1:${fake.address().port}`
  const auth = require("../dist/services/auth.service")
  auth.getAuth = async () => ({ accessToken: "test-secret", accountId: "test-account" })
  const { app } = require("../dist/index")
  const server = app.listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/openai/v1/chat/completions`, {
      signal: AbortSignal.timeout(5000),
      method: "POST",
      headers: { authorization: "Bearer review-key", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).choices[0].message.content, "ACTIVE_OK")
  } finally {
    delete process.env.CODEX_TIMEOUT_MS
    server.closeAllConnections()
    fake.closeAllConnections()
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => fake.close(r))])
  }
})
