import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { requireBinary } from "./lib/require-binary"
import {
  ensureAuthDir,
  ensurePrivateDir,
  readBounded,
  readCredentialFile,
  parseCredentialJson,
  normalizeAndSave,
  getStatus,
  extractAccountId,
} from "./lib/auth-storage"
import { parsePayload } from "./lib/jwt"
import { tokenWizardInputSchema } from "./schemas/auth.schema"
import type { AuthStatus } from "./types/auth"

interface RunCliOptions {
  browser?: boolean
}

export function runStatus(): AuthStatus {
  return getStatus()
}

export function runImport(source: string): AuthStatus {
  const raw = source === "-" ? readBounded(0) : readCredentialFile(source)
  normalizeAndSave(parseCredentialJson(raw))
  return getStatus()
}

export interface TokenWizardValues {
  access: string
  refresh: string
  expires: string
  accountId: string
}

function parseExpiry(raw: string, access: string): number {
  const value = raw.trim()
  if (value) {
    const numeric = Number(value)
    const parsed = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(value)
    if (!Number.isFinite(parsed) || !Number.isFinite(new Date(parsed).getTime())) {
      throw new Error("Invalid expiry; use ISO date, epoch seconds, or epoch milliseconds")
    }
    return parsed
  }
  if (!access) return 0
  let exp: unknown
  try {
    exp = parsePayload(access).exp
  } catch {
    throw new Error("Expiry is required when access token has no JWT exp claim")
  }
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    throw new Error("Expiry is required when access token has no JWT exp claim")
  }
  return exp * 1000
}

export function runTokenWizardImport(values: TokenWizardValues): AuthStatus {
  // Validate inputs through Zod
  const validated = tokenWizardInputSchema.parse(values)
  const access = validated.access.trim()
  const refresh = validated.refresh.trim()
  const expires = parseExpiry(validated.expires, access)
  const accountId = validated.accountId?.trim() || extractAccountId({ access_token: access })
  normalizeAndSave({
    type: "oauth",
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
  })
  return getStatus()
}

// The official client performs login; abort before any side effect when it is missing.
export function requireLoginBinary(): string {
  return requireBinary("codex", "npm install -g @openai/codex (https://github.com/openai/codex)")
}

export function runLogin(options: RunCliOptions = {}): AuthStatus {
  requireLoginBinary()
  if (
    options.browser &&
    (fs.existsSync("/.dockerenv") ||
      fs.existsSync("/run/.containerenv") ||
      process.env.DOCKER === "1" ||
      process.env.container)
  ) {
    throw new Error("Browser login is not supported in Docker/container; use device auth")
  }
  const authDir = ensureAuthDir()
  const isolatedCodexHome = ensurePrivateDir(path.join(authDir, ".codex"))
  const childEnv: NodeJS.ProcessEnv = {}
  for (const key of [
    "PATH",
    "TERM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key]
  }
  childEnv.CODEX_HOME = isolatedCodexHome
  childEnv.HOME = authDir
  process.stderr.write(
    options.browser
      ? "Browser login: complete the opened authorization page; paste the returned code if Codex asks.\n"
      : "Device login: Codex will print a URL and one-time code. Open the URL on any device and enter that code.\n",
  )
  const proc = spawnSync("codex", options.browser ? ["login"] : ["login", "--device-auth"], {
    stdio: [0, 2, 2],
    env: childEnv,
  })
  if (proc.error) throw new Error("Failed to spawn codex login")
  if (proc.status !== 0) throw new Error(`codex login exited with status ${proc.status}`)
  ensurePrivateDir(isolatedCodexHome)
  normalizeAndSave(parseCredentialJson(readCredentialFile(path.join(isolatedCodexHome, "auth.json"))))
  return getStatus()
}
