import crypto from "crypto";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import type { Request, Response } from "express";
import { upstream, boundedBody } from "../lib/codex-client";
import { requestScope } from "../utils/abort";
import { resolveModel, type ReasoningEffort } from "../config/models";
import { chatCompletionRequestSchema, type ChatCompletionRequest } from "../schemas/openai.schema";
import {
  providerResponseSchema,
  providerEventSchema,
  type ProviderResponse,
  type UpstreamOutputItem,
} from "../schemas/provider.schema";
import { ProxyError, providerMessage, upstreamRejection } from "../errors/proxy-error";

export function prepareChat(rawBody: any) {
  const parsed = chatCompletionRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ProxyError(`Invalid request: ${msg}`, 400);
  }
  const body = parsed.data;

  const input: any[] = [];
  const instructions: string[] = [];
  const pending = new Set<string>();
  const seen = new Set<string>();

  const tools = (body.tools ?? []).map((tool) => {
    return { type: "function", ...tool.function, strict: tool.function.strict ?? false };
  });

  const validators = new Map<string, ReturnType<Ajv["compile"]>>();
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const ajv2020 = new Ajv2020({ strict: false, validateFormats: false });
  for (const tool of tools) {
    if (validators.has(tool.name)) throw new ProxyError("Duplicate tool name", 400);
    const schema = (tool.parameters ?? { type: "object" }) as any;
    const compiler = schema.$schema === "https://json-schema.org/draft/2020-12/schema" ? ajv2020 : ajv;
    validators.set(tool.name, compiler.compile(schema));
  }

  for (const message of body.messages) {
    if (["system", "developer"].includes(message.role)) {
      let text = message.content;
      if (Array.isArray(text)) {
        text = text.map((part: any) => {
          if (part.type !== "text" || typeof part.text !== "string") throw new ProxyError("Instructions must be text", 400);
          return part.text;
        }).join("\n");
      }
      if (typeof text !== "string") throw new ProxyError("Instructions must be text", 400);
      instructions.push(text);
      continue;
    }
    if (message.role === "tool") {
      if (!pending.has(message.tool_call_id)) throw new ProxyError("Tool response without prior tool call", 400);
      pending.delete(message.tool_call_id);
      let output = message.content;
      if (Array.isArray(output)) {
        output = output.map((part: any) => {
          if (part.type === "text") return part.text;
          if (part.type === "image_url") return `[image: ${part.image_url.url}]`;
          return "";
        }).join("\n");
      }
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: typeof output === "string" ? output : JSON.stringify(output) });
      continue;
    }
    if (message.role === "assistant") {
      if (message.tool_calls?.length) {
        for (const call of message.tool_calls) {
          if (call.type !== "function" || !call.function?.name) throw new ProxyError("Invalid tool call", 400);
          if (seen.has(call.id)) throw new ProxyError("Duplicate tool call id", 400);
          seen.add(call.id);
          pending.add(call.id);
          let args: any;
          try { args = JSON.parse(call.function.arguments); }
          catch { throw new ProxyError("Invalid historical tool arguments", 400); }
          const validator = validators.get(call.function.name);
          if (validator && !validator(args)) throw new ProxyError("Historical tool arguments failed schema", 400);
          input.push({ type: "function_call", id: call.id, call_id: call.id, name: call.function.name, arguments: call.function.arguments });
        }
      }
      if (message.reasoning_details?.length) input.push(...message.reasoning_details);
      if (message.content) {
        const text = typeof message.content === "string" ? message.content : (message.content as any[]).map((p: any) => p.text).join("");
        if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      }
      continue;
    }
    if (message.role === "user") {
      const parts: any[] = [];
      if (typeof message.content === "string") parts.push({ type: "input_text", text: message.content });
      else for (const item of message.content) {
        if (item.type === "text") parts.push({ type: "input_text", text: item.text });
        else if (item.type === "image_url") parts.push({ type: "input_image", image_url: item.image_url.url, ...(item.image_url.detail ? { detail: item.image_url.detail } : {}) });
      }
      input.push({ role: "user", content: parts });
    }
  }

  if (pending.size) throw new ProxyError("Missing tool response in message history", 400);
  const requested = body.model ?? process.env.DEFAULT_MODEL ?? "gpt-6.1-sol";
  const model = resolveModel(requested);
  const instructionText = instructions.join("\n\n") || "You are a helpful assistant.";
  const cacheKey = body.prompt_cache_key ?? crypto
    .createHash("sha256")
    .update(JSON.stringify([instructionText, tools]))
    .digest("hex");
  const requestedChoice = body.tool_choice;
  let toolChoice: string | { type: "function"; name: string } | undefined;
  if (typeof requestedChoice === "object") {
    toolChoice = { type: "function", name: requestedChoice.function.name };
  } else {
    toolChoice = requestedChoice;
  }
  const effort = (body.reasoning_effort ?? process.env.REASONING_EFFORT ?? "high") as ReasoningEffort;

  const native: any = {
    model,
    instructions: instructionText,
    input,
    store: false,
    stream: true,
    reasoning: { effort },
    prompt_cache_key: cacheKey,
    include: ["reasoning.encrypted_content"],
  };
  if (body.prompt_cache_options) native.prompt_cache_options = body.prompt_cache_options;
  if (tools.length) {
    native.tools = tools;
    native.tool_choice = toolChoice ?? "auto";
    native.parallel_tool_calls = body.parallel_tool_calls ?? true;
  }
  if (body.max_output_tokens || body.max_tokens || body.max_completion_tokens) {
    native.max_output_tokens = body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens;
  }
  if (body.prompt_cache_retention) native.prompt_cache_retention = body.prompt_cache_retention;

  return { native, requested, validators, tools };
}

export async function executeChatCompletion(req: Request, res: Response): Promise<void> {
  let prepared: ReturnType<typeof prepareChat>;
  try {
    prepared = prepareChat(req.body);
  } catch (e: any) {
    const status = e instanceof ProxyError ? e.status : 400;
    const type = e instanceof ProxyError ? e.type : "invalid_request_error";
    res.status(status).json({ error: { message: e.message || "Invalid request", type } });
    return;
  }

  const scope = requestScope(res);
  try {
    const upstreamResp = await upstream("/codex/responses", prepared.native, req, scope.signal, prepared.native.prompt_cache_key);
    if (!upstreamResp.ok) {
      const buffer = await boundedBody(upstreamResp);
      const rejection = upstreamRejection("Codex", upstreamResp.status, providerMessage(buffer.toString("utf8")), upstreamResp.headers.get("retry-after"));
      if (rejection.retryAfter) res.setHeader("Retry-After", rejection.retryAfter);
      res.status(rejection.status).json({ error: { message: rejection.message, type: rejection.type } });
      return;
    }
    const buffer = await boundedBody(upstreamResp, () => scope.reset?.());
    const raw = buffer.toString("utf8");
    let completed: ProviderResponse | null = null;
    const streamedItems: UpstreamOutputItem[] = [];
    if (upstreamResp.headers.get("content-type")?.includes("application/json")) {
      const parsedResponse = providerResponseSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsedResponse.success) throw new Error("Invalid upstream provider response structure");
      completed = parsedResponse.data;
    } else {
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const candidate = JSON.parse(data) as unknown;
        if (!candidate || typeof candidate !== "object" || !("type" in candidate)) {
          throw new Error("Invalid upstream event");
        }
        const eventType = (candidate as { type?: unknown }).type;
        if (typeof eventType !== "string") throw new Error("Invalid upstream event");
        if (!["response.output_item.done", "response.completed", "response.failed", "error"].includes(eventType)) continue;
        const parsedEvent = providerEventSchema.safeParse(candidate);
        if (!parsedEvent.success) throw new Error("Invalid upstream event");
        const event = parsedEvent.data;
        if (event.type === "response.failed" || event.type === "error") throw new Error("Upstream failed");
        if (event.type === "response.output_item.done") streamedItems.push(event.item);
        if (event.type === "response.completed") completed = event.response;
      }
    }
    if (!completed || completed.status !== "completed") throw new Error("Missing completed response");

    let content = "";
    const calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
    const reasoning: UpstreamOutputItem[] = [];
    let refusal: string | null = null;
    const outputList = completed.output.length ? completed.output : streamedItems;

    for (const item of outputList) {
      if (item.type === "message") {
        for (const part of item.content ?? []) {
          if (part.type === "output_text") content += part.text ?? "";
          if (part.type === "refusal") refusal = (refusal ?? "") + (part.refusal ?? part.text ?? "");
        }
      }
      if (item.type === "reasoning") reasoning.push(item);
      if (item.type === "function_call") {
        if (!item.name || !item.call_id || item.arguments === undefined) {
          throw new Error("Invalid upstream tool call");
        }
        const validator = prepared.validators.get(item.name);
        let parsedArgs: unknown;
        try { parsedArgs = JSON.parse(item.arguments) as unknown; }
        catch { throw new Error("Upstream tool arguments were not valid JSON"); }
        if (validator && !validator(parsedArgs)) throw new Error("Upstream tool arguments violated tool schema");
        calls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
      }
    }

    const u = completed.usage;
    const inputTokens = u?.input_tokens ?? 0;
    const outputTokens = u?.output_tokens ?? 0;
    const usage = {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: u?.total_tokens ?? inputTokens + outputTokens,
      prompt_tokens_details: u?.input_tokens_details ?? {},
      completion_tokens_details: u?.output_tokens_details ?? {},
    };

    if (refusal) calls.length = 0;
    const message = {
      role: "assistant",
      content: content || (calls.length ? null : ""),
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(refusal ? { refusal } : {}),
      ...(reasoning.length ? { reasoning_details: reasoning } : {}),
    };
    const base = {
      id: completed.id ?? `chatcmpl-${crypto.randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: prepared.requested,
    };
    const finish = calls.length ? "tool_calls" : "stop";

    if (!req.body.stream) {
      res.json({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");

    const emit = (delta: any, reason: string | null = null) =>
      res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);

    emit({ role: "assistant", content: content || "", ...(refusal ? { refusal } : {}), ...(reasoning.length ? { reasoning_details: reasoning } : {}) });
    calls.forEach((call, index) => emit({ tool_calls: [{ index, ...call }] }));
    emit({}, finish);
    if (req.body.stream_options?.include_usage) {
      res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [], usage })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  } catch {
    scope.abort();
    if (!res.destroyed && !res.headersSent) {
      res.status(502).json({ error: { type: "upstream_error", message: "Upstream response invalid or unavailable" } });
    }
  } finally {
    scope.dispose();
  }
}
