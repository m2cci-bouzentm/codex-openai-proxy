import fs from "fs";
import path from "path";
import os from "os";

const AUTH_DIR = process.env.CODEX_PROXY_HOME || path.join(os.homedir(), ".codex-proxy");
export const AUTH_FILE = path.join(AUTH_DIR, "auth.json");
export const CODEX_CLI_AUTH = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");

export interface OAuthEntry {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export function read(): OAuthEntry | null {
  if (!fs.existsSync(AUTH_FILE)) return null;
  return JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
}

export function write(entry: OAuthEntry) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(entry, null, 2), { mode: 0o600 });
}
