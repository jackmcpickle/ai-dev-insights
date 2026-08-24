export interface UsageFields {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    cache_creation_tokens?: number;
    reasoning_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    context_tokens?: number;
    context_window_size?: number;
    context_usage_percent?: number;
    message_count?: number;
    messages_to_compact?: number;
    duration_ms?: number;
    duration?: number;
    loop_count?: number;
}

export interface IngestPayload {
    hook_event: string;
    conversation_id: string | null;
    generation_id: string | null;
    model: string | null;
    model_id: string | null;
    user_email: string | null;
    workspace_roots: string[];
    cursor_version: string | null;
    git_branch: string | null;
    pr_number: number | null;
    repo: string | null;
    status: string | null;
    subagent_id: string | null;
    subagent_type: string | null;
    text: string | null;
    usage: UsageFields;
    payload: unknown;
}

export interface StoredEvent extends IngestPayload {
    id: number;
    received_at: number;
}

export interface UsageFilter {
    branch?: string;
    pr?: number;
    user?: string;
    repo?: string;
}

export interface UsageBucket {
    git_branch: string | null;
    pr_number: number | null;
    user_email: string | null;
    repo: string | null;
    event_count: number;
    prompt_count: number;
    response_count: number;
    thought_count: number;
    stop_count: number;
    subagent_count: number;
    compact_count: number;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    max_context_tokens: number | null;
    max_context_window: number | null;
    turns_with_token_fields: number;
    turns_missing_token_fields: number;
}

export interface UsageReport {
    filter: UsageFilter;
    totals: UsageBucket;
    by_pr: UsageBucket[];
    by_branch: UsageBucket[];
    by_user: UsageBucket[];
    note: string;
}

export interface InsightsStore {
    insertEvent(event: IngestPayload): Promise<StoredEvent>;
    queryEvents(filter: UsageFilter): Promise<StoredEvent[]>;
}
