import { extractSkillMentions } from "./mentions";
import type { EventFilter, ExportEvent, StoredEvent } from "./types";

export const EXPORT_DEFAULT_LIMIT = 100;
export const EXPORT_MAX_LIMIT = 500;
export const DIGEST_EVENT_CAP = 5000;

export const parseTimestamp = (raw: string | null): number | undefined => {
  if (!raw) {
    return undefined;
  }
  if (/^\d+$/u.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
};

const assignStringParam = (
  filter: EventFilter,
  key: keyof EventFilter,
  value: string | null
): void => {
  if (value) {
    filter[key] = value as never;
  }
};

const parsePositiveInt = (raw: string | null): number | undefined => {
  if (!raw) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return Math.floor(n);
};

const parseNonNegativeInt = (raw: string | null): number | undefined => {
  if (!raw) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return undefined;
  }
  return Math.floor(n);
};

const applyStringParams = (
  params: URLSearchParams,
  filter: EventFilter
): void => {
  assignStringParam(filter, "branch", params.get("branch"));
  assignStringParam(filter, "user", params.get("user"));
  assignStringParam(filter, "repo", params.get("repo"));
  assignStringParam(
    filter,
    "hook",
    params.get("hook") ?? params.get("hook_event")
  );
  assignStringParam(filter, "conversation_id", params.get("conversation_id"));
};

const applyNumericParams = (
  params: URLSearchParams,
  filter: EventFilter
): void => {
  const pr = parsePositiveInt(params.get("pr"));
  if (pr !== undefined) {
    filter.pr = pr;
  }
  const since = parseTimestamp(params.get("since"));
  if (since !== undefined) {
    filter.since = since;
  }
  const until = parseTimestamp(params.get("until"));
  if (until !== undefined) {
    filter.until = until;
  }
  const afterId = parseNonNegativeInt(params.get("after_id"));
  if (afterId !== undefined) {
    filter.after_id = afterId;
  }
  const limit = parsePositiveInt(params.get("limit"));
  if (limit !== undefined) {
    filter.limit = Math.min(limit, EXPORT_MAX_LIMIT);
  }
};

export const parseEventFilter = (url: URL): EventFilter => {
  const filter: EventFilter = {};
  applyStringParams(url.searchParams, filter);
  applyNumericParams(url.searchParams, filter);
  return filter;
};

export const toExportEvent = (event: StoredEvent): ExportEvent => ({
  conversation_id: event.conversation_id,
  generation_id: event.generation_id,
  git_branch: event.git_branch,
  hook_event: event.hook_event,
  id: event.id,
  model: event.model,
  model_id: event.model_id,
  pr_number: event.pr_number,
  received_at: event.received_at,
  repo: event.repo,
  skill_mentions: extractSkillMentions(event.text),
  status: event.status,
  text: event.text,
  usage: event.usage,
  user_email: event.user_email,
});

export const nextCursor = (
  events: StoredEvent[],
  limit: number
): number | null => {
  if (events.length === 0 || events.length < limit) {
    return null;
  }
  return events.at(-1)?.id ?? null;
};
