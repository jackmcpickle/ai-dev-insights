# AI dev insights

Cursor hooks fire on every agent turn. This repo catches those events, stores them, and answers "what did this PR cost in context and tokens?"

It is a Cloudflare Worker (Hono + D1) plus a command-based hook that fail-opens. The hook always prints `{}` and exits 0, including when the network is down. It never blocks the agent.

## What gets stored

Observed hooks (project `.cursor/hooks.json`, so cloud agents pick them up):

- `beforeSubmitPrompt`
- `afterAgentResponse`
- `afterAgentThought`
- `stop`
- `preCompact` (`context_tokens`, `context_window_size`)
- `subagentStart` / `subagentStop`

`sessionStart` / `sessionEnd` are local-only. See `.cursor/hooks.local.json` and [docs/team-rollout.md](docs/team-rollout.md).

Each event keeps conversation id, generation id, model, user email, workspace roots, git branch (resolved from `workspace_roots` / `CURSOR_PROJECT_DIR`), and any usage fields that showed up. File-content hooks are out of v1. If `content` or a secret-looking key appears, the mapper redacts it.

## Token numbers are incomplete

Cursor does not document billed tokens on the public hooks page. In practice `stop` and `afterAgentResponse` sometimes include `input_tokens`, `output_tokens`, `cache_read_tokens`, and `cache_write_tokens`. Those two hooks report the same turn, so the summary keeps one row per `generation_id` and prefers `stop`.

`preCompact.context_tokens` is how full the context window is, not a bill. `subagentStop` has no token fields. Subagent spend is missing unless you later join the Enterprise Admin API usage events on `conversation_id`.

## API

All routes except `/health` need `Authorization: Bearer $INGEST_TOKEN` (or `x-insights-token` / `?token=`).

```bash
# hook payload (what ingest.mjs POSTs)
curl -sS -X POST "$INGEST_URL/v1/ingest" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{"hook_event":"stop","conversation_id":"c1","generation_id":"g1","model":"x","git_branch":"feat/usage","pr_number":12,"usage":{"input_tokens":100,"output_tokens":20}}
JSON

# tokens + counts by PR / branch / user
curl -sS -H "Authorization: Bearer $INGEST_TOKEN" \
  "$INGEST_URL/v1/usage?branch=feat/usage&pr=12"

# markdown used by the GitHub Action
curl -sS -H "Authorization: Bearer $INGEST_TOKEN" \
  "$INGEST_URL/v1/usage/comment?branch=feat/usage&pr=12"

# paginated export for a skill (also: hook, conversation_id, user, since, until)
curl -sS -H "Authorization: Bearer $INGEST_TOKEN" \
  "$INGEST_URL/v1/events?repo=jackmcpickle/ai-dev-insights&limit=100"

# compact corpus digest (prefer this over a raw dump)
curl -sS -H "Authorization: Bearer $INGEST_TOKEN" \
  "$INGEST_URL/v1/digest?repo=jackmcpickle/ai-dev-insights"
```

Open `/?token=...` for usage tables and `/insights?token=...` for the deterministic insights report. JSON equivalents: `GET /v1/usage`, `GET /v1/digest`, `GET /v1/insights`. Run `/agent-insights` in Cursor for a deeper skill/code proposal pass.

## Insights skill

`/agent-insights` (or "run insights") fetches the digest, clusters retries / failures / high-token PRs / corrections / missed skills / copy-paste recipes, and proposes skill edits plus code hotspots. It does not apply those edits. How to run it locally and in cloud: [docs/agent-insights.md](docs/agent-insights.md).

## Deploy

**CI (main):** after Test passes, the Deploy workflow runs `pnpm db:migrate` then `pnpm deploy`. Set these GitHub repo secrets:

- `CLOUDFLARE_API_TOKEN` — API token with Workers Scripts Edit + D1 Edit
- `CLOUDFLARE_ACCOUNT_ID` — `16a04bbc76ee5eccbcc1d6c39bc9a797` (Mcpickle)

If Cloudflare Workers Builds also deploys from GitHub, disable it or accept double deploys; migrations must run before the Worker serves traffic.

**Manual:**

```bash
pnpm install
npx wrangler d1 create ai-dev-insights
# paste database_id into wrangler.jsonc
npx wrangler secret put INGEST_TOKEN
pnpm db:migrate
pnpm deploy
```

Local:

```bash
pnpm setup:local   # hooks env, user hooks merge, local D1
pnpm dev
```

Or manually:

```bash
cp .dev.vars.example .dev.vars
cp .cursor/hooks.env.example .cursor/hooks.env
./scripts/install-user-hooks.sh
pnpm db:migrate:local
pnpm dev
```

## Hooks in this repo

`.cursor/hooks.json` points at `node .cursor/hooks/ingest.mjs`. Claude Code uses `.claude/settings.json` with a fail-open wrapper. Hooks always exit 0; failures log to `.cursor/hooks.log` in the project (gitignored via `*.log`).

Set the URL and token in `.cursor/hooks.env` (gitignored), `~/.ai-dev-insights.env`, or the process environment. Cloud agents need those names in the Cursor environment. They cannot see your home directory.

## Other team repos

```bash
./scripts/install-hooks.sh /path/to/other-repo
./scripts/install-user-hooks.sh   # local Cursor IDE
./scripts/install-claude-hooks.sh # local Claude Code (~/.claude)
```

Copy the PR workflow if you want the comment. Details: [docs/team-rollout.md](docs/team-rollout.md).

## Tests

```bash
pnpm test
```

A fixture through `ingest.mjs` must POST, a valid token must persist the event, `/v1/usage` must summarize that branch, and `/v1/digest` plus the insights pass must cluster the fixture corpus.
