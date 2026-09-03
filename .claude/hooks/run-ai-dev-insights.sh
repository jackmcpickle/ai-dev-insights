#!/usr/bin/env bash
# Fail-open hook wrapper for Cursor and Claude Code.
# Never writes to stderr. Logs warnings to .cursor/hooks.log in the active project.
set +e

PROJECT="${CLAUDE_PROJECT_DIR:-${CURSOR_PROJECT_DIR:-$(pwd)}}"
LOG="${PROJECT}/.cursor/hooks.log"
HOME_SCRIPT="${HOME}/.claude/hooks/ai-dev-insights.mjs"
PROJECT_SCRIPT="${PROJECT}/.cursor/hooks/ingest.mjs"

warn() {
    mkdir -p "${PROJECT}/.cursor" 2>/dev/null || return 0
    printf '%s ai-dev-insights: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$LOG" 2>/dev/null || true
}

pick_script() {
    if [[ -f "$PROJECT_SCRIPT" ]]; then
        printf '%s\n' "$PROJECT_SCRIPT"
        return 0
    fi
    if [[ -f "$HOME_SCRIPT" ]]; then
        printf '%s\n' "$HOME_SCRIPT"
        return 0
    fi
    return 1
}

SCRIPT="$(pick_script)" || {
    warn "hook script missing (checked ${PROJECT_SCRIPT} and ${HOME_SCRIPT}); run pnpm setup:local or ./scripts/install-claude-hooks.sh"
    exit 0
}

node "$SCRIPT" 2>/dev/null
exit 0
