#!/bin/bash
set -euo pipefail

SSH_CMD="${1:?Usage: ./deploy-auth.sh 'ssh -i ~/.ssh/key user@host'}"
LOCAL_AUTH="$HOME/.codex/auth.json"

echo "=== Codex Proxy Auth Deploy ==="

echo "[1/3] Logging into Codex CLI..."
codex login

if [ ! -f "$LOCAL_AUTH" ]; then
  echo "ERROR: $LOCAL_AUTH not found after login. Aborting."
  exit 1
fi

echo "[2/3] Uploading auth to VPS..."
REMOTE=$(echo "$SSH_CMD" | grep -oE '[^ ]+@[^ ]+')
SSH_OPTS=$(echo "$SSH_CMD" | sed "s|ssh ||; s|$REMOTE||")
$SSH_CMD "mkdir -p ~/.codex"
scp $SSH_OPTS "$LOCAL_AUTH" "$REMOTE:~/.codex/auth.json"

echo "[3/3] Removing local token..."
rm "$LOCAL_AUTH"

echo "=== Done. Start container with: docker compose up -d ==="
