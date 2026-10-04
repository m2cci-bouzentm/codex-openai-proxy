import crypto from "crypto";
import type { Request, Response } from "express";
import { once } from "events";
import { getAuth } from "./auth";

const MAX_BYTES = 32 * 1024 * 1024;
export function requestScope(res: Response) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const configured=Number(process.env.CODEX_TIMEOUT_MS ?? 120_000);
  const timeout=Number.isFinite(configured)&&configured>0 ? configured : 120_000;
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), timeout); timer.unref(); };
  const close = () => { if (!res.writableEnded) controller.abort(); };
  res.on("close", close); reset();
  return { signal: controller.signal, reset, dispose: () => { clearTimeout(timer); res.off("close", close); }, abort: () => controller.abort() };
}

export async function upstream(path: string, body: unknown, req: Request, signal: AbortSignal, sessionId?: string) {
  const auth = await getAuth();
  const headers: Record<string,string> = {
    Authorization: `Bearer ${auth.accessToken}`, "ChatGPT-Account-Id": auth.accountId,
    "Content-Type": "application/json", Accept: "text/event-stream", originator: "codex_cli_rs",
    "User-Agent": req.get("user-agent") || "codex-proxy/1.0.0", session_id: req.get("session_id") || sessionId || crypto.randomUUID(),
  };
  for (const name of ["originator", "version", "openai-beta", "x-codex-turn-state", "x-codex-beta-features", "x-codex-session-id", "x-client-request-id"]) {
    const value = req.get(name); if (value) headers[name] = value;
  }
  const base = process.env.CODEX_UPSTREAM_BASE_URL || "https://chatgpt.com/backend-api";
  return fetch(base.replace(/\/$/, "") + path, { method: req.method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: "error" });
}

export async function boundedBody(response: globalThis.Response): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length; if (size > MAX_BYTES) throw new Error("Upstream response limit exceeded"); chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function nativeGateway(req: Request, res: Response) {
  const scope = requestScope(res);
  try {
    const suffix = req.url;
    const path = req.path === "/usage" ? "/wham/usage" + suffix.slice(req.path.length) : "/codex" + suffix;
    const response = await upstream(path, req.method === "GET" ? undefined : req.body, req, scope.signal);
    if (res.destroyed) return;
    res.status(response.status);
    for (const [name,value] of response.headers) if (["content-type","retry-after","request-id","x-request-id"].includes(name) || name.startsWith("x-ratelimit-") || name.startsWith("x-codex-")) res.setHeader(name,value);
    if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
      const buffer = await boundedBody(response); res.send(buffer); return;
    }
    res.setHeader("Cache-Control","no-cache"); res.setHeader("X-Accel-Buffering","no");res.flushHeaders();
    if(response.body) for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      scope.reset(); if(res.destroyed) break;
      if(!res.write(Buffer.from(chunk))) await once(res,"drain",{signal:scope.signal});
    }
    if(!res.destroyed)res.end();
  } catch {
    const timedOut=scope.signal.aborted;
    scope.abort(); if(res.destroyed)return;
    if(res.headersSent) { res.end('event: error\ndata: {"type":"error","error":{"message":"Upstream stream interrupted"}}\n\n'); return; }
    res.status(timedOut ? 504 : 502).json({error:{type:"upstream_error",message:"Upstream request failed"}});
  } finally { scope.dispose(); }
}
