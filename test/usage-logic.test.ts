import { describe, expect, it } from "vitest";

import type { StoredEvent } from "../src/types";
import { matchesFilter, selectTurnUsage, summarizeEvents } from "../src/usage";

const base = (
  overrides: Partial<StoredEvent> & Pick<StoredEvent, "hook_event">
): StoredEvent => ({
  conversation_id: "c1",
  cursor_version: null,
  generation_id: "g1",
  git_branch: "feat/x",
  hook_event: overrides.hook_event,
  id: overrides.id ?? 1,
  model: null,
  model_id: null,
  payload: {},
  pr_number: 12,
  received_at: overrides.received_at ?? 1_700_000_000_000,
  repo: "org/repo",
  status: null,
  subagent_id: null,
  subagent_type: null,
  text: null,
  usage: overrides.usage ?? {},
  user_email: "dev@example.com",
  workspace_roots: [],
  ...overrides,
});

describe(selectTurnUsage, () => {
  it("prefers stop over afterAgentResponse for the same generation", () => {
    const stop = base({
      hook_event: "stop",
      id: 2,
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    const response = base({
      hook_event: "afterAgentResponse",
      id: 1,
      usage: { input_tokens: 999, output_tokens: 99 },
    });

    expect(selectTurnUsage([response, stop])).toStrictEqual([stop]);
  });

  it("keeps afterAgentResponse when stop has no token fields", () => {
    const stop = base({ hook_event: "stop", id: 2, status: "completed" });
    const response = base({
      hook_event: "afterAgentResponse",
      id: 1,
      usage: { input_tokens: 50 },
    });

    expect(selectTurnUsage([response, stop])).toStrictEqual([response]);
  });

  it("groups rows by generation_id and ignores unrelated hooks", () => {
    const genAStop = base({
      generation_id: "a",
      hook_event: "stop",
      id: 1,
      usage: { input_tokens: 1 },
    });
    const genBStop = base({
      generation_id: "b",
      hook_event: "stop",
      id: 2,
      usage: { input_tokens: 2 },
    });
    const prompt = base({
      generation_id: "a",
      hook_event: "beforeSubmitPrompt",
      id: 3,
    });

    expect(selectTurnUsage([genAStop, genBStop, prompt])).toStrictEqual([
      genAStop,
      genBStop,
    ]);
  });
});

describe(matchesFilter, () => {
  it("matches branch OR pr when both are provided", () => {
    const branchOnly = base({
      git_branch: "feat/x",
      hook_event: "stop",
      pr_number: null,
    });
    const prOnly = base({
      git_branch: "other",
      hook_event: "stop",
      pr_number: 12,
    });

    const filter = { branch: "feat/x", pr: 12 };
    expect(matchesFilter(branchOnly, filter)).toBeTruthy();
    expect(matchesFilter(prOnly, filter)).toBeTruthy();
    expect(
      matchesFilter(
        base({ git_branch: "other", hook_event: "stop", pr_number: 99 }),
        filter
      )
    ).toBeFalsy();
  });

  it("matches branch-only and pr-only filters", () => {
    const row = base({
      git_branch: "feat/x",
      hook_event: "stop",
      pr_number: 12,
    });
    expect(matchesFilter(row, { branch: "feat/x" })).toBeTruthy();
    expect(matchesFilter(row, { branch: "other" })).toBeFalsy();
    expect(matchesFilter(row, { pr: 12 })).toBeTruthy();
    expect(matchesFilter(row, { pr: 99 })).toBeFalsy();
  });

  it("matches user, repo, hook, and conversation filters", () => {
    const row = base({
      conversation_id: "conv-1",
      hook_event: "stop",
      repo: "org/repo",
      user_email: "dev@example.com",
    });
    expect(
      matchesFilter(row, {
        conversation_id: "conv-1",
        hook: "stop",
        repo: "org/repo",
        user: "dev@example.com",
      })
    ).toBeTruthy();
    expect(matchesFilter(row, { user: "other@example.com" })).toBeFalsy();
    expect(matchesFilter(row, { repo: "other/repo" })).toBeFalsy();
    expect(matchesFilter(row, { hook: "beforeSubmitPrompt" })).toBeFalsy();
    expect(matchesFilter(row, { conversation_id: "conv-2" })).toBeFalsy();
  });

  it("applies time and cursor bounds", () => {
    const row = base({
      hook_event: "stop",
      id: 10,
      received_at: 1_700_000_000_000,
    });
    expect(
      matchesFilter(row, {
        after_id: 9,
        since: 1_699_999_999_000,
        until: 1_700_000_001_000,
      })
    ).toBeTruthy();
    expect(matchesFilter(row, { after_id: 10 })).toBeFalsy();
    expect(matchesFilter(row, { until: 1_699_999_999_000 })).toBeFalsy();
  });
});

describe("summarizeEvents grouping", () => {
  it("builds separate buckets by user email", () => {
    const alice = base({
      hook_event: "beforeSubmitPrompt",
      id: 1,
      user_email: "a@x.test",
    });
    const bob = base({
      hook_event: "beforeSubmitPrompt",
      id: 2,
      user_email: "b@x.test",
    });
    const report = summarizeEvents([alice, bob]);

    expect(report.by_user).toHaveLength(2);
    expect(
      report.by_user.map((row) => row.user_email).toSorted()
    ).toStrictEqual(["a@x.test", "b@x.test"]);
  });
});
