import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildEventQuery } from "../src/d1-query";
import {
  createD1Store,
  d1InsertEvent,
  d1QueryEvents,
  parsePayloadJson,
  rowToEvent,
  usageFromRow,
} from "../src/store";
import type { EventRow } from "../src/store";

interface D1RunResult {
  meta: { last_row_id?: number | null };
}

interface D1AllResult<T> {
  results?: T[];
}

const createMemoryD1 = (): D1Database => {
  const rows: EventRow[] = [];
  let nextId = 1;

  const rowFromInsertArgs = (args: unknown[]): EventRow => {
    const id = nextId;
    nextId += 1;
    return {
      cache_read_tokens: args[17] as number | null,
      cache_write_tokens: args[18] as number | null,
      context_tokens: args[19] as number | null,
      context_usage_percent: args[21] as number | null,
      context_window: args[20] as number | null,
      conversation_id: args[2] as string | null,
      duration_ms: args[23] as number | null,
      generation_id: args[3] as string | null,
      git_branch: args[8] as string | null,
      hook_event: args[1] as string,
      id,
      input_tokens: args[15] as number | null,
      message_count: args[22] as number | null,
      model: args[4] as string | null,
      model_id: args[5] as string | null,
      output_tokens: args[16] as number | null,
      payload_json: args[24] as string,
      pr_number: args[9] as number | null,
      received_at: args[0] as number,
      repo: args[10] as string | null,
      status: args[11] as string | null,
      subagent_id: args[12] as string | null,
      subagent_type: args[13] as string | null,
      text: args[14] as string | null,
      user_email: args[6] as string | null,
      workspace: args[7] as string | null,
    };
  };

  const filterRows = (sql: string, args: unknown[]): EventRow[] => {
    let filtered = [...rows];
    if (sql.includes("git_branch = ?")) {
      const branch = String(args.shift());
      filtered = filtered.filter((row) => row.git_branch === branch);
    }
    if (sql.includes("pr_number = ?")) {
      const pr = Number(args.shift());
      filtered = filtered.filter((row) => row.pr_number === pr);
    }
    if (sql.includes("hook_event = ?")) {
      const hook = String(args.shift());
      filtered = filtered.filter((row) => row.hook_event === hook);
    }
    if (sql.includes("id > ?")) {
      const afterId = Number(args.shift());
      filtered = filtered.filter((row) => row.id > afterId);
    }
    return filtered.toSorted((a, b) => a.id - b.id);
  };

  return {
    prepare(sql: string) {
      return {
        all: <T>(...args: unknown[]): Promise<D1AllResult<T>> => {
          const limit = Number(args.at(-1));
          const filtered = filterRows(sql, args.slice(0, -1));
          return Promise.resolve({
            results: filtered.slice(0, limit) as T[],
          });
        },
        bind(...args: unknown[]) {
          return {
            all: <T>(): Promise<D1AllResult<T>> => {
              const limit = Number(args.at(-1));
              const filtered = filterRows(sql, args.slice(0, -1));
              return Promise.resolve({
                results: filtered.slice(0, limit) as T[],
              });
            },
            run: (): Promise<D1RunResult> => {
              const row = rowFromInsertArgs(args);
              rows.push(row);
              return Promise.resolve({ meta: { last_row_id: row.id } });
            },
          };
        },
        run: (...args: unknown[]): Promise<D1RunResult> => {
          const row = rowFromInsertArgs(args);
          rows.push(row);
          return Promise.resolve({ meta: { last_row_id: row.id } });
        },
      };
    },
  } as unknown as D1Database;
};

const sampleRow = (): EventRow => ({
  cache_read_tokens: 1,
  cache_write_tokens: 2,
  context_tokens: 3,
  context_usage_percent: 4,
  context_window: 5,
  conversation_id: "c1",
  duration_ms: 6,
  generation_id: "g1",
  git_branch: "feat/x",
  hook_event: "stop",
  id: 1,
  input_tokens: 10,
  message_count: 7,
  model: "model-a",
  model_id: "model-id",
  output_tokens: 20,
  payload_json: '{"ok":true}',
  pr_number: 12,
  received_at: 1_700_000_000_000,
  repo: "org/repo",
  status: "completed",
  subagent_id: null,
  subagent_type: null,
  text: "done",
  user_email: "dev@example.com",
  workspace: "/workspace",
});

describe(buildEventQuery, () => {
  it("builds branch and hook filters", () => {
    expect(
      buildEventQuery({ branch: "feat/x", hook: "stop", limit: 10 })
    ).toStrictEqual({
      binds: ["feat/x", "stop"],
      limit: 10,
      where: "WHERE git_branch = ? AND hook_event = ?",
    });
  });

  it("builds repo and time filters", () => {
    expect(
      buildEventQuery({
        after_id: 5,
        repo: "org/repo",
        since: 1_700_000_000_000,
        until: 1_700_000_100_000,
      })
    ).toStrictEqual({
      binds: ["org/repo", 1_700_000_000_000, 1_700_000_100_000, 5],
      limit: 5000,
      where:
        "WHERE repo = ? AND received_at >= ? AND received_at <= ? AND id > ?",
    });
  });
});

describe(parsePayloadJson, () => {
  it("returns null for invalid json", () => {
    expect(parsePayloadJson("{")).toBeNull();
  });
});

describe(usageFromRow, () => {
  it("maps nullable columns to usage fields", () => {
    expect(usageFromRow(sampleRow())).toStrictEqual({
      cache_read_tokens: 1,
      cache_write_tokens: 2,
      context_tokens: 3,
      context_usage_percent: 4,
      context_window_size: 5,
      duration_ms: 6,
      input_tokens: 10,
      message_count: 7,
      output_tokens: 20,
    });
  });
});

describe(rowToEvent, () => {
  it("maps a database row into a stored event", () => {
    expect(rowToEvent(sampleRow())).toMatchObject({
      conversation_id: "c1",
      hook_event: "stop",
      payload: { ok: true },
      usage: { input_tokens: 10, output_tokens: 20 },
      workspace_roots: ["/workspace"],
    });
  });
});

describe("D1 store", () => {
  it("inserts and queries events through the D1 adapter", async () => {
    const store = createD1Store(createMemoryD1());

    const inserted = await store.insertEvent({
      conversation_id: "c1",
      cursor_version: null,
      generation_id: "g1",
      git_branch: "feat/x",
      hook_event: "stop",
      model: null,
      model_id: null,
      payload: { ok: true },
      pr_number: 12,
      received_at: 1_700_000_000_000,
      repo: "org/repo",
      status: "completed",
      subagent_id: null,
      subagent_type: null,
      text: "done",
      usage: { input_tokens: 10, output_tokens: 20 },
      user_email: "dev@example.com",
      workspace_roots: ["/workspace"],
    });

    expect(inserted.id).toBe(1);
    const rows = await store.queryEvents({ branch: "feat/x", hook: "stop" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      git_branch: "feat/x",
      hook_event: "stop",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  });

  it("supports direct D1 helpers", async () => {
    const db = createMemoryD1();
    await d1InsertEvent(db, {
      conversation_id: "c2",
      cursor_version: null,
      generation_id: "g2",
      git_branch: "feat/y",
      hook_event: "beforeSubmitPrompt",
      model: null,
      model_id: null,
      payload: {},
      pr_number: null,
      repo: "org/repo",
      status: null,
      subagent_id: null,
      subagent_type: null,
      text: "hello",
      usage: {},
      user_email: null,
      workspace_roots: [],
    });

    const rows = await d1QueryEvents(db, { hook: "beforeSubmitPrompt" });
    expect(rows[0]?.text).toBe("hello");
  });
});

describe("D1 SQL fixture", () => {
  it("matches the migration schema used by insertEvent", () => {
    const sql = readFileSync(
      path.resolve(import.meta.dirname, "../migrations/0001_init.sql"),
      "utf-8"
    );
    expect(sql).toContain("CREATE TABLE events");
    expect(sql).toContain("payload_json TEXT NOT NULL");
  });
});
