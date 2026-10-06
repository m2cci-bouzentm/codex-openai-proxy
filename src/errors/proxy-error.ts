import type { Response as ExpressResponse } from "express"

// Shared by agy-openai-proxy, claude-ai-proxy and codex-openai-proxy; keep byte-identical.

export type ErrorType =
  | "invalid_request_error"
  | "not_found_error"
  | "rate_limit_error"
  | "upstream_error"
  | "auth_error"
  | "configuration_error"
  | (string & {})

export class ProxyError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly type: ErrorType = status === 429
      ? "rate_limit_error"
      : status < 500
        ? "invalid_request_error"
        : "upstream_error",
    readonly retryAfter?: string,
  ) {
    super(message)
    this.name = "ProxyError"
  }
}

// Sanitized upstream failure that is safe to return to any client.
export class UpstreamError extends ProxyError {
  constructor(message: string, status = 502, type: ErrorType = "upstream_error", retryAfter?: string) {
    super(message, status, type, retryAfter)
    this.name = "UpstreamError"
  }
}

export function invalidRequest(message: string): ProxyError {
  return new ProxyError(`Invalid request: ${message}`)
}

const PROVIDER_MESSAGE_LIMIT = 500
const PROVIDER_BODY_LIMIT = 64 * 1024

export function sanitizeProviderMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const printable = Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127 ? " " : character
  }).join("")
  const clean = printable
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
  if (!clean) return undefined
  return clean.length > PROVIDER_MESSAGE_LIMIT ? `${clean.slice(0, PROVIDER_MESSAGE_LIMIT)}…` : clean
}

// Maps a provider's non-2xx answer to the error the client receives: the
// client's own mistakes keep their status, proxy-side failures become 502.
export function upstreamRejection(
  provider: string,
  status: number,
  providerMessage?: unknown,
  retryAfter?: string | null,
): UpstreamError {
  const detail = sanitizeProviderMessage(providerMessage)
  const suffix = detail ? `: ${detail}` : ""
  if (status === 429)
    return new UpstreamError(
      `${provider} rate limit reached (HTTP 429)${suffix}`,
      429,
      "rate_limit_error",
      retryAfter ?? undefined,
    )
  if (status === 401 || status === 403)
    return new UpstreamError(`${provider} rejected the proxy credentials (HTTP ${status})${suffix}`)
  if (status === 404)
    return new UpstreamError(`${provider} rejected request (HTTP 404)${suffix}`, 404, "not_found_error")
  if (status === 413)
    return new UpstreamError(`${provider} rejected request (HTTP 413)${suffix}`, 413, "invalid_request_error")
  if (status >= 400 && status < 500)
    return new UpstreamError(`${provider} rejected request (HTTP ${status})${suffix}`, 400, "invalid_request_error")
  return new UpstreamError(`${provider} upstream failed (HTTP ${status})${suffix}`)
}

// Extracts only the provider's structured error message; raw bodies never leak.
export function providerMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; detail?: unknown }
    if (typeof parsed.error === "string") return parsed.error
    if (typeof parsed.error?.message === "string") return parsed.error.message
    return typeof parsed.detail === "string" ? parsed.detail : undefined
  } catch {
    return undefined
  }
}

// Reads at most 64 KiB of an error body, then extracts the structured message.
export async function readProviderMessage(response: Response): Promise<string | undefined> {
  const body = response.body
  if (!body) return undefined
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
      if (size >= PROVIDER_BODY_LIMIT) break
    }
    return providerMessage(Buffer.concat(chunks).subarray(0, PROVIDER_BODY_LIMIT).toString("utf8"))
  } catch {
    return undefined
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function normalize(error: unknown): ProxyError {
  if (error instanceof ProxyError) return error
  // Unexpected errors (OAuth state, network) may carry paths or upstream text.
  const timedOut = error instanceof Error && error.name === "AbortError"
  return timedOut
    ? new ProxyError("Upstream request timed out", 504, "upstream_error")
    : new ProxyError("Proxy request failed", 502, "upstream_error")
}

export function openAIErrorBody(error: unknown) {
  const { message, type } = normalize(error)
  return { error: { message, type } }
}

const ANTHROPIC_TYPES: Record<string, string> = {
  upstream_error: "api_error",
  auth_error: "authentication_error",
  configuration_error: "api_error",
}

export function anthropicErrorType(error: ProxyError): string {
  if (error.status === 413) return "request_too_large"
  return ANTHROPIC_TYPES[error.type] ?? error.type
}

export function anthropicErrorBody(error: unknown) {
  const normalized = normalize(error)
  return { type: "error", error: { type: anthropicErrorType(normalized), message: normalized.message } }
}

function send(res: ExpressResponse, error: unknown, body: unknown): void {
  if (res.destroyed || res.headersSent) return
  const normalized = normalize(error)
  if (normalized.retryAfter) res.setHeader("Retry-After", normalized.retryAfter)
  res.status(normalized.status).json(body)
}

export function sendOpenAIError(res: ExpressResponse, error: unknown): void {
  send(res, error, openAIErrorBody(error))
}

export function sendAnthropicError(res: ExpressResponse, error: unknown): void {
  send(res, error, anthropicErrorBody(error))
}
