import { z } from "zod"

export const envConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3033),
  API_KEY: z.string().optional(),
  CODEX_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  CODEX_UPSTREAM_BASE_URL: z.string().url().default("https://chatgpt.com/backend-api"),
  CODEX_CLIENT_VERSION: z.string().default("0.157.1"),
  PROXY_AUTH_DIR: z.string().optional(),
  CODEX_PROXY_HOME: z.string().optional(),
  CODEX_HOME: z.string().optional(),
  MODEL_ALIASES: z.string().optional(),
  DEFAULT_MODEL: z.string().default("gpt-6.1-sol"),
})

export type EnvConfig = z.infer<typeof envConfigSchema>
