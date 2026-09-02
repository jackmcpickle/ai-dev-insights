import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { runInsightsPass } from "../src/insights";
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

const ingestCorpus = async (app: ReturnType<typeof createApp>) => {
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
};

describe("fixture insights pass", () => {
  it("proposes skill work, names hotspots, and lists what not to change", async () => {
    const store = createMemoryStore();
    const app = createApp({ store });
    await ingestCorpus(app);

    const api = await app.request(
      "/v1/insights",
      { headers: { authorization: `Bearer ${TOKEN}` } },
      env()
    );
    expect(api.status).toBe(200);
    const body = (await api.json()) as {
      insights: ReturnType<typeof runInsightsPass>;
    };
    const report = body.insights;
    const local = runInsightsPass(store.events);
    expect(report.proposed_skills.map((row) => row.title)).toStrictEqual(
      local.proposed_skills.map((row) => row.title)
    );

    const skillTitles = report.proposed_skills.map((row) => row.title);
    const hotspotTitles = report.hotspots.map((row) => row.title);
    const doNotChangeTitles = report.do_not_change.map((row) => row.title);
    expect({
      hasRecipeSkill: skillTitles.some((title) =>
        title.includes("repeated recipe")
      ),
      hasWorkersSkill: skillTitles.some((title) =>
        title.includes("workers-best-practices")
      ),
      namesConvAuthHotspot: hotspotTitles.some((title) =>
        title.includes("conv-auth")
      ),
      namesPr4Hotspot: hotspotTitles.some((title) => title.includes("PR #4")),
      skipsAutoApply: doNotChangeTitles.some((title) =>
        title.includes("auto-apply")
      ),
      skipsConvOk: doNotChangeTitles.some((title) => title.includes("conv-ok")),
      skipsInventedTokens: doNotChangeTitles.some((title) =>
        title.includes("invent billed tokens")
      ),
    }).toStrictEqual({
      hasRecipeSkill: true,
      hasWorkersSkill: true,
      namesConvAuthHotspot: true,
      namesPr4Hotspot: true,
      skipsAutoApply: true,
      skipsConvOk: true,
      skipsInventedTokens: true,
    });
  });
});
