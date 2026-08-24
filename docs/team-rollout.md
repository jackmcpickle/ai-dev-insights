# Team roll-out

Cloud agents only run command-based hooks from the repo (`.cursor/hooks.json`) and, on Enterprise, hooks pushed from the dashboard. They never read `~/.cursor/hooks.json`. If you only install hooks on a laptop, cloud work is invisible.

## Add hooks to another repo

From this repo:

```bash
./scripts/install-hooks.sh /path/to/other-repo
```

That copies:

- `.cursor/hooks.json`
- `.cursor/hooks/ingest.mjs`
- `.cursor/hooks.env.example`

Commit the first two. Do not commit `.cursor/hooks.env`.

In the other repo, set `INGEST_URL` and `INGEST_TOKEN`. Locally, copy the example to `.cursor/hooks.env` or `~/.ai-dev-insights.env`. For cloud agents, put the same names in the Cursor environment / dashboard secrets so the hook process can see them. User-level env files on your laptop are not available in the cloud VM.

Copy `.github/workflows/pr-usage.yml` and `scripts/comment-pr-usage.mjs` if you want the PR comment. Add repo secrets `AI_DEV_INSIGHTS_URL` and `AI_DEV_INSIGHTS_TOKEN`.

## Local IDE agents

Cloud hooks do not cover Cursor on a laptop. Install the same script into the user hook dir:

```bash
./scripts/install-user-hooks.sh
```

User hooks run from `~/.cursor`, so commands are `node ./hooks/ai-dev-insights.mjs`, not `.cursor/hooks/ingest.mjs`. If `~/.cursor/hooks.json` already exists, the script prints the snippet to merge.

`sessionStart` / `sessionEnd` are useful locally and do not run in cloud. See `.cursor/hooks.local.json` for the extra entries.

## Enterprise team hooks

On Enterprise, team and org hooks configured at [cursor.com/dashboard/team-content](https://cursor.com/dashboard/team-content?section=hooks) also run in cloud agents. That is the right path if you cannot put `.cursor/hooks.json` in every repo. The script still has to be reachable from the managed hooks directory, so prefer a self-contained `ingest.mjs` and the same `INGEST_URL` / `INGEST_TOKEN` env names.

Priority is Enterprise → Team → Project → User. All matching hooks run. These observe hooks fail open (`{}`, exit 0), so they should not block a stricter security hook from another source.

## Cloud vs local

| | Cloud agent | Local IDE |
| --- | --- | --- |
| Project `.cursor/hooks.json` | Yes, once the VM is writable | Yes, in a trusted workspace |
| `~/.cursor/hooks.json` | No | Yes |
| Team / Enterprise hooks | Yes (Enterprise) | Yes (Enterprise) |
| `sessionStart` / `sessionEnd` | No | Yes |
| MCP / Tab hooks | No | Yes |
| Command-based hooks | Yes | Yes |
| Prompt-based hooks | No | Yes |
| `beforeReadFile.content` | Skip for v1. The mapper redacts `content` if it ever appears | Same |

Cloud agents sometimes start read-only. Hooks do not fire on those early turns.

## Auth

One shared bearer token (`INGEST_TOKEN`). Send it as `Authorization: Bearer …`, `x-insights-token`, or `?token=` on GET. The Worker rejects writes and reads if the secret is unset or wrong.

## PR comments

The workflow posts or updates a single comment marked `<!-- ai-dev-insights -->`. It keys usage by head branch, PR number, and `owner/repo`. If the ingest URL is unset, the job exits 0 and leaves the PR alone.

## Insights over the corpus

After traffic is flowing, run `/agent-insights` against production. See [docs/agent-insights.md](agent-insights.md). The observe hooks stay fail-open; the skill only reads.
