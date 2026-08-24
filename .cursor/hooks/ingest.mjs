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
import { resolve } from "node:path";
import { stdin } from "node:process";
import { fileURLToPath } from "node:url";

const TEXT_LIMIT = 8_192;

const SENSITIVE_KEY =
    /^(content|authorization|api[_-]?key|secret|password|token|credential|private[_-]?key)$/iu;
const SENSITIVE_SUBSTR =
    /(api[_-]?key|token|secret|password|credential|private[_-]?key|authorization)/iu;
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

/** @param {unknown} value */
export function asRecord(value) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return /** @type {Record<string, unknown>} */ (value);
    }
    return null;
}

/** @param {unknown} value */
export function asString(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return null;
}

/** @param {unknown} value */
export function asNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/** @param {string | null | undefined} text @param {number} [limit] */
export function truncate(text, limit = TEXT_LIMIT) {
    if (text == null) return null;
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}…`;
}

/**
 * @param {{ branch?: string | null, explicit?: unknown }} args
 */
export function inferPrNumber({ branch, explicit } = {}) {
    const fromExplicit = asNumber(explicit);
    if (fromExplicit != null && fromExplicit > 0) {
        return Math.floor(fromExplicit);
    }
    if (!branch) return null;
    const patterns = [
        /(?:^|[-/_])pr[-/_](\d+)$/iu,
        /(?:^|[-/_])pull[-/_](\d+)$/iu,
        /#(\d+)/u,
    ];
    for (const re of patterns) {
        const match = branch.match(re);
        if (match) return Number(match[1]);
    }
    return null;
}

/** @param {string | null | undefined} remote */
export function parseGitRemote(remote) {
    if (!remote) return null;
    const cleaned = remote.trim().replace(/\.git$/u, "");
    const ssh = cleaned.match(/[:/]([^/]+\/[^/]+)$/u);
    return ssh?.[1] ?? null;
}

/** @param {Record<string, unknown>} event */
export function extractUsage(event) {
    /** @type {Record<string, number>} */
    const usage = {};
    const sources = [event];
    const nested = asRecord(event.usage);
    if (nested) sources.push(nested);
    const tokenUsage =
        asRecord(event.token_usage) ?? asRecord(event.tokenUsage);
    if (tokenUsage) sources.push(tokenUsage);

    for (const src of sources) {
        for (const key of USAGE_FIELDS) {
            if (usage[key] != null) continue;
            const n = asNumber(src[key]);
            if (n != null) usage[key] = n;
        }
        /** @type {Record<string, unknown>} */
        const camel = {
            input_tokens: src.inputTokens,
            output_tokens: src.outputTokens,
            cache_read_tokens: src.cacheReadTokens,
            cache_write_tokens: src.cacheWriteTokens,
            context_tokens: src.contextTokens,
            context_window_size: src.contextWindowSize ?? src.context_window,
        };
        for (const [key, value] of Object.entries(camel)) {
            if (usage[key] != null) continue;
            const n = asNumber(value);
            if (n != null) usage[key] = n;
        }
    }

    if (usage.duration == null && usage.duration_ms != null) {
        usage.duration = usage.duration_ms;
    }
    if (usage.duration_ms == null && usage.duration != null) {
        usage.duration_ms = usage.duration;
    }
    if (usage.context_window_size == null) {
        const n = asNumber(event.context_window);
        if (n != null) usage.context_window_size = n;
    }

    return usage;
}

/**
 * @param {Record<string, unknown>} event
 * @param {string} hookEvent
 */
function pickText(event, hookEvent) {
    if (hookEvent === "beforeSubmitPrompt") return asString(event.prompt);
    if (
        hookEvent === "afterAgentResponse" ||
        hookEvent === "afterAgentThought"
    ) {
        return asString(event.text);
    }
    if (hookEvent === "subagentStart") return asString(event.task);
    if (hookEvent === "subagentStop") {
        return asString(event.summary) ?? asString(event.task);
    }
    return (
        asString(event.text) ??
        asString(event.prompt) ??
        asString(event.summary)
    );
}

/**
 * @param {unknown} value
 * @param {number} [depth]
 */
export function sanitizePayload(value, depth = 0) {
    if (depth > 6) return "[truncated]";
    if (typeof value === "string") return truncate(value);
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) {
        return value
            .slice(0, 50)
            .map((item) => sanitizePayload(item, depth + 1));
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
}

/**
 * @param {unknown} raw
 * @param {Record<string, unknown>} [extras]
 */
export function buildIngestPayload(raw, extras = {}) {
    const event = asRecord(raw) ?? {};
    const hookEvent =
        asString(event.hook_event_name) ??
        asString(extras.hook_event) ??
        "unknown";
    const branch =
        asString(event.git_branch) ?? asString(extras.git_branch) ?? null;
    const repo = asString(event.repo) ?? asString(extras.repo) ?? null;
    const workspaceRoots = Array.isArray(event.workspace_roots)
        ? event.workspace_roots.filter((item) => typeof item === "string")
        : Array.isArray(extras.workspace_roots)
          ? extras.workspace_roots.filter((item) => typeof item === "string")
          : [];

    return {
        hook_event: hookEvent,
        conversation_id:
            asString(event.conversation_id) ?? asString(event.session_id),
        generation_id: asString(event.generation_id),
        model: asString(event.model),
        model_id: asString(event.model_id),
        user_email:
            asString(event.user_email) ?? asString(extras.user_email),
        workspace_roots: workspaceRoots,
        cursor_version: asString(event.cursor_version),
        git_branch: branch,
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
        payload: sanitizePayload(event),
    };
}

/** @param {string} path */
export function loadEnvFile(path) {
    if (!existsSync(path)) return {};
    /** @type {Record<string, string>} */
    const out = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
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
}

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveIngestConfig(env = process.env) {
    const files = [
        resolve(env.CURSOR_PROJECT_DIR ?? process.cwd(), ".cursor/hooks.env"),
        resolve(homedir(), ".ai-dev-insights.env"),
        resolve(homedir(), ".cursor/hooks.env"),
    ];
    /** @type {Record<string, string>} */
    const fromFiles = {};
    for (const file of files) Object.assign(fromFiles, loadEnvFile(file));
    const merged = { ...fromFiles, ...env };
    return {
        url: merged.INGEST_URL || merged.AI_DEV_INSIGHTS_URL || "",
        token: merged.INGEST_TOKEN || merged.AI_DEV_INSIGHTS_TOKEN || "",
    };
}

/**
 * @param {string} root
 * @param {string[]} args
 */
function git(root, args) {
    try {
        return execFileSync("git", ["-C", root, ...args], {
            encoding: "utf8",
            timeout: 1500,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return null;
    }
}

/** @param {unknown[]} [roots] */
export function resolveGitContext(roots = []) {
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
}

async function readStdin() {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {{ url: string, token: string, body: unknown, fetchImpl?: typeof fetch }} args
 */
export async function postIngest({
    url,
    token,
    body,
    fetchImpl = fetch,
}) {
    const endpoint = `${url.replace(/\/$/u, "")}/v1/ingest`;
    /** @type {Record<string, string>} */
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    return fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(6000),
    });
}

/**
 * @param {{
 *   readStdin?: () => Promise<string>,
 *   fetchImpl?: typeof fetch,
 *   write?: (text: string) => void,
 *   resolveGit?: typeof resolveGitContext,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 */
export async function runHook(opts = {}) {
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
            user_email: process.env.CURSOR_USER_EMAIL ?? null,
            pr_number: process.env.GITHUB_PR_NUMBER ?? null,
        });
        const config = resolveIngestConfig(opts.env ?? process.env);
        if (config.url) {
            await postIngest({
                url: config.url,
                token: config.token,
                body: payload,
                fetchImpl,
            }).catch(() => null);
        }
    } catch {
        // fail-open
    }
    write("{}\n");
}

function isMain() {
    const entry = process.argv[1];
    if (!entry) return false;
    try {
        return fileURLToPath(import.meta.url) === resolve(entry);
    } catch {
        return false;
    }
}

if (isMain()) {
    runHook()
        .catch(() => {
            process.stdout.write("{}\n");
        })
        .finally(() => {
            process.exit(0);
        });
}
