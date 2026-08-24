import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { runInsightsPass } from "../src/insights";
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

describe("fixture insights pass", () => {
    it("proposes skill work, names hotspots, and lists what not to change", async () => {
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

        const api = await app.request(
            "/v1/insights",
            { headers: { authorization: `Bearer ${TOKEN}` } },
            env(),
        );
        expect(api.status).toBe(200);
        const body = (await api.json()) as {
            insights: ReturnType<typeof runInsightsPass>;
        };
        const report = body.insights;
        const local = runInsightsPass(store.events);
        expect(report.proposed_skills.map((row) => row.title)).toEqual(
            local.proposed_skills.map((row) => row.title),
        );

        expect(
            report.proposed_skills.some((row) =>
                row.title.includes("workers-best-practices"),
            ),
        ).toBe(true);
        expect(
            report.proposed_skills.some((row) =>
                row.title.includes("repeated recipe"),
            ),
        ).toBe(true);
        expect(
            report.hotspots.some((row) => row.title.includes("PR #4")),
        ).toBe(true);
        expect(
            report.hotspots.some((row) => row.title.includes("conv-auth")),
        ).toBe(true);
        expect(
            report.do_not_change.some((row) =>
                row.title.includes("invent billed tokens"),
            ),
        ).toBe(true);
        expect(
            report.do_not_change.some((row) => row.title.includes("auto-apply")),
        ).toBe(true);
        expect(
            report.do_not_change.some((row) => row.title.includes("conv-ok")),
        ).toBe(true);
    });
});
