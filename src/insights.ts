import { buildDigest } from "./digest";
import { extractSkillMentions, looksLikeCorrection } from "./mentions";
import type {
  ConversationDigest,
  CorpusDigest,
  InsightsFinding,
  InsightsReport,
  StoredEvent,
} from "./types";

const conversationEvents = (
  events: StoredEvent[],
  conversationId: string | null
): StoredEvent[] =>
  events.filter((event) => event.conversation_id === conversationId);

const correctionFinding = (
  conversationId: string,
  prompts: StoredEvent[],
  later: StoredEvent,
  missing: string[]
): InsightsFinding => ({
  evidence_ids: [prompts[0].id, later.id],
  reason: `Conversation ${conversationId} corrected the agent toward ${missing.join(", ")} after the first prompt did not mention that skill.`,
  title: `Tune or add ${missing.join(", ")}`,
});

const missingFromCorrection = (
  prompts: StoredEvent[],
  index: number,
  later: StoredEvent
): string[] => {
  const mentioned = extractSkillMentions(later.text);
  if (mentioned.length === 0) {
    return [];
  }
  const earlierText = prompts
    .slice(0, index)
    .map((event) => event.text ?? "")
    .join("\n");
  const earlierSkills = new Set(extractSkillMentions(earlierText));
  return mentioned.filter((name) => !earlierSkills.has(name));
};

const findingsForConversation = (
  conversationId: string,
  group: StoredEvent[]
): InsightsFinding[] => {
  const prompts = group
    .filter((event) => event.hook_event === "beforeSubmitPrompt")
    .toSorted((a, b) => a.id - b.id);
  if (prompts.length < 2) {
    return [];
  }

  const findings: InsightsFinding[] = [];
  for (let i = 1; i < prompts.length; i += 1) {
    const later = prompts[i];
    if (!looksLikeCorrection(later.text)) {
      continue;
    }
    const missing = missingFromCorrection(prompts, i, later);
    if (missing.length === 0) {
      continue;
    }
    findings.push(correctionFinding(conversationId, prompts, later, missing));
  }
  return findings;
};

const missingSkillTriggers = (events: StoredEvent[]): InsightsFinding[] => {
  const byConv = new Map<string, StoredEvent[]>();
  for (const event of events) {
    if (!event.conversation_id) {
      continue;
    }
    const list = byConv.get(event.conversation_id) ?? [];
    list.push(event);
    byConv.set(event.conversation_id, list);
  }

  return [...byConv.entries()].flatMap(([id, group]) =>
    findingsForConversation(id, group)
  );
};

const recipeSkillFindings = (
  events: StoredEvent[],
  recipes: CorpusDigest["recipes"]
): InsightsFinding[] =>
  recipes.map((recipe) => ({
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
  }));

const prLabel = (pr: CorpusDigest["high_token_prs"][number]): string =>
  pr.pr_number === null || pr.pr_number === undefined
    ? (pr.git_branch ?? "unknown branch")
    : `PR #${pr.pr_number}`;

const matchesHighTokenPr = (
  event: StoredEvent,
  pr: CorpusDigest["high_token_prs"][number]
): boolean =>
  (pr.pr_number !== null &&
    pr.pr_number !== undefined &&
    event.pr_number === pr.pr_number) ||
  (pr.git_branch !== null &&
    pr.git_branch !== undefined &&
    event.git_branch === pr.git_branch);

const highTokenHotspots = (
  events: StoredEvent[],
  highTokenPrs: CorpusDigest["high_token_prs"]
): InsightsFinding[] =>
  highTokenPrs.slice(0, 5).map((pr) => {
    const label = prLabel(pr);
    return {
      evidence_ids: events
        .filter((event) => matchesHighTokenPr(event, pr))
        .map((event) => event.id)
        .slice(0, 8),
      reason: `${label} has ${pr.input_tokens ?? 0} turn input tokens across ${pr.stop_count} stop events. Look at the files that conversation touched before changing skills.`,
      title: `${label} burned context`,
    };
  });

const failureHotspots = (
  events: StoredEvent[],
  failures: ConversationDigest[]
): InsightsFinding[] =>
  failures.map((failure) => {
    const failed = conversationEvents(events, failure.conversation_id).filter(
      (event) =>
        (event.hook_event === "stop" || event.hook_event === "subagentStop") &&
        (event.status === "error" || event.status === "aborted")
    );
    return {
      evidence_ids: failed.map((event) => event.id),
      reason: `${failure.error_count} error/aborted stops. Inspect the code path in that conversation before writing a new skill.`,
      title: `Failed run in ${failure.conversation_id}`,
    };
  });

const staticDoNotChange = (): InsightsFinding[] => [
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

const isOneOffConversation = (
  row: ConversationDigest,
  digest: CorpusDigest
): boolean =>
  row.prompt_count <= 1 &&
  row.error_count === 0 &&
  row.stop_count <= 1 &&
  digest.corrections.every(
    (item) => item.conversation_id !== row.conversation_id
  );

const oneOffDoNotChange = (
  events: StoredEvent[],
  digest: CorpusDigest
): InsightsFinding[] =>
  digest.conversations
    .filter((row) => isOneOffConversation(row, digest))
    .map((row) => ({
      evidence_ids: events
        .filter((event) => event.conversation_id === row.conversation_id)
        .map((event) => event.id)
        .slice(0, 4),
      reason: "Single completed turn with no correction. Not a team pattern.",
      title: `One-off ${row.conversation_id}`,
    }));

export const runInsightsPass = (events: StoredEvent[]): InsightsReport => {
  const digest = buildDigest(events);
  const proposed_skills = [
    ...missingSkillTriggers(events),
    ...recipeSkillFindings(events, digest.recipes),
  ];
  const hotspots = [
    ...highTokenHotspots(events, digest.high_token_prs),
    ...failureHotspots(events, digest.failures),
  ];
  const do_not_change = [
    ...staticDoNotChange(),
    ...oneOffDoNotChange(events, digest),
  ];

  return { do_not_change, hotspots, proposed_skills };
};
