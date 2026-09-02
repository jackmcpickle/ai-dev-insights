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

const addCount = (bucket: UsageBucket, event: StoredEvent): void => {
  bucket.event_count += 1;
  switch (event.hook_event) {
    case "beforeSubmitPrompt": {
      bucket.prompt_count += 1;
      break;
    }
    case "afterAgentResponse": {
      bucket.response_count += 1;
      break;
    }
    case "afterAgentThought": {
      bucket.thought_count += 1;
      break;
    }
    case "stop": {
      bucket.stop_count += 1;
      break;
    }
    case "subagentStart":
    case "subagentStop": {
      bucket.subagent_count += 1;
      break;
    }
    case "preCompact": {
      bucket.compact_count += 1;
      break;
    }
    default: {
      break;
    }
  }
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

/** One usage row per generation. Prefer stop when it has tokens, else any row with tokens. */
export const selectTurnUsage = (events: StoredEvent[]): StoredEvent[] => {
  const byKey = new Map<string, StoredEvent[]>();
  for (const event of events) {
    if (
      event.hook_event !== "stop" &&
      event.hook_event !== "afterAgentResponse"
    ) {
      continue;
    }
    const key =
      event.generation_id ?? `${event.conversation_id ?? "none"}:${event.id}`;
    const group = byKey.get(key) ?? [];
    group.push(event);
    byKey.set(key, group);
  }

  const chosen: StoredEvent[] = [];
  for (const group of byKey.values()) {
    chosen.push(
      group.find(
        (event) => event.hook_event === "stop" && hasTurnTokens(event.usage)
      ) ??
        group.find((event) => hasTurnTokens(event.usage)) ??
        group.find((event) => event.hook_event === "stop") ??
        group[0]
    );
  }
  return chosen;
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

const matchesBranchPr = (
  event: Pick<StoredEvent, "git_branch" | "pr_number">,
  filter: Pick<EventFilter, "branch" | "pr">
): boolean => {
  if (filter.branch && filter.pr !== null && filter.pr !== undefined) {
    return event.git_branch === filter.branch || event.pr_number === filter.pr;
  }
  if (filter.branch && event.git_branch !== filter.branch) {
    return false;
  }
  if (
    filter.pr !== null &&
    filter.pr !== undefined &&
    event.pr_number !== filter.pr
  ) {
    return false;
  }
  return true;
};

const matchesTimeBounds = (
  event: Pick<StoredEvent, "received_at" | "id">,
  filter: Pick<EventFilter, "since" | "until" | "after_id">
): boolean => {
  if (
    filter.since !== null &&
    filter.since !== undefined &&
    event.received_at < filter.since
  ) {
    return false;
  }
  if (
    filter.until !== null &&
    filter.until !== undefined &&
    event.received_at > filter.until
  ) {
    return false;
  }
  if (
    filter.after_id !== null &&
    filter.after_id !== undefined &&
    event.id <= filter.after_id
  ) {
    return false;
  }
  return true;
};

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
): boolean => {
  if (!matchesBranchPr(event, filter)) {
    return false;
  }
  if (filter.user && event.user_email !== filter.user) {
    return false;
  }
  if (filter.repo && event.repo !== filter.repo) {
    return false;
  }
  if (filter.hook && event.hook_event !== filter.hook) {
    return false;
  }
  if (
    filter.conversation_id &&
    event.conversation_id !== filter.conversation_id
  ) {
    return false;
  }
  return matchesTimeBounds(event, filter);
};

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
