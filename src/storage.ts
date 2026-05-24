import fs from "fs";
import path from "path";
import os from "os";

const AUTH_DIR = process.env.CODEX_PROXY_HOME || path.join(os.homedir(), ".codex-proxy");
export const AUTH_FILE = path.join(AUTH_DIR, "auth.json");
const CODEX_CLI_AUTH = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");

export interface OAuthEntry {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
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

export function extractAccountId(tokens: { id_token?: string; access_token?: string }): string | undefined {
  const idResult = tokens.id_token && extractAccountIdFromClaims(parseJwtPayload(tokens.id_token));
  return idResult ?? (tokens.access_token && extractAccountIdFromClaims(parseJwtPayload(tokens.access_token))) ?? undefined;
}

export function read(): OAuthEntry | null {
  if (!fs.existsSync(AUTH_FILE)) return null;
  return JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
}

export function write(entry: OAuthEntry) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(entry, null, 2), { mode: 0o600 });
}

export function seedFromCodexCli(): OAuthEntry {
  const raw: CodexCliAuth = JSON.parse(fs.readFileSync(CODEX_CLI_AUTH, "utf-8"));
  const accessClaims = parseJwtPayload(raw.tokens.access_token);
  const entry: OAuthEntry = {
    type: "oauth",
    access: raw.tokens.access_token,
    refresh: raw.tokens.refresh_token,
    expires: ((accessClaims.exp as number) || 0) * 1000,
    accountId: extractAccountId(raw.tokens),
  };
  write(entry);
  return entry;
}
