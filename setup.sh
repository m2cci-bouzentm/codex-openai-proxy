#!/bin/bash
set -e

echo "=== Codex OpenAI Proxy Setup ==="

# Check auth.json
if [ ! -f ~/.codex/auth.json ]; then
  echo ""
  echo "ERROR: ~/.codex/auth.json not found."
  echo "Run 'codex login' on a machine with a browser, then copy:"
  echo "  scp ~/.codex/auth.json user@this-host:~/.codex/auth.json"
  exit 1
fi

echo "Auth: OK"

# Check .env
if [ ! -f .env ]; then
  echo "Creating .env with a generated API key..."
  API_KEY="sk-proj-$(openssl rand -hex 24)"
  echo "API_KEY=$API_KEY" > .env
  echo "Generated API_KEY: $API_KEY"
else
  echo ".env: OK"
fi

# Install deps
npm install --omit=dev

echo ""
echo "=== Ready! Run: npm start ==="
