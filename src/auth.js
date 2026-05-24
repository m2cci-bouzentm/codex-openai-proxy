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

function extractAccountId(claims) {
  const oa = claims["https://api.openai.com/auth"] || {};
  return oa.chatgpt_account_id || oa.organization_id || (oa.organizations?.[0]?.id) || "";
}

function loadTokens() {
  const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
  const idClaims = parseJwtPayload(raw.tokens.id_token);
  const accessClaims = parseJwtPayload(raw.tokens.access_token);
  return {
    accessToken: raw.tokens.access_token,
    refreshToken: raw.tokens.refresh_token,
    accountId: extractAccountId(idClaims),
    expiresAt: (accessClaims.exp || 0) * 1000,
  };
}

function persistTokens(tokens) {
  const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
  raw.tokens.id_token = tokens.id_token;
  raw.tokens.access_token = tokens.access_token;
  if (tokens.refresh_token) raw.tokens.refresh_token = tokens.refresh_token;
  fs.writeFileSync(AUTH_FILE, JSON.stringify(raw, null, 2));
}

async function refreshTokens(refreshToken) {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);
  return resp.json();
}

let cached = null;
let refreshPromise = null;

async function getAuth() {
  if (!cached) cached = loadTokens();
  if (Date.now() < cached.expiresAt - 60_000) return cached;
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const tokens = await refreshTokens(cached.refreshToken);
    persistTokens(tokens);
    cached = loadTokens();
    return cached;
  })().finally(() => { refreshPromise = null; });

  return refreshPromise;
}

module.exports = { getAuth, AUTH_FILE };
