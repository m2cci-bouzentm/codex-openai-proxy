#!/bin/bash
set -euo pipefail

SSH_CMD="${1:?Usage: ./deploy-auth.sh 'ssh -i ~/.ssh/key user@host'}"
LOCAL_AUTH="$HOME/.codex/auth.json"

echo "=== Codex Proxy Auth Deploy ==="

echo "[1/4] Logging into Codex CLI..."
codex login

if [ ! -f "$LOCAL_AUTH" ]; then
  echo "ERROR: $LOCAL_AUTH not found after login. Aborting."
  exit 1
fi

echo "[2/4] Uploading auth to VPS..."
# Extract user@host from ssh command for scp
REMOTE=$(echo "$SSH_CMD" | grep -oE '[^ ]+@[^ ]+')
SSH_OPTS=$(echo "$SSH_CMD" | sed "s|ssh ||; s|$REMOTE||")
$SSH_CMD "mkdir -p ~/.codex"
scp $SSH_OPTS "$LOCAL_AUTH" "$REMOTE:~/.codex/auth.json"

echo "[3/4] Removing local token..."
rm "$LOCAL_AUTH"

echo "[4/4] Restarting container..."
$SSH_CMD "rm -rf ~/.codex-proxy && docker restart codex-openai-proxy"

sleep 3
$SSH_CMD "curl -sf http://localhost:7391/health" && echo "Health: OK" || echo "Health: FAILED"

echo "=== Done ==="
