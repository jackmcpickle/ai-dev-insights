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
    received_at?: number;
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

export interface EventFilter extends UsageFilter {
    hook?: string;
    conversation_id?: string;
    since?: number;
    until?: number;
    after_id?: number;
    limit?: number;
}

export interface ExportEvent {
    id: number;
    received_at: number;
    hook_event: string;
    conversation_id: string | null;
    generation_id: string | null;
    model: string | null;
    model_id: string | null;
    user_email: string | null;
    git_branch: string | null;
    pr_number: number | null;
    repo: string | null;
    status: string | null;
    text: string | null;
    usage: UsageFields;
    skill_mentions: string[];
}

export interface SkillMentionStat {
    name: string;
    mentions: number;
    conversations: number;
}

export interface ConversationDigest {
    conversation_id: string;
    prompt_count: number;
    stop_count: number;
    error_count: number;
    models: string[];
    skills: string[];
    git_branch: string | null;
    pr_number: number | null;
    repo: string | null;
    last_status: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
}

export interface CorpusDigest {
    filter: EventFilter;
    event_count: number;
    conversation_count: number;
    usage: UsageReport;
    skills: SkillMentionStat[];
    retries: ConversationDigest[];
    failures: ConversationDigest[];
    high_token_prs: UsageBucket[];
    corrections: Array<{
        conversation_id: string | null;
        event_id: number;
        text: string;
        skill_mentions: string[];
    }>;
    recipes: Array<{ prefix: string; count: number }>;
    conversations: ConversationDigest[];
    note: string;
}

export interface InsightsFinding {
    title: string;
    reason: string;
    evidence_ids: number[];
}

export interface InsightsReport {
    proposed_skills: InsightsFinding[];
    hotspots: InsightsFinding[];
    do_not_change: InsightsFinding[];
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
    queryEvents(filter: EventFilter): Promise<StoredEvent[]>;
}
