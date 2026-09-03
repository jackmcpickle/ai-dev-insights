import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildIngestPayload } from "../.cursor/hooks/ingest.mjs";
import { createApp } from "../src/app";
import {
  extractBearer,
  extractToken,
  isAuthorized,
  timingSafeEqual,
} from "../src/auth";
import { formatPrComment } from "../src/comment";
import { createMemoryStore } from "../src/store";
import { summarizeEvents } from "../src/usage";

const fixturesDir = path.resolve(import.meta.dirname, "fixtures");
const TOKEN = "test-ingest-token";

const loadFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.resolve(fixturesDir, name), "utf-8")) as Record<
    string,
    unknown
  >;

const env = (): Env => ({ DB: {} as D1Database, INGEST_TOKEN: TOKEN });

const ingest = (
  app: ReturnType<typeof createApp>,
  body: unknown,
  token = TOKEN
) =>
  app.request(
    "/v1/ingest",
    {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
    env()
  );

const fixtureNames = [
  "beforeSubmitPrompt.json",
  "afterAgentThought.json",
  "afterAgentResponse.json",
  "stop.json",
  "preCompact.json",
  "subagentStart.json",
  "subagentStop.json",
] as const;

describe("ingest auth", () => {
  it("extracts bearer tokens and compares them in constant time", () => {
    expect(extractBearer("Bearer abc")).toBe("abc");
    expect(extractBearer("basic abc")).toBeNull();
    expect(timingSafeEqual("same", "same")).toBeTruthy();
    expect(timingSafeEqual("same", "other")).toBeFalsy();
    expect(
      isAuthorized(
        new Request("https://x.test/v1/ingest", {
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
        TOKEN
      )
    ).toBeTruthy();
  });

  it("accepts x-insights-token, x-ingest-token, and query tokens", () => {
    expect(
      extractToken(
        new Request("https://x.test/v1/usage", {
          headers: { "x-insights-token": TOKEN },
        })
      )
    ).toBe(TOKEN);
    expect(
      extractToken(
        new Request("https://x.test/v1/usage", {
          headers: { "x-ingest-token": TOKEN },
        })
      )
    ).toBe(TOKEN);
    expect(extractToken(new Request(`https://x.test/?token=${TOKEN}`))).toBe(
      TOKEN
    );
    expect(
      isAuthorized(new Request(`https://x.test/?token=${TOKEN}`), TOKEN)
    ).toBeTruthy();
  });

  it("leaves /health public", async () => {
    const app = createApp({ store: createMemoryStore() });
    const res = await app.request("/health", {}, env());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toStrictEqual({ ok: true });
  });

  it("rejects missing and wrong tokens", async () => {
    const app = createApp({ store: createMemoryStore() });

    const missing = await app.request(
      "/v1/ingest",
      {
        body: JSON.stringify({ hook_event: "stop" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      env()
    );
    expect(missing.status).toBe(401);

    const wrong = await ingest(app, { hook_event: "stop" }, "nope");
    expect(wrong.status).toBe(401);
  });

  it("rejects an empty token even if the header is present", async () => {
    const app = createApp({ store: createMemoryStore() });
    const res = await app.request(
      "/v1/ingest",
      {
        body: JSON.stringify({ hook_event: "stop" }),
        headers: {
          authorization: "Bearer ",
          "content-type": "application/json",
        },
        method: "POST",
      },
      { DB: {} as D1Database, INGEST_TOKEN: "" }
    );
    expect(res.status).toBe(401);
  });

  it("accepts a valid token, persists the event, and summarizes the PR", async () => {
    const store = createMemoryStore();
    const app = createApp({ store });
    const extras = {
      git_branch: "feat/usage",
      pr_number: 12,
      repo: "jackmcpickle/ai-dev-insights",
    };

    await Promise.all(
      fixtureNames.map(async (name) => {
        const mapped = {
          ...buildIngestPayload(loadFixture(name), extras),
          git_branch: extras.git_branch,
          pr_number: extras.pr_number,
          repo: extras.repo,
        };
        const res = await ingest(app, mapped);
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ ok: true });
      })
    );

    expect(store.events).toHaveLength(7);

    const usageRes = await app.request(
      "/v1/usage?branch=feat/usage&pr=12",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env()
    );
    expect(usageRes.status).toBe(200);
    const usageBody = (await usageRes.json()) as {
      totals: { input_tokens: number; prompt_count: number };
    };
    expect(usageBody.totals).toMatchObject({
      input_tokens: 1_180_993,
      prompt_count: 1,
    });

    const report = summarizeEvents(store.events, {
      branch: "feat/usage",
      pr: 12,
    });
    expect(report.totals).toMatchObject({
      compact_count: 1,
      input_tokens: 1_180_993,
      max_context_tokens: 120_000,
      output_tokens: 8146,
      prompt_count: 1,
      response_count: 1,
      stop_count: 1,
      subagent_count: 2,
      thought_count: 1,
      turns_missing_token_fields: 0,
      turns_with_token_fields: 1,
    });

    const comment = formatPrComment(report);
    expect(comment).toMatch(
      /PR #12[\s\S]*1,180,993[\s\S]*Token fields are optional/u
    );
  });

  it("includes branch-only events when a PR query also sends the branch", async () => {
    const store = createMemoryStore();
    const app = createApp({ store });
    await ingest(app, {
      conversation_id: "c-branch",
      generation_id: "g-branch",
      git_branch: "feat/usage",
      hook_event: "stop",
      repo: "jackmcpickle/ai-dev-insights",
      usage: { input_tokens: 10, output_tokens: 1 },
    });

    const usageRes = await app.request(
      "/v1/usage?branch=feat/usage&pr=12&repo=jackmcpickle/ai-dev-insights",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env()
    );
    const body = (await usageRes.json()) as {
      totals: { event_count: number; input_tokens: number };
    };
    expect(body.totals.event_count).toBe(1);
    expect(body.totals.input_tokens).toBe(10);
  });

  it("keeps afterAgentResponse tokens when stop has none", async () => {
    const store = createMemoryStore();
    const app = createApp({ store });
    await ingest(
      app,
      buildIngestPayload(loadFixture("afterAgentResponse.json"), {
        git_branch: "feat/usage",
      })
    );
    await ingest(app, {
      conversation_id: "conv-prompt-1",
      generation_id: "gen-prompt-1",
      git_branch: "feat/usage",
      hook_event: "stop",
      status: "completed",
    });

    const report = summarizeEvents(store.events, { branch: "feat/usage" });
    expect(report.totals.input_tokens).toBe(1_180_993);
    expect(report.totals.turns_with_token_fields).toBe(1);
    expect(report.totals.turns_missing_token_fields).toBe(0);
  });

  it("returns markdown from /v1/usage/comment", async () => {
    const store = createMemoryStore();
    const app = createApp({ store });
    await ingest(
      app,
      buildIngestPayload(loadFixture("stop.json"), {
        git_branch: "feat/usage",
        pr_number: 7,
      })
    );

    const commentRes = await app.request(
      "/v1/usage/comment?branch=feat/usage&pr=7",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env()
    );
    expect(commentRes.status).toBe(200);
    const commentBody = (await commentRes.json()) as {
      markdown: string;
      report: { totals: { input_tokens: number | null } };
    };
    expect(commentBody).toMatchObject({
      markdown: expect.stringMatching(/<!-- ai-dev-insights -->[\s\S]*PR #7/u),
      report: { totals: { input_tokens: 1_180_993 } },
    });
  });

  it("returns HTML from the dashboard route", async () => {
    const store = createMemoryStore();
    const app = createApp({ store });
    await ingest(
      app,
      buildIngestPayload(loadFixture("stop.json"), {
        git_branch: "feat/usage",
        pr_number: 7,
      })
    );

    const dashRes = await app.request(
      "/?branch=feat/usage&pr=7",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env()
    );
    const html = await dashRes.text();
    expect({
      contentType: dashRes.headers.get("content-type"),
      html,
      status: dashRes.status,
    }).toMatchObject({
      contentType: expect.stringContaining("text/html"),
      html: expect.stringMatching(/AI dev insights[\s\S]*By pull request/u),
      status: 200,
    });
    expect(html).not.toContain("<script");
  });

  it("rejects invalid ingest payloads and oversized bodies", async () => {
    const app = createApp({ store: createMemoryStore() });
    const headers = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };

    const invalid = await app.request(
      "/v1/ingest",
      { body: JSON.stringify({ not_hook: true }), headers, method: "POST" },
      env()
    );
    expect(invalid.status).toBe(400);

    const emptyHook = await app.request(
      "/v1/ingest",
      { body: JSON.stringify({ hook_event: "   " }), headers, method: "POST" },
      env()
    );
    expect(emptyHook.status).toBe(400);

    const tooLarge = await app.request(
      "/v1/ingest",
      {
        body: JSON.stringify({ hook_event: "stop" }),
        headers: { ...headers, "content-length": "300000" },
        method: "POST",
      },
      env()
    );
    expect(tooLarge.status).toBe(413);
  });

  it("does not double-count stop and afterAgentResponse for one generation", async () => {
    const store = createMemoryStore();
    const app = createApp({ store });
    const extras = { git_branch: "feat/usage", pr_number: 3 };

    await ingest(
      app,
      buildIngestPayload(loadFixture("afterAgentResponse.json"), extras)
    );
    await ingest(app, buildIngestPayload(loadFixture("stop.json"), extras));

    const report = summarizeEvents(store.events, { pr: 3 });
    expect(report.totals.input_tokens).toBe(1_180_993);
    expect(report.totals.turns_with_token_fields).toBe(1);
  });
});
