# Running agent insights

`/agent-insights` (or "run insights") pulls captured hook traffic and proposes skill and code changes. It does not apply them.

The skill file is `skills/agent-insights/SKILL.md`. Cursor also loads `.cursor/skills/agent-insights/SKILL.md`, which points at that file.

## Against production

1. Deploy the Worker and set `INGEST_TOKEN`.
2. Put the same token and the Worker URL where the agent can see them:

```
INGEST_URL=https://ai-dev-insights.<account>.workers.dev
INGEST_TOKEN=...
```

Aliases `AI_DEV_INSIGHTS_URL` and `AI_DEV_INSIGHTS_TOKEN` work too.

3. Invoke `/agent-insights`. Ask it to scope with `repo=`, `since=`, or `pr=` if the corpus is large.

The agent should hit `GET /v1/digest` first. Page `GET /v1/events` only for conversations it will cite. `GET /v1/insights` is a deterministic first pass (retries, corrections, recipes, high-token PRs). The skill still has to read text and judge.

## Locally

```bash
cp .dev.vars.example .dev.vars
pnpm db:migrate:local
pnpm dev
```

Point the skill at `http://127.0.0.1:8787` via `.cursor/hooks.env`. Browse usage at `http://127.0.0.1:8787/?token=dev-ingest-token` and the insights report at `http://127.0.0.1:8787/insights?token=dev-ingest-token`.

```bash
curl -sS -X POST "$INGEST_URL/v1/ingest" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @test/fixtures/insights-corpus.json
```

`insights-corpus.json` is an array. The live ingest route accepts one event object. For a local dump, POST each element or use the tests.

## Cloud agents

Cloud agents do not read `~/.cursor` or laptop env files. Set `INGEST_URL` and `INGEST_TOKEN` on the Cursor environment / dashboard secrets so both the observe hook and this skill see production. Then run `/agent-insights` in a cloud chat on this repo (or any repo that has the skill file).

## What you get back

The skill must report:

1. Proposed skill edits or new skills
2. Code-area hotspots that waste tokens or fail often
3. What not to change

Token fields on hooks are optional. Do not treat gaps as zero spend.
