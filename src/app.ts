import { Hono } from "hono";

import { isAuthorized } from "./auth";
import { formatPrComment } from "./comment";
import { renderDashboard } from "./dashboard";
import { buildDigest } from "./digest";
import {
  DIGEST_EVENT_CAP,
  EXPORT_DEFAULT_LIMIT,
  nextCursor,
  parseEventFilter,
  toExportEvent,
} from "./export";
import { runInsightsPass } from "./insights";
import { createD1Store } from "./store";
import type { IngestPayload, InsightsStore } from "./types";
import { isIngestPayload, summarizeEvents } from "./usage";

export interface AppEnv {
  Bindings: Env;
  Variables: { store: InsightsStore };
}

const MAX_BODY_BYTES = 256_000;

const parseOptionalFloor = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : null;

const parseOptionalReceivedAt = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return undefined;
};

const toIngestPayload = (body: IngestPayload): IngestPayload => ({
  conversation_id: body.conversation_id ?? null,
  cursor_version: body.cursor_version ?? null,
  generation_id: body.generation_id ?? null,
  git_branch: body.git_branch ?? null,
  hook_event: body.hook_event,
  model: body.model ?? null,
  model_id: body.model_id ?? null,
  payload: body.payload ?? {},
  pr_number: parseOptionalFloor(body.pr_number),
  received_at: parseOptionalReceivedAt(body.received_at),
  repo: body.repo ?? null,
  status: body.status ?? null,
  subagent_id: body.subagent_id ?? null,
  subagent_type: body.subagent_type ?? null,
  text: body.text ?? null,
  usage: body.usage ?? {},
  user_email: body.user_email ?? null,
  workspace_roots: Array.isArray(body.workspace_roots)
    ? body.workspace_roots.filter(
        (root): root is string => typeof root === "string"
      )
    : [],
});

const registerIngestRoute = (app: Hono<AppEnv>): void => {
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

    const stored = await c.get("store").insertEvent(toIngestPayload(body));

    return c.json({ id: stored.id, ok: true });
  });
};

const registerReadRoutes = (app: Hono<AppEnv>): void => {
  app.get("/v1/usage", async (c) => {
    const filter = parseEventFilter(new URL(c.req.url));
    const events = await c.get("store").queryEvents({
      ...filter,
      limit: DIGEST_EVENT_CAP,
    });
    return c.json(summarizeEvents(events, filter));
  });

  app.get("/v1/usage/comment", async (c) => {
    const filter = parseEventFilter(new URL(c.req.url));
    const events = await c.get("store").queryEvents({
      ...filter,
      limit: DIGEST_EVENT_CAP,
    });
    const report = summarizeEvents(events, filter);
    return c.json({
      markdown: formatPrComment(report),
      report,
    });
  });

  app.get("/v1/events", async (c) => {
    const filter = parseEventFilter(new URL(c.req.url));
    const limit = filter.limit ?? EXPORT_DEFAULT_LIMIT;
    const events = await c.get("store").queryEvents({ ...filter, limit });
    return c.json({
      events: events.map(toExportEvent),
      limit,
      next_cursor: nextCursor(events, limit),
    });
  });

  app.get("/v1/digest", async (c) => {
    const filter = parseEventFilter(new URL(c.req.url));
    const events = await c.get("store").queryEvents({
      ...filter,
      limit: DIGEST_EVENT_CAP,
    });
    return c.json(buildDigest(events, filter));
  });

  app.get("/v1/insights", async (c) => {
    const filter = parseEventFilter(new URL(c.req.url));
    const events = await c.get("store").queryEvents({
      ...filter,
      limit: DIGEST_EVENT_CAP,
    });
    return c.json({
      digest: buildDigest(events, filter),
      insights: runInsightsPass(events),
    });
  });

  app.get("/", async (c) => {
    const filter = parseEventFilter(new URL(c.req.url));
    const events = await c.get("store").queryEvents({
      ...filter,
      limit: DIGEST_EVENT_CAP,
    });
    return c.html(renderDashboard(summarizeEvents(events, filter)));
  });
};

export const createApp = (opts?: { store?: InsightsStore }): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  app.use("*", (c, next) => {
    c.set("store", opts?.store ?? createD1Store(c.env.DB));
    return next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    if (!isAuthorized(c.req.raw, c.env.INGEST_TOKEN)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return await next();
  });

  app.use("/", async (c, next) => {
    if (c.req.method !== "GET") {
      return await next();
    }
    if (!isAuthorized(c.req.raw, c.env.INGEST_TOKEN)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return await next();
  });

  registerIngestRoute(app);
  registerReadRoutes(app);

  return app;
};
