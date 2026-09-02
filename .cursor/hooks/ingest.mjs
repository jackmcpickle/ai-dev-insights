#!/usr/bin/env node
/**
 * Fail-open Cursor hook. Reads one JSON event on stdin, POSTs it to the
 * ingest API, then always prints `{}` and exits 0.
 *
 * Cloud agents only load project hooks (this file via `.cursor/hooks.json`).
 * User-level `~/.cursor` hooks never run in cloud.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { stdin } from "node:process";

const { resolve } = path;

const TEXT_LIMIT = 8192;

const SENSITIVE_KEY =
  /^(?:content|authorization|api[_-]?key|secret|password|token|credential|private[_-]?key)$/iu;
const SENSITIVE_SUBSTR =
  /(?:api[_-]?key|token|secret|password|credential|private[_-]?key|authorization)/iu;
const KEEP_TOKEN_COUNTS = /tokens$/iu;

const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cache_creation_tokens",
  "reasoning_tokens",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "context_tokens",
  "context_window_size",
  "context_usage_percent",
  "message_count",
  "messages_to_compact",
  "duration_ms",
  "duration",
  "loop_count",
];

/** @param {unknown} value - Value to coerce into a plain object. */
export const asRecord = function asRecord(value) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    /** @type {Record<string, unknown>} */
    const record = value;
    return record;
  }
  return null;
};

/** @param {unknown} value - Value to coerce into a string. */
export const asString = function asString(value) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
};

/** @param {unknown} value - Value to coerce into a finite number. */
export const asNumber = function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return null;
};

/**
 * @param {string | null | undefined} text - Text to truncate.
 * @param {number} [limit] - Maximum character length.
 */
export const truncate = function truncate(text, limit = TEXT_LIMIT) {
  if (text === null || text === undefined) {
    return null;
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}…`;
};

/**
 * @param {{ branch?: string | null, explicit?: unknown }} args - Branch name and optional PR hint.
 */
export const inferPrNumber = function inferPrNumber({ branch, explicit } = {}) {
  const fromExplicit = asNumber(explicit);
  if (fromExplicit !== null && fromExplicit > 0) {
    return Math.floor(fromExplicit);
  }
  if (!branch) {
    return null;
  }
  const patterns = [
    /(?:^|[-/_])pr[-/_](?<num>\d+)$/iu,
    /(?:^|[-/_])pull[-/_](?<num>\d+)$/iu,
    /#(?<num>\d+)/u,
  ];
  for (const re of patterns) {
    const match = branch.match(re);
    if (match?.groups?.num) {
      return Number(match.groups.num);
    }
  }
  return null;
};

/** @param {string | null | undefined} remote - Git remote URL or path. */
export const parseGitRemote = function parseGitRemote(remote) {
  if (!remote) {
    return null;
  }
  const cleaned = remote.trim().replace(/\.git$/u, "");
  const ssh = cleaned.match(/[:/](?<repo>[^/]+\/[^/]+)$/u);
  return ssh?.groups?.repo ?? null;
};

/** @param {Record<string, unknown>} event - Hook event payload. */
export const extractUsage = function extractUsage(event) {
  /** @type {Record<string, number>} */
  const usage = {};
  const sources = [event];
  const nested = asRecord(event.usage);
  if (nested) {
    sources.push(nested);
  }
  const tokenUsage = asRecord(event.token_usage) ?? asRecord(event.tokenUsage);
  if (tokenUsage) {
    sources.push(tokenUsage);
  }

  for (const src of sources) {
    for (const key of USAGE_FIELDS) {
      if (key in usage) {
        continue;
      }
      const n = asNumber(src[key]);
      if (n !== null) {
        usage[key] = n;
      }
    }
    /** @type {Record<string, unknown>} */
    const camel = {
      cache_read_tokens: src.cacheReadTokens,
      cache_write_tokens: src.cacheWriteTokens,
      context_tokens: src.contextTokens,
      context_window_size: src.contextWindowSize ?? src.context_window,
      input_tokens: src.inputTokens,
      output_tokens: src.outputTokens,
    };
    for (const [key, value] of Object.entries(camel)) {
      if (key in usage) {
        continue;
      }
      const n = asNumber(value);
      if (n !== null) {
        usage[key] = n;
      }
    }
  }

  if (!("duration" in usage) && "duration_ms" in usage) {
    usage.duration = usage.duration_ms;
  }
  if (!("duration_ms" in usage) && "duration" in usage) {
    usage.duration_ms = usage.duration;
  }
  if (!("context_window_size" in usage)) {
    const n = asNumber(event.context_window);
    if (n !== null) {
      usage.context_window_size = n;
    }
  }

  return usage;
};

/**
 * @param {Record<string, unknown>} event - Hook event payload.
 * @param {string} hookEvent - Normalized hook event name.
 */
const pickText = function pickText(event, hookEvent) {
  if (hookEvent === "beforeSubmitPrompt") {
    return asString(event.prompt);
  }
  if (hookEvent === "afterAgentResponse" || hookEvent === "afterAgentThought") {
    return asString(event.text);
  }
  if (hookEvent === "subagentStart") {
    return asString(event.task);
  }
  if (hookEvent === "subagentStop") {
    return asString(event.summary) ?? asString(event.task);
  }
  return (
    asString(event.text) ?? asString(event.prompt) ?? asString(event.summary)
  );
};

/**
 * @param {unknown} value - Value to redact and truncate.
 * @param {number} [depth] - Current recursion depth.
 */
export const sanitizePayload = function sanitizePayload(value, depth = 0) {
  if (depth > 6) {
    return "[truncated]";
  }
  if (typeof value === "string") {
    return truncate(value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizePayload(item, depth + 1));
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (
      (SENSITIVE_KEY.test(key) || SENSITIVE_SUBSTR.test(key)) &&
      !KEEP_TOKEN_COUNTS.test(key)
    ) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = sanitizePayload(val, depth + 1);
  }
  return out;
};

/**
 * @param {unknown} raw - Raw hook event from stdin.
 * @param {Record<string, unknown>} [extras] - Git context and env overrides.
 */
export const buildIngestPayload = function buildIngestPayload(
  raw,
  extras = {}
) {
  const event = asRecord(raw) ?? {};
  const hookEvent =
    asString(event.hook_event_name) ?? asString(extras.hook_event) ?? "unknown";
  const branch =
    asString(event.git_branch) ?? asString(extras.git_branch) ?? null;
  const repo = asString(event.repo) ?? asString(extras.repo) ?? null;
  let workspaceRoots = [];
  if (Array.isArray(event.workspace_roots)) {
    workspaceRoots = event.workspace_roots.filter(
      (item) => typeof item === "string"
    );
  } else if (Array.isArray(extras.workspace_roots)) {
    workspaceRoots = extras.workspace_roots.filter(
      (item) => typeof item === "string"
    );
  }

  return {
    conversation_id:
      asString(event.conversation_id) ?? asString(event.session_id),
    cursor_version: asString(event.cursor_version),
    generation_id: asString(event.generation_id),
    git_branch: branch,
    hook_event: hookEvent,
    model: asString(event.model),
    model_id: asString(event.model_id),
    payload: sanitizePayload(event),
    pr_number: inferPrNumber({
      branch,
      explicit: event.pr_number ?? extras.pr_number,
    }),
    repo,
    status: asString(event.status) ?? asString(event.reason),
    subagent_id: asString(event.subagent_id),
    subagent_type: asString(event.subagent_type),
    text: truncate(pickText(event, hookEvent)),
    usage: extractUsage(event),
    user_email: asString(event.user_email) ?? asString(extras.user_email),
    workspace_roots: workspaceRoots,
  };
};

/** @param {string} path - Absolute path to a dotenv-style file. */
export const loadEnvFile = function loadEnvFile(envPath) {
  if (!existsSync(envPath)) {
    return {};
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
};

/** @param {NodeJS.ProcessEnv} [env] - Process environment to merge with hook env files. */
export const resolveIngestConfig = function resolveIngestConfig(
  env = process.env
) {
  const files = [
    resolve(env.CURSOR_PROJECT_DIR ?? process.cwd(), ".cursor/hooks.env"),
    resolve(homedir(), ".ai-dev-insights.env"),
    resolve(homedir(), ".cursor/hooks.env"),
  ];
  /** @type {Record<string, string>} */
  const fromFiles = {};
  for (const file of files) {
    Object.assign(fromFiles, loadEnvFile(file));
  }
  const merged = { ...fromFiles, ...env };
  return {
    token: merged.INGEST_TOKEN || merged.AI_DEV_INSIGHTS_TOKEN || "",
    url: merged.INGEST_URL || merged.AI_DEV_INSIGHTS_URL || "",
  };
};

/**
 * @param {string} root - Git repository root directory.
 * @param {string[]} args - Git command arguments.
 */
const git = function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
  } catch {
    return null;
  }
};

/** @param {unknown[]} [roots] - Workspace root paths from the hook event. */
export const resolveGitContext = function resolveGitContext(roots = []) {
  const listed = roots.find((root) => typeof root === "string" && root);
  const root =
    (typeof listed === "string" ? listed : null) ??
    process.env.CURSOR_PROJECT_DIR ??
    process.cwd();
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const remote = git(root, ["remote", "get-url", "origin"]);
  return {
    git_branch: branch && branch !== "HEAD" ? branch : null,
    repo: parseGitRemote(remote),
    workspace_root: root,
  };
};

const readStdin = async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
};

/**
 * @param {{ url: string, token: string, body: unknown, fetchImpl?: typeof fetch }} args - Ingest POST options.
 */
export const postIngest = function postIngest({
  url,
  token,
  body,
  fetchImpl = fetch,
}) {
  const endpoint = `${url.replace(/\/$/u, "")}/v1/ingest`;
  /** @type {Record<string, string>} */
  const headers = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return fetchImpl(endpoint, {
    body: JSON.stringify(body),
    headers,
    method: "POST",
    signal: AbortSignal.timeout(6000),
  });
};

/**
 * @param {{
 *   readStdin?: () => Promise<string>,
 *   fetchImpl?: typeof fetch,
 *   write?: (text: string) => void,
 *   resolveGit?: typeof resolveGitContext,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts] - Optional hooks for testing and dependency injection.
 */
export const runHook = async function runHook(opts = {}) {
  const read = opts.readStdin ?? readStdin;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const write = opts.write ?? ((text) => process.stdout.write(text));
  try {
    const rawText = await read();
    let parsed = {};
    if (rawText.trim()) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = {};
      }
    }
    const event = asRecord(parsed) ?? {};
    const roots = Array.isArray(event.workspace_roots)
      ? event.workspace_roots
      : [];
    const gitContext = (opts.resolveGit ?? resolveGitContext)(roots);
    const payload = buildIngestPayload(event, {
      ...gitContext,
      pr_number: process.env.GITHUB_PR_NUMBER ?? null,
      user_email: process.env.CURSOR_USER_EMAIL ?? null,
    });
    const config = resolveIngestConfig(opts.env ?? process.env);
    if (config.url) {
      try {
        await postIngest({
          body: payload,
          fetchImpl,
          token: config.token,
          url: config.url,
        });
      } catch {
        // fail-open ingest errors
      }
    }
  } catch {
    // fail-open
  }
  write("{}\n");
};

const isMain = function isMain() {
  const [, entry] = process.argv;
  if (!entry) {
    return false;
  }
  try {
    return import.meta.filename === resolve(entry);
  } catch {
    return false;
  }
};

if (isMain()) {
  try {
    await runHook();
  } catch {
    process.stdout.write("{}\n");
  } finally {
    process.exit(0);
  }
}
