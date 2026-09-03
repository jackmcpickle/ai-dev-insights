import { describe, expect, it } from "vitest";

import {
  EXPORT_DEFAULT_LIMIT,
  EXPORT_MAX_LIMIT,
  nextCursor,
  parseEventFilter,
  parseTimestamp,
} from "../src/export";
import type { StoredEvent } from "../src/types";

const event = (id: number): StoredEvent => ({
  conversation_id: null,
  cursor_version: null,
  generation_id: null,
  git_branch: null,
  hook_event: "stop",
  id,
  model: null,
  model_id: null,
  payload: {},
  pr_number: null,
  received_at: id * 1000,
  repo: null,
  status: null,
  subagent_id: null,
  subagent_type: null,
  text: null,
  usage: {},
  user_email: null,
  workspace_roots: [],
});

describe(parseTimestamp, () => {
  it("accepts epoch milliseconds and ISO strings", () => {
    expect(parseTimestamp("1700000300000")).toBe(1_700_000_300_000);
    expect(parseTimestamp("2023-11-14T22:13:20.000Z")).toBe(
      Date.parse("2023-11-14T22:13:20.000Z")
    );
  });

  it("returns undefined for empty or invalid values", () => {
    expect(parseTimestamp(null)).toBeUndefined();
    expect(parseTimestamp("")).toBeUndefined();
    expect(parseTimestamp("not-a-date")).toBeUndefined();
  });
});

describe(parseEventFilter, () => {
  it("maps query params into an EventFilter", () => {
    const url = new URL(
      "https://x.test/v1/events?branch=feat/x&pr=12&repo=org/repo&hook=stop&conversation_id=c1&user=dev@example.com&since=1700000300000&until=2023-11-15&after_id=5&limit=999"
    );
    expect(parseEventFilter(url)).toStrictEqual({
      after_id: 5,
      branch: "feat/x",
      conversation_id: "c1",
      hook: "stop",
      limit: EXPORT_MAX_LIMIT,
      pr: 12,
      repo: "org/repo",
      since: 1_700_000_300_000,
      until: Date.parse("2023-11-15"),
      user: "dev@example.com",
    });
  });

  it("accepts hook_event alias and ignores invalid numbers", () => {
    const url = new URL(
      "https://x.test/v1/events?hook_event=beforeSubmitPrompt&pr=0&after_id=-1&limit=0"
    );
    expect(parseEventFilter(url)).toStrictEqual({
      hook: "beforeSubmitPrompt",
    });
  });

  it("defaults limit when omitted", () => {
    expect(parseEventFilter(new URL("https://x.test/v1/events"))).toStrictEqual(
      {}
    );
    expect(
      parseEventFilter(new URL("https://x.test/v1/events?limit=50")).limit
    ).toBe(50);
    expect(EXPORT_DEFAULT_LIMIT).toBe(100);
  });
});

describe(nextCursor, () => {
  it("returns the last id when the page is full", () => {
    expect(nextCursor([event(1), event(2), event(3)], 3)).toBe(3);
  });

  it("returns null for empty or partial pages", () => {
    expect(nextCursor([], 10)).toBeNull();
    expect(nextCursor([event(1), event(2)], 3)).toBeNull();
  });
});
