import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  buildIngestPayload,
  inferPrNumber,
  isClaudeHookEvent,
  logHookWarning,
  normalizeHookEventName,
  runHook,
  sanitizePayload,
} from "../.cursor/hooks/ingest.mjs";

const fixturesDir = path.resolve(import.meta.dirname, "fixtures");

const loadFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.resolve(fixturesDir, name), "utf-8")) as Record<
    string,
    unknown
  >;

describe("hook stdin → payload mapping", () => {
  it("maps beforeSubmitPrompt to a stored prompt", () => {
    const payload = buildIngestPayload(loadFixture("beforeSubmitPrompt.json"), {
      git_branch: "feat/usage",
      repo: "jackmcpickle/ai-dev-insights",
    });
    expect(payload).toMatchObject({
      conversation_id: "conv-prompt-1",
      generation_id: "gen-prompt-1",
      git_branch: "feat/usage",
      hook_event: "beforeSubmitPrompt",
      model: "cursor-grok-4.6-high-fast",
      repo: "jackmcpickle/ai-dev-insights",
      text: "Summarize token use on this PR",
      user_email: "dev@example.com",
    });
  });

  it("keeps preCompact context fields", () => {
    const compact = buildIngestPayload(loadFixture("preCompact.json"));
    expect(compact.usage).toMatchObject({
      context_tokens: 120_000,
      context_usage_percent: 85,
      context_window_size: 128_000,
    });
  });

  it("keeps stop token fields", () => {
    const stop = buildIngestPayload(loadFixture("stop.json"));
    expect(stop.status).toBe("completed");
    expect(stop.usage).toMatchObject({
      cache_read_tokens: 1_007_022,
      cache_write_tokens: 173_957,
      input_tokens: 1_180_993,
      output_tokens: 8146,
    });
  });

  it("reads git_branch from subagentStart and thoughts from afterAgentThought", () => {
    const start = buildIngestPayload(loadFixture("subagentStart.json"));
    expect(start.git_branch).toBe("cursor/agent-hooks-ingest-f9cb");
    expect(start.subagent_type).toBe("explore");
    expect(start.text).toBe("Find the ingest auth path");

    const thought = buildIngestPayload(loadFixture("afterAgentThought.json"));
    expect(thought.text).toContain("usage fields");
    expect(thought.usage.duration_ms).toBe(1800);
  });

  it("maps Claude UserPromptSubmit and Stop into canonical hook events", () => {
    const prompt = buildIngestPayload(
      loadFixture("claudeUserPromptSubmit.json"),
      {
        git_branch: "main",
        repo: "jackmcpickle/ai-dev-insights",
      }
    );
    expect(prompt).toMatchObject({
      conversation_id: "claude-session-1",
      hook_event: "beforeSubmitPrompt",
      text: "Add Claude hook support to ai-dev-insights",
    });
    expect(normalizeHookEventName("UserPromptSubmit")).toBe("beforeSubmitPrompt");
    expect(isClaudeHookEvent("UserPromptSubmit")).toBe(true);
    expect(isClaudeHookEvent("beforeSubmitPrompt")).toBe(false);

    const stop = buildIngestPayload(loadFixture("claudeStop.json"), {
      git_branch: "main",
    });
    expect(stop).toMatchObject({
      hook_event: "stop",
      text: "Added Claude Code hooks and an insights HTML page.",
    });
  });

  it("redacts file contents and secret-looking keys", () => {
    const payload = buildIngestPayload(loadFixture("beforeReadFile.json"));
    const sanitized = payload.payload as Record<string, unknown>;
    expect(sanitized.content).toBe("[redacted]");
    expect(sanitized.authorization).toBe("[redacted]");
    expect(JSON.stringify(payload)).not.toContain("super-secret-value");
  });

  it("infers PR numbers from branch names without guessing hex suffixes", () => {
    expect(inferPrNumber({ branch: "pr-42" })).toBe(42);
    expect(inferPrNumber({ branch: "feat/pull-7" })).toBe(7);
    expect(
      inferPrNumber({ branch: "cursor/agent-hooks-ingest-f9cb" })
    ).toBeNull();
    expect(inferPrNumber({ branch: "main", explicit: "18" })).toBe(18);
  });

  it("logs ingest failures to .cursor/hooks.log and stays silent for Claude", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-dev-insights-hook-"));
    const logPath = path.join(dir, ".cursor/hooks.log");
    let stdout = "";

    await runHook({
      env: {
        CLAUDE_PROJECT_DIR: dir,
        INGEST_TOKEN: "test-token",
        INGEST_URL: "https://insights.test",
      },
      fetchImpl: (() => {
        throw new Error("offline");
      }) as typeof fetch,
      readStdin: () =>
        Promise.resolve(JSON.stringify(loadFixture("claudeStop.json"))),
      resolveGit: () => ({
        git_branch: "main",
        repo: "jackmcpickle/ai-dev-insights",
        workspace_root: dir,
      }),
      write: (text) => {
        stdout += text;
      },
    });

    expect(stdout).toBe("");
    expect(readFileSync(logPath, "utf-8")).toContain(
      "ingest failed for stop: offline"
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes hook warnings to the project log file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-dev-insights-log-"));
    logHookWarning(dir, "test warning");
    expect(readFileSync(path.join(dir, ".cursor/hooks.log"), "utf-8")).toContain(
      "test warning"
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("POSTs the mapped payload and still prints {} when the network fails", async () => {
    const posts: { url: string; body: unknown }[] = [];
    let stdout = "";

    await runHook({
      env: {
        INGEST_TOKEN: "test-token",
        INGEST_URL: "https://insights.test",
      },
      fetchImpl: ((input, init) => {
        posts.push({
          body: JSON.parse(String(init?.body)),
          url: String(input),
        });
        throw new Error("offline");
      }) as typeof fetch,
      readStdin: () =>
        Promise.resolve(JSON.stringify(loadFixture("stop.json"))),
      resolveGit: () => ({
        git_branch: "feat/usage",
        repo: "jackmcpickle/ai-dev-insights",
        workspace_root: "/workspace",
      }),
      write: (text) => {
        stdout += text;
      },
    });

    expect(stdout).toBe("{}\n");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://insights.test/v1/ingest");
    const body = posts[0].body as { hook_event: string; git_branch: string };
    expect(body.hook_event).toBe("stop");
    expect(body.git_branch).toBe("feat/usage");
  });

  it("fail-opens when spawned as a process against a dead ingest URL", async () => {
    const child = spawn(
      process.execPath,
      [path.resolve(".cursor/hooks/ingest.mjs")],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          INGEST_TOKEN: "unused",
          INGEST_URL: "http://127.0.0.1:1",
        },
      }
    );
    child.stdin.end(JSON.stringify(loadFixture("stop.json")));
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    const [code] = (await once(child, "close")) as [number | null];
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("{}");
  });
});

describe("hook process against a live ingest listener", () => {
  it("POSTs a fixture and the listener sees the mapped body", async () => {
    const received: {
      auth: string | undefined;
      body: Record<string, unknown>;
    }[] = [];

    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({
          auth: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<
            string,
            unknown
          >,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: 1, ok: true }));
      });
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected tcp address");
    }

    const child = spawn(
      process.execPath,
      [path.resolve(".cursor/hooks/ingest.mjs")],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          CURSOR_USER_EMAIL: "dev@example.com",
          INGEST_TOKEN: "fixture-token",
          INGEST_URL: `http://127.0.0.1:${address.port}`,
        },
      }
    );
    child.stdin.end(
      JSON.stringify({
        ...loadFixture("beforeSubmitPrompt.json"),
        git_branch: "pr-9",
      })
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    const [code] = (await once(child, "close")) as [number | null];
    await promisify(server.close.bind(server))();

    expect(code).toBe(0);
    expect(stdout.trim()).toBe("{}");
    expect(received).toHaveLength(1);
    expect(received[0].auth).toBe("Bearer fixture-token");
    expect(received[0].body).toMatchObject({
      hook_event: "beforeSubmitPrompt",
      pr_number: 9,
      text: "Summarize token use on this PR",
    });
  });

  it("redacts sensitive payload keys", () => {
    expect(sanitizePayload({ content: "secret" })).toStrictEqual({
      content: "[redacted]",
    });
    expect(
      sanitizePayload({
        access_token: "leak",
        input_tokens: 12,
        refresh_token: "also",
        sessionToken: "nope",
      })
    ).toStrictEqual({
      access_token: "[redacted]",
      input_tokens: 12,
      refresh_token: "[redacted]",
      sessionToken: "[redacted]",
    });
  });
});
