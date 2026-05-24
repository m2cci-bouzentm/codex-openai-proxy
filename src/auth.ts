import fs from "fs";
import path from "path";
import os from "os";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = `${ISSUER}/oauth/token`;

const AUTH_DIR = process.env.CODEX_PROXY_HOME || path.join(os.homedir(), ".codex-proxy");
export const AUTH_FILE = path.join(AUTH_DIR, "auth.json");
const CODEX_CLI_AUTH = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");

interface OAuthEntry {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

interface CodexCliAuth {
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
  };
}

function parseJwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] + "==", "base64url").toString());
}

function extractAccountIdFromClaims(claims: Record<string, unknown>): string | undefined {
  const oa = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return (oa?.chatgpt_account_id as string) ?? (claims["chatgpt_account_id"] as string);
}

function extractAccountId(tokens: { id_token?: string; access_token?: string }): string | undefined {
  const idResult = tokens.id_token && extractAccountIdFromClaims(parseJwtPayload(tokens.id_token));
  return idResult ?? (tokens.access_token && extractAccountIdFromClaims(parseJwtPayload(tokens.access_token))) ?? undefined;
}

function ensureDir() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
}

function readAuth(): OAuthEntry | null {
  if (fs.existsSync(AUTH_FILE)) return JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
  return null;
}

function writeAuth(entry: OAuthEntry) {
  ensureDir();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(entry, null, 2), { mode: 0o600 });
}

function seedFromCodexCli(): OAuthEntry {
  const raw: CodexCliAuth = JSON.parse(fs.readFileSync(CODEX_CLI_AUTH, "utf-8"));
  const accessClaims = parseJwtPayload(raw.tokens.access_token);
  const entry: OAuthEntry = {
    type: "oauth",
    access: raw.tokens.access_token,
    refresh: raw.tokens.refresh_token,
    expires: ((accessClaims.exp as number) || 0) * 1000,
    accountId: extractAccountId(raw.tokens),
  };
  writeAuth(entry);
  return entry;
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);
  return resp.json();
}

let currentAuth: OAuthEntry | null = null;
let refreshPromise: Promise<void> | null = null;

export interface AuthResult {
  accessToken: string;
  accountId: string;
}

export async function getAuth(): Promise<AuthResult> {
  currentAuth ??= readAuth() ?? seedFromCodexCli();

  const needsRefresh = !currentAuth.access || currentAuth.expires < Date.now();
  if (!needsRefresh) return { accessToken: currentAuth.access, accountId: currentAuth.accountId || "" };

  refreshPromise ??= refreshAccessToken(currentAuth.refresh)
    .then((tokens) => {
      currentAuth = {
        type: "oauth",
        access: tokens.access_token,
        refresh: tokens.refresh_token || currentAuth!.refresh,
        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        accountId: extractAccountId(tokens) || currentAuth!.accountId,
      };
      writeAuth(currentAuth);
    })
    .finally(() => { refreshPromise = null; });

  await refreshPromise;
  return { accessToken: currentAuth!.access, accountId: currentAuth!.accountId || "" };
}
