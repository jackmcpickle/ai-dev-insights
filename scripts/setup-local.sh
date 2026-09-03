#!/usr/bin/env bash
# Wire ai-dev-insights hooks and env for local Cursor + wrangler dev.
set -euo pipefail

src=$(cd "$(dirname "$0")/.." && pwd)
cd "$src"

LOCAL_URL="${INGEST_URL:-http://127.0.0.1:8787}"
LOCAL_TOKEN="${INGEST_TOKEN:-dev-ingest-token}"

copy_if_missing() {
    local example=$1
    local dest=$2
    if [[ -f "$dest" ]]; then
        echo "keep $dest"
    else
        cp "$example" "$dest"
        echo "created $dest"
    fi
}

copy_if_missing ".dev.vars.example" ".dev.vars"
copy_if_missing ".cursor/hooks.env.example" ".cursor/hooks.env"

# Point project hooks at local wrangler unless hooks.env already has a URL.
if ! grep -q '^INGEST_URL=' .cursor/hooks.env 2>/dev/null; then
    cat > .cursor/hooks.env <<EOF
INGEST_URL=$LOCAL_URL
INGEST_TOKEN=$LOCAL_TOKEN
EOF
    echo "wrote .cursor/hooks.env -> $LOCAL_URL"
elif grep -q 'YOUR_SUBDOMAIN' .cursor/hooks.env 2>/dev/null; then
    sed -i '' "s|^INGEST_URL=.*|INGEST_URL=$LOCAL_URL|" .cursor/hooks.env
    if grep -q '^INGEST_TOKEN=$' .cursor/hooks.env 2>/dev/null; then
        sed -i '' "s|^INGEST_TOKEN=.*|INGEST_TOKEN=$LOCAL_TOKEN|" .cursor/hooks.env
    fi
    echo "updated placeholder .cursor/hooks.env -> $LOCAL_URL"
else
    echo "keep .cursor/hooks.env (INGEST_URL already set)"
fi

user_env="${HOME}/.ai-dev-insights.env"
if [[ ! -f "$user_env" ]]; then
    cat > "$user_env" <<EOF
INGEST_URL=$LOCAL_URL
INGEST_TOKEN=$LOCAL_TOKEN
EOF
    echo "created $user_env"
else
    echo "keep $user_env"
fi

mkdir -p "${HOME}/.cursor/hooks"
cp "$src/.cursor/hooks/ingest.mjs" "${HOME}/.cursor/hooks/ai-dev-insights.mjs"
cp "$src/.claude/hooks/run-ai-dev-insights.sh" "${HOME}/.cursor/hooks/run-ai-dev-insights.sh"
chmod +x "${HOME}/.cursor/hooks/ai-dev-insights.mjs" "${HOME}/.cursor/hooks/run-ai-dev-insights.sh"
echo "installed ${HOME}/.cursor/hooks (ingest + wrapper)"

node "$src/scripts/merge-user-hooks.mjs"

echo "installing Claude Code user hooks..."
bash "$src/scripts/install-claude-hooks.sh"

echo "applying local D1 migrations..."
pnpm db:migrate:local

cat <<EOF

Local Cursor setup complete.

Project hooks:  $src/.cursor/hooks.json (already in repo)
User hooks:       ${HOME}/.cursor/hooks.json (merged)
Env:              $src/.cursor/hooks.env and $user_env

Next:
  1. pnpm dev
  2. Restart Cursor (or reload the window) so hooks pick up the env files
  3. Open this repo in Cursor and run an agent turn — check Hooks output channel

Test ingest:
  curl -sS -X POST "$LOCAL_URL/v1/ingest" \\
    -H "Authorization: Bearer $LOCAL_TOKEN" \\
    -H "Content-Type: application/json" \\
    --data '{"hook_event":"stop","conversation_id":"setup","generation_id":"g1","usage":{"input_tokens":1}}'
EOF
