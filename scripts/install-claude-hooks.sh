#!/usr/bin/env bash
# Install ai-dev-insights observe hooks for Claude Code (~/.claude).
set -euo pipefail

src=$(cd "$(dirname "$0")/.." && pwd)
dest_dir="${HOME}/.claude/hooks"
mkdir -p "$dest_dir"
cp "$src/.cursor/hooks/ingest.mjs" "$dest_dir/ai-dev-insights.mjs"
cp "$src/.claude/hooks/run-ai-dev-insights.sh" "$dest_dir/run-ai-dev-insights.sh"
chmod +x "$dest_dir/ai-dev-insights.mjs" "$dest_dir/run-ai-dev-insights.sh"

node "$src/scripts/merge-claude-hooks.mjs"

if [[ ! -f "${HOME}/.ai-dev-insights.env" ]]; then
    echo "Create ${HOME}/.ai-dev-insights.env with INGEST_URL and INGEST_TOKEN."
    echo "Or run: pnpm setup:local"
fi

echo "User hooks: ${dest_dir}/run-ai-dev-insights.sh"
echo "Project hooks (this repo): .claude/settings.json uses the project wrapper."
