import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ensureAuthDir, ensurePrivateDir, readBounded, readCredentialFile, parseCredentialJson, normalizeAndSave, getStatus, extractAccountId, AuthStatus } from "./storage";
import { parsePayload } from "./jwt";
interface RunCliOptions { browser?: boolean; }
export function runStatus(): AuthStatus { return getStatus(); }
export function runImport(source: string): AuthStatus {
  const raw = source === "-" ? readBounded(0) : readCredentialFile(source);
  normalizeAndSave(parseCredentialJson(raw)); return getStatus();
}
export interface TokenWizardValues { access: string; refresh: string; expires: string; accountId: string; }
function parseExpiry(raw: string, access: string): number {
  const value = raw.trim();
  if (value) {
    const numeric = Number(value);
    const parsed = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(value);
    if (!Number.isFinite(parsed) || !Number.isFinite(new Date(parsed).getTime())) throw new Error("Invalid expiry; use ISO date, epoch seconds, or epoch milliseconds");
    return parsed;
  }
  if (!access) return 0;
  let exp: unknown;
  try { exp = parsePayload(access).exp; }
  catch { throw new Error("Expiry is required when access token has no JWT exp claim"); }
  if (typeof exp !== "number" || !Number.isFinite(exp)) throw new Error("Expiry is required when access token has no JWT exp claim");
  return exp * 1000;
}
export function runTokenWizardImport(values: TokenWizardValues): AuthStatus {
  const access = values.access.trim(), refresh = values.refresh.trim();
  const expires = parseExpiry(values.expires, access);
  const accountId = values.accountId.trim() || extractAccountId({ access_token: access });
  normalizeAndSave({ type: "oauth", access, refresh, expires, ...(accountId ? { accountId } : {}) });
  return getStatus();
}
export function runLogin(options: RunCliOptions = {}): AuthStatus {
  if (options.browser && (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv") || process.env.DOCKER === "1" || process.env.container)) throw new Error("Browser login is not supported in Docker/container; use device auth");
  const authDir = ensureAuthDir();
  const isolatedCodexHome = ensurePrivateDir(path.join(authDir, ".codex"));
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }
  childEnv.CODEX_HOME = isolatedCodexHome; childEnv.HOME = authDir;
  const proc = spawnSync("codex", options.browser ? ["login"] : ["login", "--device-auth"], { stdio: [0, 2, 2], env: childEnv });
  if (proc.error) throw new Error("Failed to spawn codex login");
  if (proc.status !== 0) throw new Error(`codex login exited with status ${proc.status}`);
  ensurePrivateDir(isolatedCodexHome);
  normalizeAndSave(parseCredentialJson(readCredentialFile(path.join(isolatedCodexHome, "auth.json"))));
  return getStatus();
}
