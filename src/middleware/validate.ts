import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { ProxyError } from "../errors/proxy-error";

export function validateBody<T>(schema: ZodType<T>, isAnthropic = false): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      if (isAnthropic || req.path.startsWith("/anthropic/")) {
        res.status(400).json({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `Invalid request: ${details}`,
          },
        });
        return;
      }
      res.status(400).json({
        error: {
          type: "invalid_request_error",
          message: `Invalid request: ${details}`,
        },
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
