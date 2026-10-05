import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ensureAuthDir, ensurePrivateDir, readBounded, readCredentialFile, parseCredentialJson, normalizeAndSave, getStatus, AuthStatus } from "./storage";
interface RunCliOptions { browser?: boolean; }
export function runStatus(): AuthStatus { return getStatus(); }
export function runImport(source: string): AuthStatus {
  const raw = source === "-" ? readBounded(0) : readCredentialFile(source);
  normalizeAndSave(parseCredentialJson(raw)); return getStatus();
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
