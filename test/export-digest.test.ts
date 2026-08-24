import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { extractSkillMentions, looksLikeCorrection } from "../src/mentions";
import { createMemoryStore } from "../src/store";
import type { IngestPayload } from "../src/types";

const TOKEN = "test-ingest-token";
const corpus = JSON.parse(
    readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/insights-corpus.json"),
        "utf8",
    ),
) as IngestPayload[];

function env(): Env {
    return { INGEST_TOKEN: TOKEN, DB: {} as D1Database };
}

async function seed() {
    const store = createMemoryStore();
    const app = createApp({ store });
    for (const event of corpus) {
        const res = await app.request(
            "/v1/ingest",
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${TOKEN}`,
                },
                body: JSON.stringify(event),
            },
            env(),
        );
        expect(res.status).toBe(200);
    }
    return { app, store };
}

describe("skill mention detection", () => {
    it("finds SKILL.md paths, /skill, @skill, and slash insight commands", () => {
        expect(
            extractSkillMentions(
                "Read skills/unslop/SKILL.md then /agent-insights",
            ),
        ).toEqual(["agent-insights", "unslop"]);
        expect(extractSkillMentions("Please /skill workers-best-practices")).toEqual(
            ["workers-best-practices"],
        );
        expect(extractSkillMentions("See @skill:typescript-best-practices")).toEqual(
            ["typescript-best-practices"],
        );
        expect(
            extractSkillMentions("Use the workers-best-practices skill instead"),
        ).toEqual(["workers-best-practices"]);
        expect(extractSkillMentions("curl /v1/usage")).toEqual([]);
    });

    it("flags correction prompts", () => {
        expect(
            looksLikeCorrection(
                "That's wrong. Use the workers-best-practices skill instead.",
            ),
        ).toBe(true);
        expect(looksLikeCorrection("Fix the typo in README.")).toBe(false);
    });
});

describe("export and digest APIs", () => {
    it("rejects unauthenticated export", async () => {
        const { app } = await seed();
        const res = await app.request("/v1/events", {}, env());
        expect(res.status).toBe(401);
    });

    it("lists events with filters, skill mentions, and pagination", async () => {
        const { app } = await seed();
        const headers = { authorization: `Bearer ${TOKEN}` };

        const page1 = await app.request("/v1/events?limit=3", { headers }, env());
        expect(page1.status).toBe(200);
        const first = (await page1.json()) as {
            events: Array<{ id: number; hook_event: string }>;
            next_cursor: number | null;
            limit: number;
        };
        expect(first.limit).toBe(3);
        expect(first.events).toHaveLength(3);
        expect(first.next_cursor).toBe(3);

        const page2 = await app.request(
            `/v1/events?limit=3&after_id=${first.next_cursor}`,
            { headers },
            env(),
        );
        const second = (await page2.json()) as {
            events: Array<{ id: number }>;
            next_cursor: number | null;
        };
        expect(second.events[0]?.id).toBe(4);

        const filtered = await app.request(
            "/v1/events?repo=jackmcpickle/ai-dev-insights&hook=beforeSubmitPrompt&conversation_id=conv-auth",
            { headers },
            env(),
        );
        const body = (await filtered.json()) as {
            events: Array<{
                text: string;
                skill_mentions: string[];
                conversation_id: string;
            }>;
        };
        expect(body.events).toHaveLength(2);
        expect(body.events[1]?.skill_mentions).toContain("workers-best-practices");

        const dated = await app.request(
            "/v1/events?since=1700000300000&until=1700000301000",
            { headers },
            env(),
        );
        const window = (await dated.json()) as { events: unknown[] };
        expect(window.events).toHaveLength(2);
    });

    it("builds a compact digest over the corpus", async () => {
        const { app } = await seed();
        const res = await app.request(
            "/v1/digest?repo=jackmcpickle/ai-dev-insights",
            { headers: { authorization: `Bearer ${TOKEN}` } },
            env(),
        );
        expect(res.status).toBe(200);
        const digest = (await res.json()) as {
            event_count: number;
            conversation_count: number;
            skills: Array<{ name: string }>;
            retries: Array<{ conversation_id: string }>;
            failures: Array<{ conversation_id: string }>;
            high_token_prs: Array<{ pr_number: number | null; input_tokens: number | null }>;
            corrections: Array<{ conversation_id: string }>;
            recipes: Array<{ count: number }>;
            note: string;
        };
        expect(digest.event_count).toBe(11);
        expect(digest.conversation_count).toBe(5);
        expect(digest.skills.map((row) => row.name)).toEqual(
            expect.arrayContaining([
                "unslop",
                "agent-insights",
                "workers-best-practices",
            ]),
        );
        expect(digest.failures.map((row) => row.conversation_id)).toContain(
            "conv-auth",
        );
        expect(digest.retries.map((row) => row.conversation_id)).toContain(
            "conv-auth",
        );
        expect(digest.high_token_prs[0]?.pr_number).toBe(4);
        expect(digest.high_token_prs[0]?.input_tokens).toBe(450000);
        expect(digest.corrections[0]?.conversation_id).toBe("conv-auth");
        expect(digest.recipes[0]?.count).toBe(2);
        expect(digest.note).toContain("Token fields are optional");
    });
});
