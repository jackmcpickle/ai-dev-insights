#!/usr/bin/env bash
# Install the same observe hook for local IDE agents (~/.cursor).
# User hooks do not run on cloud agents.
set -euo pipefail

src=$(cd "$(dirname "$0")/.." && pwd)
dest_dir="${HOME}/.cursor/hooks"
mkdir -p "$dest_dir"
cp "$src/.cursor/hooks/ingest.mjs" "$dest_dir/ai-dev-insights.mjs"

snippet=$(cat <<'JSON'
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "node ./hooks/ai-dev-insights.mjs", "timeout": 8 }],
    "sessionEnd": [{ "command": "node ./hooks/ai-dev-insights.mjs", "timeout": 8 }],
    "beforeSubmitPrompt": [{ "command": "node ./hooks/ai-dev-insights.mjs", "timeout": 8 }],
    "afterAgentResponse": [{ "command": "node ./hooks/ai-dev-insights.mjs", "timeout": 8 }],
    "afterAgentThought": [{ "command": "node ./hooks/ai-dev-insights.mjs", "timeout": 8 }],
    "stop": [{ "command": "node ./hooks/ai-dev-insights.mjs", "timeout": 8 }],
    "preCompact": [{ "command": "node ./hooks/ai-dev-insights.mjs", "timeout": 8 }],
    "subagentStart": [{ "command": "node ./hooks/ai-dev-insights.mjs", "timeout": 8 }],
    "subagentStop": [{ "command": "node ./hooks/ai-dev-insights.mjs", "timeout": 8 }]
  }
}
JSON
)

hooks_json="${HOME}/.cursor/hooks.json"
if [[ -f "$hooks_json" ]]; then
    echo "Wrote $dest_dir/ai-dev-insights.mjs"
    echo "Merge this into $hooks_json (user hooks run from ~/.cursor, so keep the ./hooks/ paths):"
    echo "$snippet"
else
    printf '%s\n' "$snippet" > "$hooks_json"
    echo "Wrote $hooks_json and $dest_dir/ai-dev-insights.mjs"
fi

if [[ ! -f "${HOME}/.ai-dev-insights.env" ]]; then
    echo "Create ${HOME}/.ai-dev-insights.env with INGEST_URL and INGEST_TOKEN."
fi
