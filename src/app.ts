import { Hono } from "hono";
import { isAuthorized } from "./auth";
import { formatPrComment } from "./comment";
import { renderDashboard } from "./dashboard";
import { createD1Store } from "./store";
import type { InsightsStore, UsageFilter } from "./types";
import { isIngestPayload, summarizeEvents } from "./usage";

export type AppEnv = {
    Bindings: Env;
    Variables: { store: InsightsStore };
};

const MAX_BODY_BYTES = 256_000;

function parseFilter(url: URL): UsageFilter {
    const filter: UsageFilter = {};
    const branch = url.searchParams.get("branch");
    const user = url.searchParams.get("user");
    const repo = url.searchParams.get("repo");
    const prRaw = url.searchParams.get("pr");
    if (branch) filter.branch = branch;
    if (user) filter.user = user;
    if (repo) filter.repo = repo;
    if (prRaw) {
        const pr = Number(prRaw);
        if (Number.isFinite(pr) && pr > 0) filter.pr = Math.floor(pr);
    }
    return filter;
}

export function createApp(opts?: { store?: InsightsStore }): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    app.use("*", async (c, next) => {
        c.set("store", opts?.store ?? createD1Store(c.env.DB));
        await next();
    });

    app.get("/health", (c) => c.json({ ok: true }));

    app.use("/v1/*", async (c, next) => {
        if (!isAuthorized(c.req.raw, c.env.INGEST_TOKEN)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        await next();
    });

    app.use("/", async (c, next) => {
        if (c.req.method !== "GET") return next();
        if (!isAuthorized(c.req.raw, c.env.INGEST_TOKEN)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        await next();
    });

    app.post("/v1/ingest", async (c) => {
        const length = Number(c.req.header("content-length") ?? 0);
        if (length > MAX_BODY_BYTES) {
            return c.json({ error: "payload too large" }, 413);
        }

        const body: unknown = await c.req.json().catch(() => null);
        if (!isIngestPayload(body)) {
            return c.json({ error: "invalid ingest payload" }, 400);
        }
        if (!body.hook_event.trim()) {
            return c.json({ error: "hook_event is required" }, 400);
        }

        const stored = await c.get("store").insertEvent({
            hook_event: body.hook_event,
            conversation_id: body.conversation_id ?? null,
            generation_id: body.generation_id ?? null,
            model: body.model ?? null,
            model_id: body.model_id ?? null,
            user_email: body.user_email ?? null,
            workspace_roots: Array.isArray(body.workspace_roots)
                ? body.workspace_roots.filter(
                      (root): root is string => typeof root === "string",
                  )
                : [],
            cursor_version: body.cursor_version ?? null,
            git_branch: body.git_branch ?? null,
            pr_number:
                typeof body.pr_number === "number" &&
                Number.isFinite(body.pr_number)
                    ? Math.floor(body.pr_number)
                    : null,
            repo: body.repo ?? null,
            status: body.status ?? null,
            subagent_id: body.subagent_id ?? null,
            subagent_type: body.subagent_type ?? null,
            text: body.text ?? null,
            usage: body.usage ?? {},
            payload: body.payload ?? {},
        });

        return c.json({ ok: true, id: stored.id });
    });

    app.get("/v1/usage", async (c) => {
        const filter = parseFilter(new URL(c.req.url));
        const events = await c.get("store").queryEvents(filter);
        return c.json(summarizeEvents(events, filter));
    });

    app.get("/v1/usage/comment", async (c) => {
        const filter = parseFilter(new URL(c.req.url));
        const events = await c.get("store").queryEvents(filter);
        const report = summarizeEvents(events, filter);
        return c.json({
            markdown: formatPrComment(report),
            report,
        });
    });

    app.get("/", async (c) => {
        const filter = parseFilter(new URL(c.req.url));
        const events = await c.get("store").queryEvents(filter);
        return c.html(renderDashboard(summarizeEvents(events, filter)));
    });

    return app;
}
