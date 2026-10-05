import type { Request, Response } from "express";
import { upstream, boundedBody } from "../lib/codex-client";
import { requestScope } from "../utils/abort";
import { modelsResponseSchema } from "../schemas/provider.schema";
import { executeChatCompletion } from "../services/openai.service";

export async function listModels(req: Request, res: Response): Promise<void> {
  const scope = requestScope(res);
  try {
    const query = new URLSearchParams(req.query as Record<string, string>);
    if (!query.has("client_version")) query.set("client_version", process.env.CODEX_CLIENT_VERSION || "0.157.1");
    const response = await upstream("/codex/models?" + query, undefined, req, scope.signal);
    const buffer = await boundedBody(response);
    if (!response.ok) {
      res.status(response.status).type("application/json").send(buffer);
      return;
    }
    const rawPayload = JSON.parse(buffer.toString());
    const validated = modelsResponseSchema.safeParse(rawPayload);
    if (!validated.success || !Array.isArray(validated.data.models)) {
      throw new Error("Invalid model catalog");
    }
    res.json({
      object: "list",
      data: validated.data.models.map((m) => ({
        id: m.slug,
        object: "model",
        owned_by: "openai",
        context_length: m.context_window,
        name: m.display_name,
      })),
    });
  } catch {
    scope.abort();
    if (!res.destroyed) res.status(502).json({ error: { message: "Model discovery failed", type: "upstream_error" } });
  } finally {
    scope.dispose();
  }
}

export const chatCompletion = executeChatCompletion;
