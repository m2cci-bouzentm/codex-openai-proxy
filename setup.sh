#!/bin/bash
set -e

echo "=== Codex OpenAI Proxy Setup ==="

# Check codex CLI auth (used as initial seed)
if [ ! -f ~/.codex/auth.json ]; then
  echo ""
  echo "ERROR: ~/.codex/auth.json not found."
  echo "Run 'codex login' on a machine with a browser, then copy:"
  echo "  scp ~/.codex/auth.json user@this-host:~/.codex/auth.json"
  exit 1
fi

echo "Codex CLI auth: OK (will seed on first run)"

# Check .env
if [ ! -f .env ]; then
  echo "Creating .env with a generated API key..."
  API_KEY="sk-proj-$(openssl rand -hex 24)"
  echo "API_KEY=$API_KEY" > .env
  echo "Generated API_KEY: $API_KEY"
else
  echo ".env: OK"
fi

# Install deps and build
npm install
npm run build

echo ""
echo "=== Ready! Run: npm start ==="
echo "Auth will be stored in ~/.codex-proxy/auth.json (separate from codex CLI)"
