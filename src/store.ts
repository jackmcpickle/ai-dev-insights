import { buildEventQuery } from "./d1-query";
import type {
  EventFilter,
  IngestPayload,
  InsightsStore,
  StoredEvent,
  UsageFields,
} from "./types";
import { matchesFilter } from "./usage";

export interface EventRow {
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

const nullToUndefined = <T>(value: T | null): T | undefined =>
  value === null ? undefined : value;

export const usageFromRow = (row: EventRow): UsageFields => ({
  cache_read_tokens: nullToUndefined(row.cache_read_tokens),
  cache_write_tokens: nullToUndefined(row.cache_write_tokens),
  context_tokens: nullToUndefined(row.context_tokens),
  context_usage_percent: nullToUndefined(row.context_usage_percent),
  context_window_size: nullToUndefined(row.context_window),
  duration_ms: nullToUndefined(row.duration_ms),
  input_tokens: nullToUndefined(row.input_tokens),
  message_count: nullToUndefined(row.message_count),
  output_tokens: nullToUndefined(row.output_tokens),
});

export const parsePayloadJson = (payloadJson: string): unknown => {
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return null;
  }
};

export const rowToEvent = (row: EventRow): StoredEvent => ({
  conversation_id: row.conversation_id,
  cursor_version: null,
  generation_id: row.generation_id,
  git_branch: row.git_branch,
  hook_event: row.hook_event,
  id: row.id,
  model: row.model,
  model_id: row.model_id,
  payload: parsePayloadJson(row.payload_json),
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
});

const resolveReceivedAt = (event: IngestPayload): number =>
  typeof event.received_at === "number" && Number.isFinite(event.received_at)
    ? Math.floor(event.received_at)
    : Date.now();

const nullToNull = (field: number | null | undefined): number | null =>
  field ?? null;

const usageInsertValues = (usage: UsageFields): (number | null)[] => [
  nullToNull(usage.input_tokens),
  nullToNull(usage.output_tokens),
  nullToNull(usage.cache_read_tokens),
  nullToNull(usage.cache_write_tokens),
  nullToNull(usage.context_tokens),
  nullToNull(usage.context_window_size),
  nullToNull(usage.context_usage_percent),
  nullToNull(usage.message_count),
  nullToNull(usage.duration_ms),
];

const insertEventBinds = (
  event: IngestPayload,
  receivedAt: number,
  workspace: string | null
): (string | number | null)[] => [
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
  ...usageInsertValues(event.usage),
  JSON.stringify(event.payload ?? {}),
];

export const d1InsertEvent = async (
  db: D1Database,
  event: IngestPayload
): Promise<StoredEvent> => {
  const receivedAt = resolveReceivedAt(event);
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
    .bind(...insertEventBinds(event, receivedAt, workspace))
    .run();
  return {
    ...event,
    id: Number(result.meta.last_row_id ?? 0),
    received_at: receivedAt,
  };
};

export const d1QueryEvents = async (
  db: D1Database,
  filter: EventFilter
): Promise<StoredEvent[]> => {
  const query = buildEventQuery(filter);
  const rows = await db
    .prepare(`SELECT * FROM events ${query.where} ORDER BY id ASC LIMIT ?`)
    .bind(...query.binds, query.limit)
    .all<EventRow>();
  return (rows.results ?? []).map(rowToEvent);
};

export const createD1Store = (db: D1Database): InsightsStore => ({
  insertEvent: (event) => d1InsertEvent(db, event),
  queryEvents: (filter) => d1QueryEvents(db, filter),
});

export const createMemoryStore = (): InsightsStore & {
  events: StoredEvent[];
} => {
  const events: StoredEvent[] = [];
  let nextId = 1;
  return {
    events,
    insertEvent(event: IngestPayload): Promise<StoredEvent> {
      const receivedAt = resolveReceivedAt(event);
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
