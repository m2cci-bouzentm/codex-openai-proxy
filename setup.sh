#!/bin/bash
set -e

echo "=== Codex OpenAI Proxy Setup ==="

# Check if codex is installed
if ! command -v codex &> /dev/null; then
  echo "Installing codex CLI..."
  npm install -g @openai/codex
fi

# Check codex auth
if [ ! -f ~/.codex/auth.json ]; then
  echo ""
  echo "ERROR: ~/.codex/auth.json not found."
  echo "Copy it from your local machine:"
  echo "  scp ~/.codex/auth.json user@this-host:~/.codex/auth.json"
  exit 1
fi

echo "Codex auth: OK"

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
