import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
    buildIngestPayload,
    inferPrNumber,
    runHook,
    sanitizePayload,
} from "../.cursor/hooks/ingest.mjs";

const fixturesDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
);

function loadFixture(name: string): Record<string, unknown> {
    return JSON.parse(
        readFileSync(resolve(fixturesDir, name), "utf8"),
    ) as Record<string, unknown>;
}

describe("hook stdin → payload mapping", () => {
    it("maps beforeSubmitPrompt to a stored prompt", () => {
        const payload = buildIngestPayload(
            loadFixture("beforeSubmitPrompt.json"),
            { git_branch: "feat/usage", repo: "jackmcpickle/ai-dev-insights" },
        );
        expect(payload.hook_event).toBe("beforeSubmitPrompt");
        expect(payload.conversation_id).toBe("conv-prompt-1");
        expect(payload.generation_id).toBe("gen-prompt-1");
        expect(payload.model).toBe("cursor-grok-4.6-high-fast");
        expect(payload.user_email).toBe("dev@example.com");
        expect(payload.text).toBe("Summarize token use on this PR");
        expect(payload.git_branch).toBe("feat/usage");
        expect(payload.repo).toBe("jackmcpickle/ai-dev-insights");
    });

    it("keeps preCompact context fields and stop token fields", () => {
        const compact = buildIngestPayload(loadFixture("preCompact.json"));
        expect(compact.usage.context_tokens).toBe(120000);
        expect(compact.usage.context_window_size).toBe(128000);
        expect(compact.usage.context_usage_percent).toBe(85);

        const stop = buildIngestPayload(loadFixture("stop.json"));
        expect(stop.status).toBe("completed");
        expect(stop.usage.input_tokens).toBe(1180993);
        expect(stop.usage.output_tokens).toBe(8146);
        expect(stop.usage.cache_read_tokens).toBe(1007022);
        expect(stop.usage.cache_write_tokens).toBe(173957);
    });

    it("reads git_branch from subagentStart and thoughts from afterAgentThought", () => {
        const start = buildIngestPayload(loadFixture("subagentStart.json"));
        expect(start.git_branch).toBe("cursor/agent-hooks-ingest-f9cb");
        expect(start.subagent_type).toBe("explore");
        expect(start.text).toBe("Find the ingest auth path");

        const thought = buildIngestPayload(
            loadFixture("afterAgentThought.json"),
        );
        expect(thought.text).toContain("usage fields");
        expect(thought.usage.duration_ms).toBe(1800);
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
        expect(inferPrNumber({ branch: "cursor/agent-hooks-ingest-f9cb" })).toBe(
            null,
        );
        expect(inferPrNumber({ explicit: "18", branch: "main" })).toBe(18);
    });

    it("POSTs the mapped payload and still prints {} when the network fails", async () => {
        const posts: Array<{ url: string; body: unknown }> = [];
        let stdout = "";

        await runHook({
            readStdin: async () =>
                JSON.stringify(loadFixture("stop.json")),
            resolveGit: () => ({
                git_branch: "feat/usage",
                repo: "jackmcpickle/ai-dev-insights",
                workspace_root: "/workspace",
            }),
            env: {
                INGEST_URL: "https://insights.test",
                INGEST_TOKEN: "test-token",
            },
            fetchImpl: (async (input, init) => {
                posts.push({
                    url: String(input),
                    body: JSON.parse(String(init?.body)),
                });
                throw new Error("offline");
            }) as typeof fetch,
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
            [resolve(".cursor/hooks/ingest.mjs")],
            {
                cwd: resolve("."),
                env: {
                    ...process.env,
                    INGEST_URL: "http://127.0.0.1:1",
                    INGEST_TOKEN: "unused",
                },
            },
        );
        child.stdin.end(JSON.stringify(loadFixture("stop.json")));
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        const [code] = (await once(child, "close")) as [number | null];
        expect(code).toBe(0);
        expect(stdout.trim()).toBe("{}");
    });
});

describe("hook process against a live ingest listener", () => {
    it("POSTs a fixture and the listener sees the mapped body", async () => {
        const received: Array<{
            auth: string | undefined;
            body: Record<string, unknown>;
        }> = [];

        const server = createServer((req: IncomingMessage, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
                received.push({
                    auth: req.headers.authorization,
                    body: JSON.parse(
                        Buffer.concat(chunks).toString("utf8"),
                    ) as Record<string, unknown>,
                });
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, id: 1 }));
            });
        });

        await new Promise<void>((resolveListen) => {
            server.listen(0, "127.0.0.1", resolveListen);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
            throw new Error("expected tcp address");
        }

        const child = spawn(
            process.execPath,
            [resolve(".cursor/hooks/ingest.mjs")],
            {
                cwd: resolve("."),
                env: {
                    ...process.env,
                    INGEST_URL: `http://127.0.0.1:${address.port}`,
                    INGEST_TOKEN: "fixture-token",
                    CURSOR_USER_EMAIL: "dev@example.com",
                },
            },
        );
        child.stdin.end(
            JSON.stringify({
                ...loadFixture("beforeSubmitPrompt.json"),
                git_branch: "pr-9",
            }),
        );
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        const [code] = (await once(child, "close")) as [number | null];
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));

        expect(code).toBe(0);
        expect(stdout.trim()).toBe("{}");
        expect(received).toHaveLength(1);
        expect(received[0].auth).toBe("Bearer fixture-token");
        expect(received[0].body.hook_event).toBe("beforeSubmitPrompt");
        expect(received[0].body.pr_number).toBe(9);
        expect(received[0].body.text).toBe("Summarize token use on this PR");
        expect(sanitizePayload({ content: "secret" })).toEqual({
            content: "[redacted]",
        });
        expect(
            sanitizePayload({
                access_token: "leak",
                refresh_token: "also",
                sessionToken: "nope",
                input_tokens: 12,
            }),
        ).toEqual({
            access_token: "[redacted]",
            refresh_token: "[redacted]",
            sessionToken: "[redacted]",
            input_tokens: 12,
        });
    });
});
