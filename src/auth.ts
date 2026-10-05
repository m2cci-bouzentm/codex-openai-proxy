import fs from "fs";
import path from "path";
import * as storage from "./storage";
import { parsePayload } from "./jwt";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = `${ISSUER}/oauth/token`;

export { AUTH_FILE, CODEX_CLI_AUTH } from "./storage";

interface CodexCliAuth {
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
  };
}

interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

function extractAccountIdFromClaims(claims: Record<string, unknown>): string | undefined {
  return storage.extractAccountIdFromClaims(claims);
}

function extractAccountId(tokens: { id_token?: string; access_token?: string }): string | undefined {
  return storage.extractAccountId(tokens);
}

function seedFromCodexCli(): storage.OAuthEntry | null {
  if (!fs.existsSync(storage.CODEX_CLI_AUTH)) return null;
  try {
    const raw: CodexCliAuth = JSON.parse(fs.readFileSync(storage.CODEX_CLI_AUTH, "utf-8"));
    const accessClaims = parsePayload(raw.tokens.access_token);
    const entry: storage.OAuthEntry = {
      type: "oauth",
      access: raw.tokens.access_token,
      refresh: raw.tokens.refresh_token,
      expires: ((accessClaims.exp as number) || 0) * 1000,
      accountId: extractAccountId(raw.tokens),
    };
    storage.write(entry);
    return entry;
  } catch {
    return null;
  }
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

let currentAuth: storage.OAuthEntry | null = null;
let lastAuthFileStat: { mtimeMs: number; ino: number; size: number } | null = null;
let refreshPromise: Promise<void> | null = null;

export interface AuthResult {
  accessToken: string;
  accountId: string;
}

function checkAndReloadAuth(): void {
  const authFile = storage.getAuthFile();
  if (fs.existsSync(authFile)) {
    try {
      const stat = fs.statSync(authFile);
      const isChanged =
        !lastAuthFileStat ||
        stat.mtimeMs !== lastAuthFileStat.mtimeMs ||
        stat.ino !== lastAuthFileStat.ino ||
        stat.size !== lastAuthFileStat.size;

      if (isChanged || !currentAuth) {
        const loaded = storage.read();
        if (loaded) {
          currentAuth = loaded;
          lastAuthFileStat = { mtimeMs: stat.mtimeMs, ino: stat.ino, size: stat.size };
        }
      }
    } catch {
      // In case of read/stat collision during atomic rename
    }
  } else if (!currentAuth) {
    // Try seeding from CODEX_CLI_AUTH if canonical auth.json does not exist yet
    currentAuth = seedFromCodexCli();
  }
}

export async function getAuth(): Promise<AuthResult> {
  checkAndReloadAuth();

  if (!currentAuth) {
    throw new Error(`No credentials configured in ${storage.getAuthFile()}`);
  }

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
      storage.write(currentAuth);
      const authFile = storage.getAuthFile();
      if (fs.existsSync(authFile)) {
        const stat = fs.statSync(authFile);
        lastAuthFileStat = { mtimeMs: stat.mtimeMs, ino: stat.ino, size: stat.size };
      }
    })
    .finally(() => { refreshPromise = null; });

  await refreshPromise;
  return { accessToken: currentAuth!.access, accountId: currentAuth!.accountId || "" };
}
