const fs = require("fs");
const path = require("path");
const os = require("os");

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = `${ISSUER}/oauth/token`;
const AUTH_FILE = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");

function parseJwtPayload(token) {
  return JSON.parse(Buffer.from(token.split(".")[1] + "==", "base64url").toString());
}

function extractAccountId(tokens) {
  for (const key of ["id_token", "access_token"]) {
    if (!tokens[key]) continue;
    const claims = parseJwtPayload(tokens[key]);
    const oa = claims["https://api.openai.com/auth"] || {};
    const id = oa.chatgpt_account_id || oa.organization_id || oa.organizations?.[0]?.id;
    if (id) return id;
  }
  return "";
}

function loadFromDisk() {
  const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
  const accessClaims = parseJwtPayload(raw.tokens.access_token);
  return {
    access: raw.tokens.access_token,
    refresh: raw.tokens.refresh_token,
    accountId: extractAccountId(raw.tokens),
    expires: (accessClaims.exp || 0) * 1000,
  };
}

function persistToDisk(tokens) {
  const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
  raw.tokens.id_token = tokens.id_token;
  raw.tokens.access_token = tokens.access_token;
  if (tokens.refresh_token) raw.tokens.refresh_token = tokens.refresh_token;
  fs.writeFileSync(AUTH_FILE, JSON.stringify(raw, null, 2));
}

async function refreshAccessToken(refreshToken) {
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

let currentAuth = null;
let refreshPromise = null;

async function getAuth() {
  if (!currentAuth) {
    currentAuth = loadFromDisk();
  }

  if (!currentAuth.access || currentAuth.expires < Date.now()) {
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken(currentAuth.refresh)
        .then((tokens) => {
          const accountId = extractAccountId(tokens) || currentAuth.accountId;
          persistToDisk(tokens);
          currentAuth = {
            access: tokens.access_token,
            refresh: tokens.refresh_token || currentAuth.refresh,
            accountId,
            expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          };
          return currentAuth;
        })
        .finally(() => { refreshPromise = null; });
    }
    await refreshPromise;
  }

  return {
    accessToken: currentAuth.access,
    refreshToken: currentAuth.refresh,
    accountId: currentAuth.accountId,
  };
}

module.exports = { getAuth, AUTH_FILE };
