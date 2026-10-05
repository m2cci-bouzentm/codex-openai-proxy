import type { Response } from "express";
import { config } from "../config";
import type { RequestCancellation } from "../types/http";

export function createRequestCancellation(res: Response): RequestCancellation {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const configured = Number(process.env.CODEX_TIMEOUT_MS ?? config.timeoutMs);
  const timeout = Number.isFinite(configured) && configured > 0 ? configured : 120_000;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeout);
    timer.unref();
  };
  const close = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", close);
  reset();
  return {
    signal: controller.signal,
    reset,
    dispose: () => {
      clearTimeout(timer);
      res.off("close", close);
    },
    abort: () => controller.abort(),
  };
}

export const requestScope = createRequestCancellation;
