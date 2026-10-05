import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import {
  getAuthDir,
  getAuthFile,
  ensureAuthDir,
  normalizeAndSave,
  getStatus,
  read,
  AuthStatus
} from "./storage";

interface RunCliOptions {
  browser?: boolean;
}

export function runStatus(): AuthStatus {
  return getStatus();
}

export function runImport(source: string): AuthStatus {
  let content = "";
  if (source === "-") {
    content = fs.readFileSync(0, "utf-8");
  } else {
    if (!fs.existsSync(source)) {
      throw new Error(`Import file not found: ${source}`);
    }
    const lstat = fs.lstatSync(source);
    if (lstat.isSymbolicLink()) {
      throw new Error(`Insecure file: ${source} is a symbolic link`);
    }
    content = fs.readFileSync(source, "utf-8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err: any) {
    throw new Error(`Failed to parse import JSON: ${err.message}`);
  }

  normalizeAndSave(parsed);
  return getStatus();
}

export function runLogin(options: RunCliOptions = {}): AuthStatus {
  const authDir = ensureAuthDir();
  const isolatedCodexHome = path.join(authDir, ".codex");
  if (!fs.existsSync(isolatedCodexHome)) {
    fs.mkdirSync(isolatedCodexHome, { recursive: true, mode: 0o700 });
  }

  // CLI executable: 'codex'
  const args = ["login"];
  if (!options.browser) {
    args.push("--device-auth");
  }

  const childEnv = {
    ...process.env,
    CODEX_HOME: isolatedCodexHome,
    HOME: authDir,
  };

  // Route stdout to stderr so interactive prompts do not corrupt JSON envelope on stdout
  const proc = spawnSync("codex", args, {
    stdio: [0, 2, 2],
    env: childEnv,
  });

  if (proc.error) {
    throw new Error(`Failed to spawn codex login: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    throw new Error(`codex login exited with status ${proc.status}`);
  }

  // Look for generated credentials in isolatedCodexHome/auth.json
  const generatedAuth = path.join(isolatedCodexHome, "auth.json");
  if (!fs.existsSync(generatedAuth)) {
    throw new Error(`Expected login credentials at ${generatedAuth} not found after login`);
  }

  const raw = fs.readFileSync(generatedAuth, "utf-8");
  const parsed = JSON.parse(raw);
  normalizeAndSave(parsed);

  return getStatus();
}
