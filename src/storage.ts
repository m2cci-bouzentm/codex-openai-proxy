import fs from "fs";
import path from "path";
import os from "os";
import { randomBytes } from "crypto";
import { parsePayload } from "./jwt";

export const MAX_AUTH_BYTES = 64 * 1024;
export function getAuthDir(): string { return process.env.PROXY_AUTH_DIR || process.env.CODEX_PROXY_HOME || "/data"; }
export function getAuthFile(): string { return path.join(getAuthDir(), "auth.json"); }
export const AUTH_FILE = getAuthFile();
export const CODEX_CLI_AUTH = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");
export interface OAuthEntry {
  type: "oauth"; access: string; refresh: string; expires: number;
  accountId?: string | null; subscriptionType?: string | null; rateLimitTier?: string | null; scopes?: string[];
}
export interface AuthStatus {
  configured: boolean; type?: string; provider?: string; expiresAt?: string;
  isExpired?: boolean; accessPresent?: boolean; refreshPresent?: boolean;
  accountIdPresent?: boolean; subscriptionType?: string | null; rateLimitTier?: string | null;
}
export function ensurePrivateDir(dir: string): string {
  const resolved = path.resolve(dir);
  // Reject symlinks in every existing path component, including dangling links.
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
      fs.mkdirSync(current, { mode: 0o700 }); stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) throw new Error("Insecure directory: symlink");
    if (!stat.isDirectory()) throw new Error("Insecure directory: not a directory");
  }
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
  try {
    const stat = fs.fstatSync(fd);
    if (process.getuid && stat.uid !== process.getuid()) throw new Error("Insecure directory owner");
    fs.fchmodSync(fd, 0o700);
    const verified = fs.fstatSync(fd);
    if ((verified.mode & 0o777) !== 0o700) throw new Error("Insecure directory permissions");
  } finally { fs.closeSync(fd); }
  return dir;
}
export function ensureAuthDir(): string { return ensurePrivateDir(getAuthDir()); }
export function assertSafeFile(filePath: string): void {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (err: any) { if (err.code === "ENOENT") return; throw err; }
  if (stat.isSymbolicLink()) throw new Error("Insecure file: symlink");
  if (!stat.isFile()) throw new Error("Insecure file: not a regular file");
}
export function readBounded(fd: number): string {
  const chunks: Buffer[] = []; let size = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(4096, MAX_AUTH_BYTES + 1 - size));
    const count = fs.readSync(fd, chunk, 0, chunk.length, null);
    if (!count) break;
    size += count;
    if (size > MAX_AUTH_BYTES) throw new Error("Credential size exceeds 64 KiB limit");
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function readCredentialFile(file: string): string {
  assertSafeFile(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Credential file must be regular");
    if (stat.size > MAX_AUTH_BYTES) throw new Error("Credential size exceeds 64 KiB limit");
    return readBounded(fd);
  } finally { fs.closeSync(fd); }
}
export function parseCredentialJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { throw new Error("Invalid credential JSON"); }
}
function record(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
function expiry(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && Number.isFinite(new Date(value).getTime()); }
function canonical(obj: Record<string, any>): OAuthEntry {
  if (obj.type !== "oauth") throw new Error("Invalid credential schema");
  for (const key of ["access", "refresh"]) if (obj[key] !== undefined && typeof obj[key] !== "string") throw new Error("Invalid credential tokens");
  const access = obj.access ?? "", refresh = obj.refresh ?? "";
  if (!access && !refresh) throw new Error("Invalid credential: missing tokens");
  if (obj.expires !== undefined && !expiry(obj.expires)) throw new Error("Invalid credential expiry");
  if (access && !expiry(obj.expires)) throw new Error("Invalid credential expiry");
  for (const key of ["accountId", "subscriptionType", "rateLimitTier"]) {
    if (obj[key] !== undefined && obj[key] !== null && typeof obj[key] !== "string") throw new Error("Invalid credential metadata");
  }
  if (obj.scopes !== undefined && (!Array.isArray(obj.scopes) || !obj.scopes.every((v: unknown) => typeof v === "string"))) throw new Error("Invalid credential scopes");
  const result: OAuthEntry = { type: "oauth", access, refresh, expires: access ? obj.expires : 0 };
  for (const key of ["accountId", "subscriptionType", "rateLimitTier", "scopes"] as const) if (obj[key] !== undefined) (result as any)[key] = obj[key];
  if (result.accountId === undefined && access) result.accountId = extractAccountId({ access_token: access });
  return result;
}
export function read(): OAuthEntry | null {
  try { ensureAuthDir(); return canonical(parseCredentialJson(readCredentialFile(getAuthFile())) as Record<string, any>); }
  catch { return null; }
}
export function write(entry: OAuthEntry): void {
  const valid = canonical(entry);
  const dir = ensureAuthDir(), file = getAuthFile(); assertSafeFile(file);
  const temp = path.join(dir, `.auth.json.tmp.${randomBytes(16).toString("hex")}`);
  let owned = false;
  try {
    const fd = fs.openSync(temp, "wx", 0o600); owned = true;
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(valid, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    assertSafeFile(file); fs.renameSync(temp, file); owned = false;
  } finally { if (owned) fs.unlinkSync(temp); }
}
export function extractAccountIdFromClaims(claims: Record<string, unknown>): string | undefined {
  const nested = claims["https://api.openai.com/auth"];
  const value = (record(nested) ? nested.chatgpt_account_id : undefined) ?? claims.chatgpt_account_id;
  return typeof value === "string" ? value : undefined;
}
export function extractAccountId(tokens: { id_token?: string; access_token?: string }): string | undefined {
  for (const token of [tokens.id_token, tokens.access_token]) {
    try { if (token) { const id = extractAccountIdFromClaims(parsePayload(token)); if (id) return id; } } catch {}
  }
  return undefined;
}
export function normalizeAndSave(data: unknown): OAuthEntry {
  if (!record(data)) throw new Error("Invalid credential schema");
  let entry: OAuthEntry;
  if (record(data.tokens)) {
    const t = data.tokens;
    if (typeof t.access_token !== "string" || !t.access_token || typeof t.refresh_token !== "string" || !t.refresh_token) throw new Error("Invalid native Codex tokens");
    const claims = parsePayload(t.access_token);
    if (typeof claims.exp !== "number" || !expiry(claims.exp * 1000)) throw new Error("Invalid native credential expiry");
    if (t.id_token !== undefined && typeof t.id_token !== "string") throw new Error("Invalid native ID token");
    entry = canonical({ type: "oauth", access: t.access_token, refresh: t.refresh_token, expires: claims.exp * 1000, accountId: extractAccountId(t) });
  } else { entry = canonical(data); }
  write(entry); return entry;
}
export function getStatus(): AuthStatus {
  const entry = read();
  if (!entry) return { configured: false };
  return { configured: true, type: "oauth", provider: "openai", expiresAt: new Date(entry.expires).toISOString(), isExpired: entry.expires <= Date.now(), accessPresent: !!entry.access, refreshPresent: !!entry.refresh, accountIdPresent: !!entry.accountId, subscriptionType: entry.subscriptionType ?? null, rateLimitTier: entry.rateLimitTier ?? null };
}
