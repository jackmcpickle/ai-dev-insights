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

export const parseEventFilter = (url: URL): EventFilter => {
  const filter: EventFilter = {};
  const branch = url.searchParams.get("branch");
  const user = url.searchParams.get("user");
  const repo = url.searchParams.get("repo");
  const hook =
    url.searchParams.get("hook") ?? url.searchParams.get("hook_event");
  const conversation = url.searchParams.get("conversation_id");
  const prRaw = url.searchParams.get("pr");
  const afterRaw = url.searchParams.get("after_id");
  const limitRaw = url.searchParams.get("limit");
  if (branch) {
    filter.branch = branch;
  }
  if (user) {
    filter.user = user;
  }
  if (repo) {
    filter.repo = repo;
  }
  if (hook) {
    filter.hook = hook;
  }
  if (conversation) {
    filter.conversation_id = conversation;
  }
  if (prRaw) {
    const pr = Number(prRaw);
    if (Number.isFinite(pr) && pr > 0) {
      filter.pr = Math.floor(pr);
    }
  }
  const since = parseTimestamp(url.searchParams.get("since"));
  const until = parseTimestamp(url.searchParams.get("until"));
  if (since !== null && since !== undefined) {
    filter.since = since;
  }
  if (until !== null && until !== undefined) {
    filter.until = until;
  }
  if (afterRaw) {
    const after = Number(afterRaw);
    if (Number.isFinite(after) && after >= 0) {
      filter.after_id = Math.floor(after);
    }
  }
  if (limitRaw) {
    const limit = Number(limitRaw);
    if (Number.isFinite(limit) && limit > 0) {
      filter.limit = Math.min(Math.floor(limit), EXPORT_MAX_LIMIT);
    }
  }
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
