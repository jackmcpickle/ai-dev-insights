import { buildDigest } from "./digest";
import { extractSkillMentions, looksLikeCorrection } from "./mentions";
import type { InsightsFinding, InsightsReport, StoredEvent } from "./types";

const conversationEvents = (
  events: StoredEvent[],
  conversationId: string | null
): StoredEvent[] =>
  events.filter((event) => event.conversation_id === conversationId);

const missingSkillTriggers = (events: StoredEvent[]): InsightsFinding[] => {
  const findings: InsightsFinding[] = [];
  const byConv = new Map<string, StoredEvent[]>();
  for (const event of events) {
    if (!event.conversation_id) {
      continue;
    }
    const list = byConv.get(event.conversation_id) ?? [];
    list.push(event);
    byConv.set(event.conversation_id, list);
  }

  for (const [id, group] of byConv) {
    const prompts = group
      .filter((event) => event.hook_event === "beforeSubmitPrompt")
      .toSorted((a, b) => a.id - b.id);
    if (prompts.length < 2) {
      continue;
    }
    for (let i = 1; i < prompts.length; i += 1) {
      const later = prompts[i];
      if (!looksLikeCorrection(later.text)) {
        continue;
      }
      const mentioned = extractSkillMentions(later.text);
      if (mentioned.length === 0) {
        continue;
      }
      const earlierText = prompts
        .slice(0, i)
        .map((event) => event.text ?? "")
        .join("\n");
      const earlierSkills = new Set(extractSkillMentions(earlierText));
      const missing = mentioned.filter((name) => !earlierSkills.has(name));
      if (missing.length === 0) {
        continue;
      }
      findings.push({
        evidence_ids: [prompts[0].id, later.id],
        reason: `Conversation ${id} corrected the agent toward ${missing.join(", ")} after the first prompt did not mention that skill.`,
        title: `Tune or add ${missing.join(", ")}`,
      });
    }
  }
  return findings;
};

export const runInsightsPass = (events: StoredEvent[]): InsightsReport => {
  const digest = buildDigest(events);
  const proposed_skills: InsightsFinding[] = [...missingSkillTriggers(events)];

  for (const recipe of digest.recipes) {
    proposed_skills.push({
      evidence_ids: events
        .filter(
          (event) =>
            event.hook_event === "beforeSubmitPrompt" &&
            (event.text ?? "")
              .toLowerCase()
              .replaceAll(/\s+/gu, " ")
              .includes(recipe.prefix)
        )
        .map((event) => event.id)
        .slice(0, 8),
      reason: `Prompt prefix "${recipe.prefix}" appeared ${recipe.count} times. If this is a team workflow, put it in an existing skill instead of pasting it.`,
      title: "Capture a repeated recipe",
    });
  }

  const hotspots: InsightsFinding[] = [];
  for (const pr of digest.high_token_prs.slice(0, 5)) {
    const label =
      pr.pr_number === null || pr.pr_number === undefined
        ? (pr.git_branch ?? "unknown branch")
        : `PR #${pr.pr_number}`;
    hotspots.push({
      evidence_ids: events
        .filter(
          (event) =>
            (pr.pr_number !== null &&
              pr.pr_number !== undefined &&
              event.pr_number === pr.pr_number) ||
            (pr.git_branch !== null &&
              pr.git_branch !== undefined &&
              event.git_branch === pr.git_branch)
        )
        .map((event) => event.id)
        .slice(0, 8),
      reason: `${label} has ${pr.input_tokens ?? 0} turn input tokens across ${pr.stop_count} stop events. Look at the files that conversation touched before changing skills.`,
      title: `${label} burned context`,
    });
  }

  for (const failure of digest.failures) {
    const failed = conversationEvents(events, failure.conversation_id).filter(
      (event) =>
        (event.hook_event === "stop" || event.hook_event === "subagentStop") &&
        (event.status === "error" || event.status === "aborted")
    );
    hotspots.push({
      evidence_ids: failed.map((event) => event.id),
      reason: `${failure.error_count} error/aborted stops. Inspect the code path in that conversation before writing a new skill.`,
      title: `Failed run in ${failure.conversation_id}`,
    });
  }

  const do_not_change: InsightsFinding[] = [
    {
      evidence_ids: [],
      reason:
        "Hooks omit usage on many events. Treat missing token fields as unknown, not zero, and do not treat context_tokens as spend.",
      title: "Do not invent billed tokens",
    },
    {
      evidence_ids: [],
      reason:
        "Same as reflect: propose edits, wait for a human. Skill text changes every future agent.",
      title: "Do not auto-apply skill edits",
    },
    {
      evidence_ids: [],
      reason:
        "Observe hooks must keep printing {} and exiting 0. Do not add failClosed or block the agent from this pass.",
      title: "Leave fail-open hooks alone",
    },
  ];

  for (const row of digest.conversations) {
    if (
      row.prompt_count <= 1 &&
      row.error_count === 0 &&
      row.stop_count <= 1 &&
      digest.corrections.every(
        (item) => item.conversation_id !== row.conversation_id
      )
    ) {
      do_not_change.push({
        evidence_ids: events
          .filter((event) => event.conversation_id === row.conversation_id)
          .map((event) => event.id)
          .slice(0, 4),
        reason: "Single completed turn with no correction. Not a team pattern.",
        title: `One-off ${row.conversation_id}`,
      });
    }
  }

  return { do_not_change, hotspots, proposed_skills };
};
