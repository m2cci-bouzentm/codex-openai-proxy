import fs from "fs";
import * as storage from "./storage";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export { AUTH_FILE, CODEX_CLI_AUTH } from "./storage";

interface TokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}
interface Snapshot {
  source: string;
  generation: string;
  entry: storage.OAuthEntry;
}
export interface AuthResult { accessToken: string; accountId: string; }

let currentAuth: Snapshot | null = null;
let canonicalSeen = false;
const refreshes = new Map<string, Promise<void>>();

// Include bytes as well as inode/timestamps: in-place edits may retain size/mtime.
function fingerprint(source: string): string {
  storage.ensureAuthDir();
  const before = fs.lstatSync(source);
  const raw = storage.readCredentialFile(source);
  const after = fs.lstatSync(source);
  const identity = (stat: fs.Stats) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  if (identity(before) !== identity(after)) throw new Error("Credentials changed while reading");
  return `${source}\n${identity(after)}\n${raw}`;
}

function loadCanonical(): Snapshot | null {
  const source = storage.getAuthFile();
  try {
    const generation = fingerprint(source);
    const entry = storage.read();
    if (!entry || fingerprint(source) !== generation) return null;
    return { source, generation, entry };
  } catch { return null; }
}

function checkAndReloadAuth(): void {
  const source = storage.getAuthFile();
  let missing = false;
  try { fs.lstatSync(source); canonicalSeen = true; }
  catch (err: any) { missing = err.code === "ENOENT"; if (!missing) canonicalSeen = true; }
  currentAuth = loadCanonical();
  if (currentAuth || canonicalSeen || !missing) return;
  try {
    // Use storage's bounded, no-follow reader and native schema/JWT parser.
    const native = storage.parseCredentialJson(storage.readCredentialFile(storage.CODEX_CLI_AUTH));
    if (!native || typeof native !== "object" || !("tokens" in native)) return;
    storage.normalizeAndSave(native);
    canonicalSeen = true;
    currentAuth = loadCanonical();
  } catch { currentAuth = null; }
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID }).toString(),
  });
  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);
  return await resp.json() as TokenResponse;
}

function unchanged(snapshot: Snapshot): boolean {
  if (storage.getAuthFile() !== snapshot.source) return false;
  try { return fingerprint(snapshot.source) === snapshot.generation; }
  catch { return false; }
}

export async function getAuth(): Promise<AuthResult> {
  checkAndReloadAuth();
  const snapshot = currentAuth;
  if (!snapshot) throw new Error(`No credentials configured in ${storage.getAuthFile()}`);
  const entry = snapshot.entry;
  if (entry.access && entry.expires > Date.now()) return { accessToken: entry.access, accountId: entry.accountId || "" };
  if (!entry.refresh) throw new Error("Credentials expired and no refresh token configured");

  let pending = refreshes.get(snapshot.generation);
  if (!pending) {
    pending = (async () => {
      let tokens: TokenResponse;
      try { tokens = await refreshAccessToken(entry.refresh); }
      catch (error) { if (!unchanged(snapshot)) return; throw error; }
      // Never save a response for a deleted/replaced/invalid credential generation.
      if (!unchanged(snapshot)) return;
      if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error("Invalid refreshed credentials");
      const updated: storage.OAuthEntry = {
        ...entry,
        access: tokens.access_token,
        refresh: tokens.refresh_token || entry.refresh,
        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        accountId: storage.extractAccountId(tokens) || entry.accountId,
      };
      storage.write(updated);
      // Read normalized disk entry, never cache pre-normalization metadata/stat.
      currentAuth = loadCanonical();
    })().finally(() => { refreshes.delete(snapshot.generation); });
    refreshes.set(snapshot.generation, pending);
  }
  await pending;
  // A concurrent import may need its own refresh; never return the old response.
  return getAuth();
}
