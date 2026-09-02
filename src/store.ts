import type {
  EventFilter,
  IngestPayload,
  InsightsStore,
  StoredEvent,
  UsageFields,
} from "./types";
import { matchesFilter } from "./usage";

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

const usageFromRow = (row: EventRow): UsageFields => ({
  cache_read_tokens: row.cache_read_tokens ?? undefined,
  cache_write_tokens: row.cache_write_tokens ?? undefined,
  context_tokens: row.context_tokens ?? undefined,
  context_usage_percent: row.context_usage_percent ?? undefined,
  context_window_size: row.context_window ?? undefined,
  duration_ms: row.duration_ms ?? undefined,
  input_tokens: row.input_tokens ?? undefined,
  message_count: row.message_count ?? undefined,
  output_tokens: row.output_tokens ?? undefined,
});

const rowToEvent = (row: EventRow): StoredEvent => {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    payload = null;
  }
  return {
    conversation_id: row.conversation_id,
    cursor_version: null,
    generation_id: row.generation_id,
    git_branch: row.git_branch,
    hook_event: row.hook_event,
    id: row.id,
    model: row.model,
    model_id: row.model_id,
    payload,
    pr_number: row.pr_number,
    received_at: row.received_at,
    repo: row.repo,
    status: row.status,
    subagent_id: row.subagent_id,
    subagent_type: row.subagent_type,
    text: row.text,
    usage: usageFromRow(row),
    user_email: row.user_email,
    workspace_roots: row.workspace ? [row.workspace] : [],
  };
};

export const createD1Store = (db: D1Database): InsightsStore => ({
  async insertEvent(event) {
    const receivedAt =
      typeof event.received_at === "number" &&
      Number.isFinite(event.received_at)
        ? Math.floor(event.received_at)
        : Date.now();
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
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        JSON.stringify(event.payload ?? {})
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
    const binds: (string | number)[] = [];
    if (filter.branch && filter.pr !== null && filter.pr !== undefined) {
      clauses.push("(git_branch = ? OR pr_number = ?)");
      binds.push(filter.branch, filter.pr);
    } else {
      if (filter.branch) {
        clauses.push("git_branch = ?");
        binds.push(filter.branch);
      }
      if (filter.pr !== null && filter.pr !== undefined) {
        clauses.push("pr_number = ?");
        binds.push(filter.pr);
      }
    }
    if (filter.user) {
      clauses.push("user_email = ?");
      binds.push(filter.user);
    }
    if (filter.repo) {
      clauses.push("repo = ?");
      binds.push(filter.repo);
    }
    if (filter.hook) {
      clauses.push("hook_event = ?");
      binds.push(filter.hook);
    }
    if (filter.conversation_id) {
      clauses.push("conversation_id = ?");
      binds.push(filter.conversation_id);
    }
    if (filter.since !== null && filter.since !== undefined) {
      clauses.push("received_at >= ?");
      binds.push(filter.since);
    }
    if (filter.until !== null && filter.until !== undefined) {
      clauses.push("received_at <= ?");
      binds.push(filter.until);
    }
    if (filter.after_id !== null && filter.after_id !== undefined) {
      clauses.push("id > ?");
      binds.push(filter.after_id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ?? 5000;
    const rows = await db
      .prepare(`SELECT * FROM events ${where} ORDER BY id ASC LIMIT ?`)
      .bind(...binds, limit)
      .all<EventRow>();
    return (rows.results ?? []).map(rowToEvent);
  },
});

export const createMemoryStore = (): InsightsStore & {
  events: StoredEvent[];
} => {
  const events: StoredEvent[] = [];
  let nextId = 1;
  return {
    events,
    insertEvent(event: IngestPayload): Promise<StoredEvent> {
      const receivedAt =
        typeof event.received_at === "number" &&
        Number.isFinite(event.received_at)
          ? Math.floor(event.received_at)
          : Date.now();
      const row: StoredEvent = {
        ...event,
        id: nextId,
        received_at: receivedAt,
      };
      nextId += 1;
      events.push(row);
      return Promise.resolve(row);
    },
    queryEvents(filter: EventFilter): Promise<StoredEvent[]> {
      const limit = filter.limit ?? 5000;
      return Promise.resolve(
        events
          .filter((event) => matchesFilter(event, filter))
          .toSorted((a, b) => a.id - b.id)
          .slice(0, limit)
      );
    },
  };
};
