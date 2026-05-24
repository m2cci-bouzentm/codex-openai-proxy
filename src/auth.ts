import fs from "fs";
import * as storage from "./storage";
import { parsePayload } from "./jwt";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = `${ISSUER}/oauth/token`;

export { AUTH_FILE } from "./storage";

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
  const oa = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return (oa?.chatgpt_account_id as string) ?? (claims["chatgpt_account_id"] as string);
}

function extractAccountId(tokens: { id_token?: string; access_token?: string }): string | undefined {
  const idResult = tokens.id_token && extractAccountIdFromClaims(parsePayload(tokens.id_token));
  return idResult ?? (tokens.access_token && extractAccountIdFromClaims(parsePayload(tokens.access_token))) ?? undefined;
}

function seedFromCodexCli(): storage.OAuthEntry {
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
let refreshPromise: Promise<void> | null = null;

export interface AuthResult {
  accessToken: string;
  accountId: string;
}

export async function getAuth(): Promise<AuthResult> {
  currentAuth ??= storage.read() ?? seedFromCodexCli();

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
    })
    .finally(() => { refreshPromise = null; });

  await refreshPromise;
  return { accessToken: currentAuth!.access, accountId: currentAuth!.accountId || "" };
}
