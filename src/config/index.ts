import "dotenv/config";
import { envConfigSchema } from "../schemas/config.schema";

const parsed = envConfigSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
  throw new Error(`Configuration error: ${issues}`);
}

export const config = {
  port: parsed.data.PORT,
  apiKey: parsed.data.API_KEY,
  timeoutMs: parsed.data.CODEX_TIMEOUT_MS,
  upstreamBaseUrl: parsed.data.CODEX_UPSTREAM_BASE_URL,
  clientVersion: parsed.data.CODEX_CLIENT_VERSION,
  proxyAuthDir: parsed.data.PROXY_AUTH_DIR,
  codexProxyHome: parsed.data.CODEX_PROXY_HOME,
  codexHome: parsed.data.CODEX_HOME,
  modelAliases: parsed.data.MODEL_ALIASES,
  defaultModel: parsed.data.DEFAULT_MODEL,
} as const;
