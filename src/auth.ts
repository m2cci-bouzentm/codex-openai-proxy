import * as storage from "./storage";
import { extractAccountId } from "./jwt";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = `${ISSUER}/oauth/token`;

export { AUTH_FILE } from "./storage";

interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
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
  currentAuth ??= storage.read() ?? storage.seedFromCodexCli();

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
