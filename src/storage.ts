import fs from "fs";
import path from "path";
import os from "os";
import { parsePayload } from "./jwt";

export function getAuthDir(): string {
  return process.env.PROXY_AUTH_DIR || process.env.CODEX_PROXY_HOME || "/data";
}

export function getAuthFile(): string {
  return path.join(getAuthDir(), "auth.json");
}

// Deprecated alias for backward compatibility
export const AUTH_FILE = getAuthFile();
export const CODEX_CLI_AUTH = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");

export interface OAuthEntry {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export interface AuthStatus {
  configured: boolean;
  type?: string;
  expiresAt?: string;
  isExpired?: boolean;
  accountIdPresent?: boolean;
  accountId?: string;
}

export function ensureAuthDir(): string {
  const dir = getAuthDir();
  const oldUmask = process.umask(0o077);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // Best effort if permissions cannot be modified
      }
    }
  } finally {
    process.umask(oldUmask);
  }
  return dir;
}

export function assertSafeFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const lstat = fs.lstatSync(filePath);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Insecure file path: ${filePath} is a symlink`);
  }
  if (!lstat.isFile()) {
    throw new Error(`Insecure file path: ${filePath} is not a regular file`);
  }
}

export function read(): OAuthEntry | null {
  const file = getAuthFile();
  if (!fs.existsSync(file)) return null;
  assertSafeFile(file);
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.type === "oauth" && typeof parsed.access === "string" && typeof parsed.refresh === "string") {
      return parsed as OAuthEntry;
    }
    return null;
  } catch {
    return null;
  }
}

export function write(entry: OAuthEntry): void {
  const dir = ensureAuthDir();
  const file = getAuthFile();
  assertSafeFile(file);

  const oldUmask = process.umask(0o077);
  const tempFile = path.join(dir, `.auth.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(tempFile, JSON.stringify(entry, null, 2), { mode: 0o600, encoding: "utf-8" });
    fs.chmodSync(tempFile, 0o600);
    fs.renameSync(tempFile, file);
    fs.chmodSync(file, 0o600);
  } finally {
    process.umask(oldUmask);
    if (fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch {}
    }
  }
}

export function extractAccountIdFromClaims(claims: Record<string, unknown>): string | undefined {
  const oa = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return (oa?.chatgpt_account_id as string) ?? (claims["chatgpt_account_id"] as string);
}

export function extractAccountId(tokens: { id_token?: string; access_token?: string }): string | undefined {
  try {
    const idResult = tokens.id_token && extractAccountIdFromClaims(parsePayload(tokens.id_token));
    if (idResult) return idResult;
  } catch {}
  try {
    const accessResult = tokens.access_token && extractAccountIdFromClaims(parsePayload(tokens.access_token));
    if (accessResult) return accessResult;
  } catch {}
  return undefined;
}

export function normalizeAndSave(data: unknown): OAuthEntry {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid credential data: expected JSON object");
  }

  const obj = data as Record<string, any>;

  // Case 1: Native Codex CLI tokens structure {"tokens": {"id_token", "access_token", "refresh_token"}}
  if (obj.tokens && typeof obj.tokens === "object") {
    const { id_token, access_token, refresh_token } = obj.tokens;
    if (!access_token || typeof access_token !== "string" || !refresh_token || typeof refresh_token !== "string") {
      throw new Error("Invalid native Codex credential: empty or missing access_token/refresh_token");
    }

    let exp = 0;
    try {
      const claims = parsePayload(access_token);
      exp = ((claims.exp as number) || 0) * 1000;
    } catch {
      // If unparseable JWT, fallback
    }

    const accountId = extractAccountId(obj.tokens);

    const entry: OAuthEntry = {
      type: "oauth",
      access: access_token,
      refresh: refresh_token,
      expires: exp || (Date.now() + 3600 * 1000),
      ...(accountId ? { accountId } : {})
    };
    write(entry);
    return entry;
  }

  // Case 2: Normalized OAuth {"type":"oauth", "access", "refresh", "expires", "accountId?"}
  if (obj.type === "oauth" || (obj.access && obj.refresh)) {
    if (!obj.access || typeof obj.access !== "string" || !obj.refresh || typeof obj.refresh !== "string") {
      throw new Error("Invalid normalized OAuth credential: empty or missing access/refresh");
    }

    let exp = typeof obj.expires === "number" ? obj.expires : 0;
    if (!exp) {
      try {
        const claims = parsePayload(obj.access);
        exp = ((claims.exp as number) || 0) * 1000;
      } catch {}
    }

    let accountId = obj.accountId;
    if (!accountId) {
      accountId = extractAccountId({ access_token: obj.access });
    }

    const entry: OAuthEntry = {
      type: "oauth",
      access: obj.access,
      refresh: obj.refresh,
      expires: exp || (Date.now() + 3600 * 1000),
      ...(accountId ? { accountId } : {})
    };
    write(entry);
    return entry;
  }

  throw new Error("Invalid credential format: unrecognized schema (expected native Codex tokens or normalized oauth)");
}

export function getStatus(): AuthStatus {
  const entry = read();
  if (!entry) {
    return { configured: false };
  }

  const isExpired = typeof entry.expires === "number" && entry.expires <= Date.now();
  return {
    configured: true,
    type: entry.type || "oauth",
    expiresAt: entry.expires ? new Date(entry.expires).toISOString() : undefined,
    isExpired,
    accountIdPresent: Boolean(entry.accountId),
    ...(entry.accountId ? { accountId: entry.accountId } : {})
  };
}
