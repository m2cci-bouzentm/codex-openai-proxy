import crypto from "crypto";
import type { Request, Response } from "express";
import { getAuth } from "../services/auth.service";
import { config } from "../config";

const MAX_BYTES = 32 * 1024 * 1024;

export async function upstream(path: string, body: unknown, req: Request, signal: AbortSignal, sessionId?: string) {
  const auth = await getAuth();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    "ChatGPT-Account-Id": auth.accountId,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    originator: "codex_cli_rs",
    "User-Agent": req.get("user-agent") || "codex-proxy/1.0.0",
    session_id: req.get("session_id") || sessionId || crypto.randomUUID(),
  };
  for (const name of [
    "originator",
    "version",
    "openai-beta",
    "x-codex-turn-state",
    "x-codex-beta-features",
    "x-codex-session-id",
    "x-client-request-id",
  ]) {
    const value = req.get(name);
    if (value) headers[name] = value;
  }
  const base = process.env.CODEX_UPSTREAM_BASE_URL || config.upstreamBaseUrl || "https://chatgpt.com/backend-api";
  return fetch(base.replace(/\/$/, "") + path, {
    method: req.method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    redirect: "error",
  });
}

export async function boundedBody(response: globalThis.Response, onChunk?: () => void): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      onChunk?.();
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error("Upstream response limit exceeded");
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks);
}
