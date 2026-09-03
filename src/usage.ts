import type {
  EventFilter,
  IngestPayload,
  StoredEvent,
  UsageBucket,
  UsageFields,
  UsageFilter,
  UsageReport,
} from "./types";

export const USAGE_GAP_NOTE =
  "Token fields are optional on Cursor hooks. stop and afterAgentResponse sometimes include input_tokens / output_tokens / cache_* (undocumented as of the public hooks page; they have shown up in the wild). Those two hooks report the same turn totals, so we keep one row per generation_id and prefer stop. preCompact.context_tokens is a context-window snapshot, not billed usage. subagentStop has no token fields. Admin API usage events are the billed source if you need parent + subagent spend.";

const EMPTY_BUCKET_DIMS: Pick<
  UsageBucket,
  "git_branch" | "pr_number" | "user_email" | "repo"
> = {
  git_branch: null,
  pr_number: null,
  repo: null,
  user_email: null,
};

export const emptyBucket = (
  dims: Pick<
    UsageBucket,
    "git_branch" | "pr_number" | "user_email" | "repo"
  > = EMPTY_BUCKET_DIMS
): UsageBucket => ({
  ...dims,
  cache_read_tokens: null,
  cache_write_tokens: null,
  compact_count: 0,
  event_count: 0,
  input_tokens: null,
  max_context_tokens: null,
  max_context_window: null,
  output_tokens: null,
  prompt_count: 0,
  response_count: 0,
  stop_count: 0,
  subagent_count: 0,
  thought_count: 0,
  turns_missing_token_fields: 0,
  turns_with_token_fields: 0,
});

const HOOK_COUNTERS: Partial<
  Record<StoredEvent["hook_event"], (bucket: UsageBucket) => void>
> = {
  afterAgentResponse: (bucket) => {
    bucket.response_count += 1;
  },
  afterAgentThought: (bucket) => {
    bucket.thought_count += 1;
  },
  beforeSubmitPrompt: (bucket) => {
    bucket.prompt_count += 1;
  },
  preCompact: (bucket) => {
    bucket.compact_count += 1;
  },
  stop: (bucket) => {
    bucket.stop_count += 1;
  },
  subagentStart: (bucket) => {
    bucket.subagent_count += 1;
  },
  subagentStop: (bucket) => {
    bucket.subagent_count += 1;
  },
};

const addCount = (bucket: UsageBucket, event: StoredEvent): void => {
  bucket.event_count += 1;
  HOOK_COUNTERS[event.hook_event]?.(bucket);
};

const maxNullable = (
  current: number | null,
  next: number | undefined
): number | null => {
  if (next === null || next === undefined) {
    return current;
  }
  if (current === null || current === undefined) {
    return next;
  }
  return Math.max(current, next);
};

const addNullable = (
  current: number | null,
  next: number | undefined
): number | null => {
  if (next === null || next === undefined) {
    return current;
  }
  return (current ?? 0) + next;
};

const hasTurnTokens = (usage: UsageFields): boolean =>
  (usage.input_tokens !== null && usage.input_tokens !== undefined) ||
  (usage.output_tokens !== null && usage.output_tokens !== undefined) ||
  (usage.cache_read_tokens !== null && usage.cache_read_tokens !== undefined) ||
  (usage.cache_write_tokens !== null && usage.cache_write_tokens !== undefined);

const isTurnHook = (hookEvent: string): boolean =>
  hookEvent === "stop" || hookEvent === "afterAgentResponse";

const turnGroupKey = (event: StoredEvent): string =>
  event.generation_id ?? `${event.conversation_id ?? "none"}:${event.id}`;

const pickTurnFromGroup = (group: StoredEvent[]): StoredEvent =>
  group.find(
    (event) => event.hook_event === "stop" && hasTurnTokens(event.usage)
  ) ??
  group.find((event) => hasTurnTokens(event.usage)) ??
  group.find((event) => event.hook_event === "stop") ??
  group[0];

/** One usage row per generation. Prefer stop when it has tokens, else any row with tokens. */
export const selectTurnUsage = (events: StoredEvent[]): StoredEvent[] => {
  const byKey = new Map<string, StoredEvent[]>();
  for (const event of events) {
    if (!isTurnHook(event.hook_event)) {
      continue;
    }
    const key = turnGroupKey(event);
    const group = byKey.get(key) ?? [];
    group.push(event);
    byKey.set(key, group);
  }
  return [...byKey.values()].map(pickTurnFromGroup);
};

const applyTurnTokens = (bucket: UsageBucket, turns: StoredEvent[]): void => {
  for (const turn of turns) {
    if (hasTurnTokens(turn.usage)) {
      bucket.turns_with_token_fields += 1;
      bucket.input_tokens = addNullable(
        bucket.input_tokens,
        turn.usage.input_tokens
      );
      bucket.output_tokens = addNullable(
        bucket.output_tokens,
        turn.usage.output_tokens
      );
      bucket.cache_read_tokens = addNullable(
        bucket.cache_read_tokens,
        turn.usage.cache_read_tokens
      );
      bucket.cache_write_tokens = addNullable(
        bucket.cache_write_tokens,
        turn.usage.cache_write_tokens
      );
    } else {
      bucket.turns_missing_token_fields += 1;
    }
  }
};

const applyContext = (bucket: UsageBucket, events: StoredEvent[]): void => {
  for (const event of events) {
    if (event.hook_event !== "preCompact") {
      continue;
    }
    bucket.max_context_tokens = maxNullable(
      bucket.max_context_tokens,
      event.usage.context_tokens
    );
    bucket.max_context_window = maxNullable(
      bucket.max_context_window,
      event.usage.context_window_size
    );
  }
};

const groupKey = (
  event: StoredEvent,
  kind: "pr" | "branch" | "user"
): string => {
  if (kind === "pr") {
    return `${event.repo ?? ""}#${event.pr_number ?? "none"}`;
  }
  if (kind === "branch") {
    return `${event.repo ?? ""}@${event.git_branch ?? "none"}`;
  }
  return event.user_email ?? "unknown";
};

const dimsFor = (
  event: StoredEvent,
  kind: "pr" | "branch" | "user"
): Pick<UsageBucket, "git_branch" | "pr_number" | "user_email" | "repo"> => {
  if (kind === "pr") {
    return {
      git_branch: event.git_branch,
      pr_number: event.pr_number,
      repo: event.repo,
      user_email: null,
    };
  }
  if (kind === "branch") {
    return {
      git_branch: event.git_branch,
      pr_number: event.pr_number,
      repo: event.repo,
      user_email: null,
    };
  }
  return {
    git_branch: null,
    pr_number: null,
    repo: event.repo,
    user_email: event.user_email,
  };
};

const buildGroups = (
  events: StoredEvent[],
  kind: "pr" | "branch" | "user"
): UsageBucket[] => {
  const groups = new Map<string, StoredEvent[]>();
  for (const event of events) {
    const key = groupKey(event, kind);
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }
  const buckets: UsageBucket[] = [];
  for (const group of groups.values()) {
    const bucket = emptyBucket(dimsFor(group[0], kind));
    for (const event of group) {
      addCount(bucket, event);
    }
    applyTurnTokens(bucket, selectTurnUsage(group));
    applyContext(bucket, group);
    buckets.push(bucket);
  }
  return buckets.toSorted((a, b) => b.event_count - a.event_count);
};

const prFilterActive = (filter: Pick<EventFilter, "pr">): boolean =>
  filter.pr !== null && filter.pr !== undefined;

const fieldMismatch = (
  expected: string | null | undefined,
  actual: string | null
): boolean => Boolean(expected) && actual !== expected;

const matchesBranchPr = (
  event: Pick<StoredEvent, "git_branch" | "pr_number">,
  filter: Pick<EventFilter, "branch" | "pr">
): boolean => {
  if (filter.branch && prFilterActive(filter)) {
    return event.git_branch === filter.branch || event.pr_number === filter.pr;
  }
  if (fieldMismatch(filter.branch, event.git_branch)) {
    return false;
  }
  if (prFilterActive(filter) && event.pr_number !== filter.pr) {
    return false;
  }
  return true;
};

const isBeforeSince = (
  event: Pick<StoredEvent, "received_at">,
  since: number | null | undefined
): boolean =>
  since !== null && since !== undefined && event.received_at < since;

const isAfterUntil = (
  event: Pick<StoredEvent, "received_at">,
  until: number | null | undefined
): boolean =>
  until !== null && until !== undefined && event.received_at > until;

const isBeforeCursor = (
  event: Pick<StoredEvent, "id">,
  afterId: number | null | undefined
): boolean => afterId !== null && afterId !== undefined && event.id <= afterId;

const matchesTimeBounds = (
  event: Pick<StoredEvent, "received_at" | "id">,
  filter: Pick<EventFilter, "since" | "until" | "after_id">
): boolean =>
  !isBeforeSince(event, filter.since) &&
  !isAfterUntil(event, filter.until) &&
  !isBeforeCursor(event, filter.after_id);

const matchesIdentity = (
  event: Pick<
    StoredEvent,
    "user_email" | "repo" | "hook_event" | "conversation_id"
  >,
  filter: EventFilter
): boolean =>
  !fieldMismatch(filter.user, event.user_email) &&
  !fieldMismatch(filter.repo, event.repo) &&
  !fieldMismatch(filter.hook, event.hook_event) &&
  !fieldMismatch(filter.conversation_id, event.conversation_id);

export const matchesFilter = (
  event: Pick<
    StoredEvent,
    | "git_branch"
    | "pr_number"
    | "user_email"
    | "repo"
    | "hook_event"
    | "conversation_id"
    | "received_at"
    | "id"
  >,
  filter: EventFilter
): boolean =>
  matchesBranchPr(event, filter) &&
  matchesIdentity(event, filter) &&
  matchesTimeBounds(event, filter);

export const summarizeEvents = (
  events: StoredEvent[],
  filter: UsageFilter = {}
): UsageReport => {
  const scoped = events.filter((event) => matchesFilter(event, filter));
  const totals = emptyBucket();
  for (const event of scoped) {
    addCount(totals, event);
  }
  applyTurnTokens(totals, selectTurnUsage(scoped));
  applyContext(totals, scoped);

  return {
    by_branch: buildGroups(scoped, "branch"),
    by_pr: buildGroups(scoped, "pr"),
    by_user: buildGroups(scoped, "user"),
    filter,
    note: USAGE_GAP_NOTE,
    totals,
  };
};

export const isIngestPayload = (value: unknown): value is IngestPayload => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return typeof row.hook_event === "string";
};
