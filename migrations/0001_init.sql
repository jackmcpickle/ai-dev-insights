CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at INTEGER NOT NULL,
    hook_event TEXT NOT NULL,
    conversation_id TEXT,
    generation_id TEXT,
    model TEXT,
    model_id TEXT,
    user_email TEXT,
    workspace TEXT,
    git_branch TEXT,
    pr_number INTEGER,
    repo TEXT,
    status TEXT,
    subagent_id TEXT,
    subagent_type TEXT,
    text TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    context_tokens INTEGER,
    context_window INTEGER,
    context_usage_percent REAL,
    message_count INTEGER,
    duration_ms INTEGER,
    payload_json TEXT NOT NULL
);

CREATE INDEX idx_events_branch ON events (git_branch);
CREATE INDEX idx_events_pr ON events (pr_number);
CREATE INDEX idx_events_user ON events (user_email);
CREATE INDEX idx_events_conversation ON events (conversation_id);
CREATE INDEX idx_events_repo_branch ON events (repo, git_branch);
