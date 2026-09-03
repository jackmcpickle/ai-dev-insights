import type { IngestPayload } from "./types";

const parseOptionalFloor = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : null;

const parseOptionalReceivedAt = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return undefined;
};

const normalizeWorkspaceRoots = (roots: unknown): string[] =>
  Array.isArray(roots)
    ? roots.filter((root): root is string => typeof root === "string")
    : [];

const normalizeIds = (body: IngestPayload) => ({
  conversation_id: body.conversation_id ?? null,
  cursor_version: body.cursor_version ?? null,
  generation_id: body.generation_id ?? null,
  subagent_id: body.subagent_id ?? null,
  subagent_type: body.subagent_type ?? null,
});

const normalizeContext = (body: IngestPayload) => ({
  git_branch: body.git_branch ?? null,
  model: body.model ?? null,
  model_id: body.model_id ?? null,
  repo: body.repo ?? null,
  user_email: body.user_email ?? null,
});

const normalizeEventState = (body: IngestPayload) => ({
  payload: body.payload ?? {},
  pr_number: parseOptionalFloor(body.pr_number),
  received_at: parseOptionalReceivedAt(body.received_at),
  status: body.status ?? null,
  text: body.text ?? null,
  usage: body.usage ?? {},
  workspace_roots: normalizeWorkspaceRoots(body.workspace_roots),
});

export const toIngestPayload = (body: IngestPayload): IngestPayload => ({
  ...normalizeIds(body),
  ...normalizeContext(body),
  ...normalizeEventState(body),
  hook_event: body.hook_event,
});
