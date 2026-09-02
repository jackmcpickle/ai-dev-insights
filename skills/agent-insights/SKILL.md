---
name: agent-insights
description: Analyze captured Cursor hook traffic from the ingest Worker for skill edits and code-area waste. Use when the user says /agent-insights, "run insights", or asks what the team should change in skills or code based on agent logs.
---

# Agent insights

This is reflect over the ingest corpus, not the current chat. Pull team hook traffic, cluster waste and missed skills, then propose edits. Do not apply those edits.

## When to invoke

- The user said `/agent-insights` or "run insights".
- Someone asks what skills or code to change based on captured agent traffic.

Skip if ingest is not configured and you cannot reach the Worker.

## Auth and URL

Read `INGEST_URL` / `AI_DEV_INSIGHTS_URL` and `INGEST_TOKEN` / `AI_DEV_INSIGHTS_TOKEN` from the process environment, `.cursor/hooks.env`, or `~/.ai-dev-insights.env`. Cloud agents only see environment / dashboard secrets, not `~/.cursor`.

Send `Authorization: Bearer $INGEST_TOKEN` on every call.

## Process

### 1. Fetch the corpus

Prefer the digest. A raw dump is paginated and can be huge.

```bash
curl -sS -H "Authorization: Bearer $INGEST_TOKEN" \
  "$INGEST_URL/v1/digest"
```

Optional query params: `repo`, `branch`, `pr`, `user`, `since`, `until` (unix ms or ISO), `hook`, `conversation_id`.

Need message text? Page `/v1/events`:

```bash
curl -sS -H "Authorization: Bearer $INGEST_TOKEN" \
  "$INGEST_URL/v1/events?limit=100"
# then ?after_id=$next_cursor until next_cursor is null
```

Each event includes redacted `text`, model, usage fields that were present, and `skill_mentions` (SKILL.md paths, `/skill`, `@skill`, `/agent-insights`, "use the X skill").

A starting cluster lives at `GET /v1/insights` (`digest` + `insights`). Treat that as a first pass, not the final report.

### 2. Cluster

Use the digest, then read event text only for conversations you will cite.

- **Retries.** `retries` / more than one `stop` on a conversation, or `loop_count` > 0.
- **Tool / run failures.** `failures` (`stop` or `subagentStop` with `error` / `aborted`). We do not ingest `postToolUseFailure` in v1.
- **High token PRs.** `high_token_prs`. Those numbers are optional hook fields, not a bill. Missing tokens means unknown, not zero. `preCompact.context_tokens` is context fill, not spend.
- **Repeated user corrections.** `corrections`, plus later prompts in the same conversation that walk back the first one.
- **Missing or wrong skill triggers.** A correction names a skill the earlier prompts never mentioned. Also conversations that thrashed with no skill mention while a repo skill would have applied.
- **Copy-paste recipes.** `recipes`: the same prompt prefix across conversations.

Cite `event_id` / `conversation_id`. If you cannot point at traffic, drop the finding.

### 3. Output (do not apply)

Same rule as reflect: present the report and wait. Skill edits change every future agent.

```markdown
## Proposed skill edits

- Edit `skills/<name>/SKILL.md`: …
- Tune description: `skills/<name>/SKILL.md` (it exists but did not fire)
- New skill: `<kebab-name>` (only if no existing skill is a home and the pattern recurs)

## Code-area hotspots

- `path` or PR: why it wastes tokens or fails, with conversation ids

## Do not change

- One-offs, missing token fields, fail-open hooks, anything you cannot cite
```

Do not:

- Auto-apply skill or code edits
- Invent billed tokens or treat context snapshots as spend
- Tighten observe hooks (`failClosed`, exit 2, blocking output)
- Propose a new skill for a single conversation

### 4. Summarize

Short list. No preamble. What you would change, what you would leave, and which conversations you used.

## Local vs cloud

**Laptop.** `pnpm dev` against local D1, or point `INGEST_URL` at production. `.cursor/hooks.env` is fine. Invoke `/agent-insights`.

**Cloud agent.** Set `INGEST_URL` and `INGEST_TOKEN` in the Cursor environment. User hook files are not on the VM. The skill file in this repo is enough; fetch production, do not assume local `wrangler dev`.
