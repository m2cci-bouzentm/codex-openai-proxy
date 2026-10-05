import type { Request, Response } from "express";
import { upstream, boundedBody } from "../lib/codex-client";
import { requestScope } from "../utils/abort";
import { modelsResponseSchema } from "../schemas/provider.schema";
import { anthropicModelsQueryContractSchema } from "../schemas/contracts.schema";
import { anthropicMessages as executeAnthropicMessages, anthropicError } from "../services/anthropic.service";

export async function listAnthropicModels(req: Request, res: Response): Promise<void> {
  const queryResult = anthropicModelsQueryContractSchema.safeParse(req.query);
  if (!queryResult.success) {
    anthropicError(res, 400, "invalid_request_error", "Invalid model query");
    return;
  }
  const params = queryResult.data;
  const scope = requestScope(res);
  try {
    const limit = params.limit ?? 20;
    const query = new URLSearchParams();
    query.set("client_version", process.env.CODEX_CLIENT_VERSION || "0.157.1");
    const response = await upstream("/codex/models?" + query, undefined, req, scope.signal);
    const buffer = await boundedBody(response);
    if (!response.ok) {
      anthropicError(res, response.status, "api_error", "Upstream model list failed");
      return;
    }
    const rawPayload = JSON.parse(buffer.toString());
    const validated = modelsResponseSchema.safeParse(rawPayload);
    if (!validated.success || !Array.isArray(validated.data.models)) {
      throw new Error("Invalid model catalog");
    }
    const all = validated.data.models.map((m) => ({
      type: "model",
      id: m.slug,
      display_name: m.display_name,
      created_at: "2024-01-01T00:00:00Z",
    }));

    let data = all;
    if (params.after_id) {
      const idx = all.findIndex((m) => m.id === params.after_id);
      if (idx >= 0) data = all.slice(idx + 1);
    }
    if (params.before_id) {
      const idx = all.findIndex((m) => m.id === params.before_id);
      if (idx >= 0) {
        const preceding = all.slice(0, idx);
        const has_more = preceding.length > limit;
        const page = preceding.slice(-limit);
        res.json({
          data: page,
          has_more,
          first_id: page[0]?.id || null,
          last_id: page.at(-1)?.id || null,
        });
        return;
      }
    }
    const has_more = data.length > limit;
    const page = data.slice(0, limit);
    res.json({
      data: page,
      has_more,
      first_id: page[0]?.id || null,
      last_id: page.at(-1)?.id || null,
    });
  } catch {
    scope.abort();
    if (!res.destroyed) anthropicError(res, 502, "api_error", "Model discovery failed");
  } finally {
    scope.dispose();
  }
}

export const anthropicMessages = executeAnthropicMessages;
export const anthropicModels = listAnthropicModels;
export { anthropicAuth } from "../middleware/auth";
