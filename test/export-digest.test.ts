import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { extractSkillMentions, looksLikeCorrection } from "../src/mentions";
import { createMemoryStore } from "../src/store";
import type { IngestPayload } from "../src/types";

const TOKEN = "test-ingest-token";
const corpus = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, "fixtures/insights-corpus.json"),
    "utf-8"
  )
) as IngestPayload[];

const env = (): Env => ({ DB: {} as D1Database, INGEST_TOKEN: TOKEN });

const seed = async () => {
  const store = createMemoryStore();
  const app = createApp({ store });
  const responses = await Promise.all(
    corpus.map((event) =>
      app.request(
        "/v1/ingest",
        {
          body: JSON.stringify(event),
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          method: "POST",
        },
        env()
      )
    )
  );
  expect(responses.every((res) => res.status === 200)).toBeTruthy();
  return { app, store };
};

describe("skill mention detection", () => {
  it("finds SKILL.md paths, /skill, @skill, and slash insight commands", () => {
    expect(
      extractSkillMentions("Read skills/unslop/SKILL.md then /agent-insights")
    ).toStrictEqual(["agent-insights", "unslop"]);
    expect(
      extractSkillMentions("Please /skill workers-best-practices")
    ).toStrictEqual(["workers-best-practices"]);
    expect(
      extractSkillMentions("See @skill:typescript-best-practices")
    ).toStrictEqual(["typescript-best-practices"]);
    expect(
      extractSkillMentions("Use the workers-best-practices skill instead")
    ).toStrictEqual(["workers-best-practices"]);
    expect(extractSkillMentions("curl /v1/usage")).toStrictEqual([]);
  });

  it("flags correction prompts", () => {
    expect(
      looksLikeCorrection(
        "That's wrong. Use the workers-best-practices skill instead."
      )
    ).toBeTruthy();
    expect(looksLikeCorrection("Fix the typo in README.")).toBeFalsy();
  });
});

describe("export and digest APIs", () => {
  it("rejects unauthenticated export", async () => {
    const { app } = await seed();
    const res = await app.request("/v1/events", {}, env());
    expect(res.status).toBe(401);
  });

  it("pages through exported events", async () => {
    const { app } = await seed();
    const headers = { authorization: `Bearer ${TOKEN}` };

    const page1 = await app.request("/v1/events?limit=3", { headers }, env());
    expect(page1.status).toBe(200);
    const first = (await page1.json()) as {
      events: { id: number; hook_event: string }[];
      next_cursor: number | null;
      limit: number;
    };
    expect(first).toMatchObject({ limit: 3, next_cursor: 3 });
    expect(first.events).toHaveLength(3);

    const page2 = await app.request(
      `/v1/events?limit=3&after_id=${first.next_cursor}`,
      { headers },
      env()
    );
    const second = (await page2.json()) as {
      events: { id: number }[];
      next_cursor: number | null;
    };
    expect(second.events[0]?.id).toBe(4);
  });

  it("filters events by repo, hook, conversation, and time window", async () => {
    const { app } = await seed();
    const headers = { authorization: `Bearer ${TOKEN}` };

    const filtered = await app.request(
      "/v1/events?repo=jackmcpickle/ai-dev-insights&hook=beforeSubmitPrompt&conversation_id=conv-auth",
      { headers },
      env()
    );
    const body = (await filtered.json()) as {
      events: {
        text: string;
        skill_mentions: string[];
        conversation_id: string;
      }[];
    };
    expect(body.events[1]?.skill_mentions).toContain("workers-best-practices");

    const dated = await app.request(
      "/v1/events?since=1700000300000&until=1700000301000",
      { headers },
      env()
    );
    const window = (await dated.json()) as { events: unknown[] };
    expect({
      filteredCount: body.events.length,
      windowCount: window.events.length,
    }).toStrictEqual({
      filteredCount: 2,
      windowCount: 2,
    });
  });

  it("builds a compact digest over the corpus", async () => {
    const { app } = await seed();
    const res = await app.request(
      "/v1/digest?repo=jackmcpickle/ai-dev-insights",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env()
    );
    expect(res.status).toBe(200);
    const digest = (await res.json()) as {
      event_count: number;
      conversation_count: number;
      skills: { name: string }[];
      retries: { conversation_id: string }[];
      failures: { conversation_id: string }[];
      high_token_prs: {
        pr_number: number | null;
        input_tokens: number | null;
      }[];
      corrections: { conversation_id: string }[];
      recipes: { count: number }[];
      note: string;
    };
    const convAuth = "conv-auth";
    const skillNames = new Set(digest.skills.map((row) => row.name));
    expect({
      conversation_count: digest.conversation_count,
      correction: digest.corrections[0]?.conversation_id,
      event_count: digest.event_count,
      hasAgentInsightsSkill: skillNames.has("agent-insights"),
      hasFailure: digest.failures.some(
        (row) => row.conversation_id === convAuth
      ),
      hasRetry: digest.retries.some((row) => row.conversation_id === convAuth),
      hasUnslopSkill: skillNames.has("unslop"),
      hasWorkersSkill: skillNames.has("workers-best-practices"),
      highTokenPr: {
        input_tokens: digest.high_token_prs[0]?.input_tokens,
        pr_number: digest.high_token_prs[0]?.pr_number,
      },
      noteHasTokens: digest.note.includes("Token fields are optional"),
      recipeCount: digest.recipes[0]?.count,
    }).toStrictEqual({
      conversation_count: 5,
      correction: convAuth,
      event_count: 11,
      hasAgentInsightsSkill: true,
      hasFailure: true,
      hasRetry: true,
      hasUnslopSkill: true,
      hasWorkersSkill: true,
      highTokenPr: { input_tokens: 450_000, pr_number: 4 },
      noteHasTokens: true,
      recipeCount: 2,
    });
  });
});
