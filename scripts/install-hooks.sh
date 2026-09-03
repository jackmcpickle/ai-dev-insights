#!/usr/bin/env bash
# Copy project hooks into another repo so cloud agents pick them up.
set -euo pipefail

target=${1:-}
if [[ -z "$target" ]]; then
    echo "usage: scripts/install-hooks.sh /path/to/other-repo" >&2
    exit 1
fi

src=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$target/.cursor/hooks" "$target/.claude/hooks"
cp "$src/.cursor/hooks.json" "$target/.cursor/hooks.json"
cp "$src/.cursor/hooks/ingest.mjs" "$target/.cursor/hooks/ingest.mjs"
cp "$src/.claude/hooks/run-ai-dev-insights.sh" "$target/.claude/hooks/run-ai-dev-insights.sh"
chmod +x "$target/.claude/hooks/run-ai-dev-insights.sh"
if [[ ! -f "$target/.claude/settings.json" ]]; then
    cp "$src/.claude/settings.json" "$target/.claude/settings.json"
fi
if [[ ! -f "$target/.cursor/hooks.env.example" ]]; then
    cp "$src/.cursor/hooks.env.example" "$target/.cursor/hooks.env.example"
fi

echo "Installed project hooks in $target/.cursor and Claude hooks in $target/.claude"
echo "Set INGEST_URL and INGEST_TOKEN in $target/.cursor/hooks.env (gitignored) or the process environment."
echo "Cloud agents do not read ~/.cursor. They only load this repo file plus Enterprise team hooks."
