import { matchesFilter } from "./usage";
import type {
    IngestPayload,
    InsightsStore,
    StoredEvent,
    UsageFields,
    UsageFilter,
} from "./types";

interface EventRow {
    id: number;
    received_at: number;
    hook_event: string;
    conversation_id: string | null;
    generation_id: string | null;
    model: string | null;
    model_id: string | null;
    user_email: string | null;
    workspace: string | null;
    git_branch: string | null;
    pr_number: number | null;
    repo: string | null;
    status: string | null;
    subagent_id: string | null;
    subagent_type: string | null;
    text: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    context_tokens: number | null;
    context_window: number | null;
    context_usage_percent: number | null;
    message_count: number | null;
    duration_ms: number | null;
    payload_json: string;
}

function usageFromRow(row: EventRow): UsageFields {
    return {
        input_tokens: row.input_tokens ?? undefined,
        output_tokens: row.output_tokens ?? undefined,
        cache_read_tokens: row.cache_read_tokens ?? undefined,
        cache_write_tokens: row.cache_write_tokens ?? undefined,
        context_tokens: row.context_tokens ?? undefined,
        context_window_size: row.context_window ?? undefined,
        context_usage_percent: row.context_usage_percent ?? undefined,
        message_count: row.message_count ?? undefined,
        duration_ms: row.duration_ms ?? undefined,
    };
}

function rowToEvent(row: EventRow): StoredEvent {
    let payload: unknown = null;
    try {
        payload = JSON.parse(row.payload_json) as unknown;
    } catch {
        payload = null;
    }
    return {
        id: row.id,
        received_at: row.received_at,
        hook_event: row.hook_event,
        conversation_id: row.conversation_id,
        generation_id: row.generation_id,
        model: row.model,
        model_id: row.model_id,
        user_email: row.user_email,
        workspace_roots: row.workspace ? [row.workspace] : [],
        cursor_version: null,
        git_branch: row.git_branch,
        pr_number: row.pr_number,
        repo: row.repo,
        status: row.status,
        subagent_id: row.subagent_id,
        subagent_type: row.subagent_type,
        text: row.text,
        usage: usageFromRow(row),
        payload,
    };
}

export function createD1Store(db: D1Database): InsightsStore {
    return {
        async insertEvent(event) {
            const receivedAt = Date.now();
            const workspace = event.workspace_roots[0] ?? null;
            const result = await db
                .prepare(
                    `INSERT INTO events (
                        received_at, hook_event, conversation_id, generation_id,
                        model, model_id, user_email, workspace, git_branch,
                        pr_number, repo, status, subagent_id, subagent_type, text,
                        input_tokens, output_tokens, cache_read_tokens,
                        cache_write_tokens, context_tokens, context_window,
                        context_usage_percent, message_count, duration_ms,
                        payload_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    receivedAt,
                    event.hook_event,
                    event.conversation_id,
                    event.generation_id,
                    event.model,
                    event.model_id,
                    event.user_email,
                    workspace,
                    event.git_branch,
                    event.pr_number,
                    event.repo,
                    event.status,
                    event.subagent_id,
                    event.subagent_type,
                    event.text,
                    event.usage.input_tokens ?? null,
                    event.usage.output_tokens ?? null,
                    event.usage.cache_read_tokens ?? null,
                    event.usage.cache_write_tokens ?? null,
                    event.usage.context_tokens ?? null,
                    event.usage.context_window_size ?? null,
                    event.usage.context_usage_percent ?? null,
                    event.usage.message_count ?? null,
                    event.usage.duration_ms ?? null,
                    JSON.stringify(event.payload ?? {}),
                )
                .run();
            return {
                ...event,
                id: Number(result.meta.last_row_id ?? 0),
                received_at: receivedAt,
            };
        },

        async queryEvents(filter) {
            const clauses: string[] = [];
            const binds: Array<string | number> = [];
            if (filter.branch) {
                clauses.push("git_branch = ?");
                binds.push(filter.branch);
            }
            if (filter.pr != null) {
                clauses.push("pr_number = ?");
                binds.push(filter.pr);
            }
            if (filter.user) {
                clauses.push("user_email = ?");
                binds.push(filter.user);
            }
            if (filter.repo) {
                clauses.push("repo = ?");
                binds.push(filter.repo);
            }
            const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
            const rows = await db
                .prepare(
                    `SELECT * FROM events ${where} ORDER BY received_at DESC LIMIT 5000`,
                )
                .bind(...binds)
                .all<EventRow>();
            return (rows.results ?? []).map(rowToEvent);
        },
    };
}

export function createMemoryStore(): InsightsStore & { events: StoredEvent[] } {
    const events: StoredEvent[] = [];
    let nextId = 1;
    return {
        events,
        async insertEvent(event: IngestPayload) {
            const row: StoredEvent = {
                ...event,
                id: nextId,
                received_at: Date.now(),
            };
            nextId += 1;
            events.push(row);
            return row;
        },
        async queryEvents(filter: UsageFilter) {
            return events.filter((event) => matchesFilter(event, filter));
        },
    };
}
