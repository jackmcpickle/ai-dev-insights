import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { extractBearer, isAuthorized, timingSafeEqual } from "../src/auth";
import { formatPrComment } from "../src/comment";
import { createMemoryStore } from "../src/store";
import { summarizeEvents } from "../src/usage";
import { buildIngestPayload } from "../.cursor/hooks/ingest.mjs";

const fixturesDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
);
const TOKEN = "test-ingest-token";

function loadFixture(name: string): Record<string, unknown> {
    return JSON.parse(
        readFileSync(resolve(fixturesDir, name), "utf8"),
    ) as Record<string, unknown>;
}

function env(): Env {
    return { INGEST_TOKEN: TOKEN, DB: {} as D1Database };
}

async function ingest(
    app: ReturnType<typeof createApp>,
    body: unknown,
    token = TOKEN,
) {
    return app.request(
        "/v1/ingest",
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
        },
        env(),
    );
}

describe("ingest auth", () => {
    it("extracts bearer tokens and compares them in constant time", () => {
        expect(extractBearer("Bearer abc")).toBe("abc");
        expect(extractBearer("basic abc")).toBeNull();
        expect(timingSafeEqual("same", "same")).toBe(true);
        expect(timingSafeEqual("same", "other")).toBe(false);
        expect(
            isAuthorized(
                new Request("https://x.test/v1/ingest", {
                    headers: { authorization: `Bearer ${TOKEN}` },
                }),
                TOKEN,
            ),
        ).toBe(true);
    });

    it("leaves /health public", async () => {
        const app = createApp({ store: createMemoryStore() });
        const res = await app.request("/health", {}, env());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });

    it("rejects missing and wrong tokens", async () => {
        const app = createApp({ store: createMemoryStore() });

        const missing = await app.request(
            "/v1/ingest",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ hook_event: "stop" }),
            },
            env(),
        );
        expect(missing.status).toBe(401);

        const wrong = await ingest(
            app,
            { hook_event: "stop" },
            "nope",
        );
        expect(wrong.status).toBe(401);
    });

    it("rejects an empty token even if the header is present", async () => {
        const app = createApp({ store: createMemoryStore() });
        const res = await app.request(
            "/v1/ingest",
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer ",
                },
                body: JSON.stringify({ hook_event: "stop" }),
            },
            { INGEST_TOKEN: "", DB: {} as D1Database },
        );
        expect(res.status).toBe(401);
    });

    it("accepts a valid token, persists the event, and summarizes the PR", async () => {
        const store = createMemoryStore();
        const app = createApp({ store });
        const extras = {
            git_branch: "feat/usage",
            repo: "jackmcpickle/ai-dev-insights",
            pr_number: 12,
        };

        for (const name of [
            "beforeSubmitPrompt.json",
            "afterAgentThought.json",
            "afterAgentResponse.json",
            "stop.json",
            "preCompact.json",
            "subagentStart.json",
            "subagentStop.json",
        ]) {
            const mapped = {
                ...buildIngestPayload(loadFixture(name), extras),
                git_branch: extras.git_branch,
                pr_number: extras.pr_number,
                repo: extras.repo,
            };
            const res = await ingest(app, mapped);
            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ ok: true });
        }

        expect(store.events).toHaveLength(7);

        const usageRes = await app.request(
            "/v1/usage?branch=feat/usage&pr=12",
            { headers: { authorization: `Bearer ${TOKEN}` } },
            env(),
        );
        expect(usageRes.status).toBe(200);
        const usageBody = (await usageRes.json()) as {
            totals: { input_tokens: number; prompt_count: number };
        };
        expect(usageBody.totals.prompt_count).toBe(1);
        expect(usageBody.totals.input_tokens).toBe(1180993);

        const report = summarizeEvents(store.events, {
            branch: "feat/usage",
            pr: 12,
        });
        expect(report.totals.prompt_count).toBe(1);
        expect(report.totals.thought_count).toBe(1);
        expect(report.totals.response_count).toBe(1);
        expect(report.totals.stop_count).toBe(1);
        expect(report.totals.compact_count).toBe(1);
        expect(report.totals.subagent_count).toBe(2);
        expect(report.totals.input_tokens).toBe(1180993);
        expect(report.totals.output_tokens).toBe(8146);
        expect(report.totals.max_context_tokens).toBe(120000);
        expect(report.totals.turns_with_token_fields).toBe(1);
        expect(report.totals.turns_missing_token_fields).toBe(0);

        const comment = formatPrComment(report);
        expect(comment).toContain("PR #12");
        expect(comment).toContain("1,180,993");
        expect(comment).toContain("Token fields are optional");
    });

    it("includes branch-only events when a PR query also sends the branch", async () => {
        const store = createMemoryStore();
        const app = createApp({ store });
        await ingest(app, {
            hook_event: "stop",
            git_branch: "feat/usage",
            repo: "jackmcpickle/ai-dev-insights",
            conversation_id: "c-branch",
            generation_id: "g-branch",
            usage: { input_tokens: 10, output_tokens: 1 },
        });

        const usageRes = await app.request(
            "/v1/usage?branch=feat/usage&pr=12&repo=jackmcpickle/ai-dev-insights",
            { headers: { authorization: `Bearer ${TOKEN}` } },
            env(),
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
            }),
        );
        await ingest(app, {
            hook_event: "stop",
            conversation_id: "conv-prompt-1",
            generation_id: "gen-prompt-1",
            git_branch: "feat/usage",
            status: "completed",
        });

        const report = summarizeEvents(store.events, { branch: "feat/usage" });
        expect(report.totals.input_tokens).toBe(1180993);
        expect(report.totals.turns_with_token_fields).toBe(1);
        expect(report.totals.turns_missing_token_fields).toBe(0);
    });

    it("does not double-count stop and afterAgentResponse for one generation", async () => {
        const store = createMemoryStore();
        const app = createApp({ store });
        const extras = { git_branch: "feat/usage", pr_number: 3 };

        await ingest(
            app,
            buildIngestPayload(loadFixture("afterAgentResponse.json"), extras),
        );
        await ingest(
            app,
            buildIngestPayload(loadFixture("stop.json"), extras),
        );

        const report = summarizeEvents(store.events, { pr: 3 });
        expect(report.totals.input_tokens).toBe(1180993);
        expect(report.totals.turns_with_token_fields).toBe(1);
    });
});
